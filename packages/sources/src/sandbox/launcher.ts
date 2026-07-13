/**
 * `runInSandbox` — the public sandbox entrypoint (Task 2.3, D15).
 *
 * It spawns the dedicated low-privilege parser worker under the host backend's
 * confinement, and returns a readable stream + a digest-bound scan attestation — NEVER
 * a directory path (`sandbox-contract.md §4`). The worker runs the secret scanner
 * INSIDE the sandbox over its normalized output and releases the CLEAN bytes on a pipe;
 * this launcher recomputes the SHA-256 over the bytes it receives and refuses to expose
 * them unless it matches `attestation.outputDigest`, so unscanned or tampered bytes can
 * never be attested clean.
 *
 * Fail-closed: if `probeSandbox()` reports the host unsupported (any required guarantee
 * unavailable) this throws {@link SandboxUnsupportedError} and nothing is parsed.
 *
 * {@link spawnSandboxed} is the lower-level primitive (also used by the adversarial
 * containment tests to run probe modules under the exact same jail) — it runs an
 * arbitrary module confined and returns its raw stdout/stderr/control output.
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SandboxLimits, ScanAttestation, WorkerResult } from "../types.js";
import { DEFAULT_SANDBOX_LIMITS, SANDBOX_LIMIT_CEILINGS } from "../types.js";
import type { SourceFormat } from "../formats.js";
import { selectBackend } from "./probes.js";
import { probeSandbox } from "./probes.js";
import { CONTROL_FD, OUTPUT_FD, parseWorkerControl, type WorkerRequest } from "./protocol.js";

/**
 * The COMPILED worker module (`<pkg>/dist/worker/main.js`). The worker is spawned as a
 * real JS process, so it must be the built artifact even when this launcher module is
 * itself loaded from `src/` under vitest — hence we resolve it from the package root
 * (the dir with `package.json`), never relative to `import.meta.url`'s `src`/`dist`.
 */
function defaultWorkerModule(): string {
  return join(packageRoot(), "dist", "worker", "main.js");
}

/** Directory of THIS module. */
function fileDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

/** Walk up from this module to the `@atlas/sources` package root (dir with package.json). */
function packageRoot(): string {
  let dir = fileDir();
  for (;;) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return fileDir(); // fallback: give up gracefully
    dir = parent;
  }
}

/** Thrown when the host cannot provide a required sandbox guarantee (fail closed). */
export class SandboxUnsupportedError extends Error {
  readonly exitCode = 2 as const; // config/host problem (plan §2.5 exit 2)
  constructor(host: string, missing: string[]) {
    super(`sandbox unsupported on host ${host}: missing ${missing.join(", ") || "backend"}`);
    this.name = "SandboxUnsupportedError";
  }
}

/** Thrown when a worker breaches a resource cap and is force-terminated. */
export class SandboxCapExceededError extends Error {
  readonly exitCode = 4 as const;
  constructor(reason: "wall-clock" | "output-bytes" | "channel-bytes" | "memory") {
    super(`sandbox worker force-terminated: ${reason} cap exceeded`);
    this.name = "SandboxCapExceededError";
  }
}

/** Thrown when the worker crashed or emitted an internal error / no control message. */
export class SandboxWorkerError extends Error {
  readonly exitCode = 4 as const;
  constructor(message: string) {
    super(`sandbox worker failed: ${message}`);
    this.name = "SandboxWorkerError";
  }
}

/** Thrown when the received bytes do not match the worker's attestation digest. */
export class SandboxAttestationError extends Error {
  readonly exitCode = 3 as const; // treat a digest mismatch as a scan failure (bytes discarded)
  constructor(detail: string) {
    super(`sandbox attestation mismatch (bytes discarded): ${detail}`);
    this.name = "SandboxAttestationError";
  }
}

/**
 * Hard byte ceilings on the two auxiliary channels the trusted parent accumulates in
 * memory (wing round-3 finding 5). A compromised worker must not be able to bypass
 * `maxOutputBytes` — or simply exhaust the trusted process — by flooding stderr or the
 * fd3 control channel. Both are bounded, small (a diagnostics line + a single JSON
 * control message never approach these), and overflow is a KILL, never a silent
 * truncation. They are separate from `maxOutputBytes` (the fd1 payload cap).
 */
export const CONTROL_BYTE_CAP = 4 * 1024 * 1024; // 4 MiB — one JSON control message is < 1 KiB
export const STDERR_BYTE_CAP = 4 * 1024 * 1024; // 4 MiB — diagnostics only

/** Raw outcome of a confined run (interpretation is the caller's). */
export interface RawSandboxRun {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdoutBytes: Uint8Array;
  readonly stderr: string;
  /** The single control-message string the module wrote to {@link CONTROL_FD} (may be empty). */
  readonly control: string;
  readonly timedOut: boolean;
  readonly oversize: boolean;
  /** The RSS watchdog force-killed the child for exceeding `limits.maxAddressSpaceBytes`. */
  readonly memExceeded: boolean;
  /** The worker flooded stderr or the fd3 control channel past its cap and was killed. */
  readonly channelOverflow: boolean;
}

/** Options for {@link spawnSandboxed}. */
export interface SpawnSandboxedOpts {
  /** Absolute path of the JS module the confined child runs. */
  readonly modulePath: string;
  /** The request handed to the module as argv JSON (its `workTmp` must be writable). */
  readonly request: WorkerRequest;
  readonly limits: SandboxLimits;
  /** Extra directories to DENY data reads (vault + test out-of-scope roots). */
  readonly denyReadRoots?: readonly string[];
  /** Override the JS import-closure read roots (defaults to the detected repo root). */
  readonly codeRoots?: readonly string[];
}

/** Walk up from `start` to the monorepo root (dir with `pnpm-workspace.yaml`, else `node_modules`). */
export function detectCodeRoot(start: string): string {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback: nearest ancestor containing node_modules.
  dir = start;
  for (;;) {
    if (existsSync(join(dir, "node_modules"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

/**
 * The PRECISE read closure for the confined worker (wing round-3 finding 4: the prior
 * closure exposed EVERY workspace package + the whole root `node_modules`, so an
 * untrusted parser could read unrelated package sources / test fixtures / the pnpm
 * store). The compiled worker's *runtime* import graph is exactly:
 *   - `<repo>/packages/sources`  — the worker module + its `../formats.js` /
 *     `../sandbox/protocol.js` siblings, and the `node_modules/@atlas/*` symlink dir it
 *     resolves `@atlas/scan` through;
 *   - `<repo>/packages/scan`     — the sole runtime dependency (`scanBytes` + its own
 *     files); `@atlas/contracts`/`zod` are TYPE-ONLY (erased at compile) and never
 *     loaded, so neither `packages/contracts` nor the root `node_modules`/pnpm store is
 *     in the closure and both stay UNREADABLE in the jail.
 * Nothing else under `<repo>` is included — not the repo root, not sibling packages, not
 * a vault/`.private`/`.git`/keys. A caller may override via
 * {@link SpawnSandboxedOpts.codeRoots} (e.g. a test running an isolated probe module).
 *
 * NB kept in sync with the worker's runtime `import` graph: if the worker ever loads a
 * new `@atlas/*` package at runtime, add its dir here (the fail-closed cost of omission
 * is a boot failure the positive-control test catches, never a silent over-exposure).
 */
export function importClosureRoots(moduleDir: string): string[] {
  const repo = detectCodeRoot(moduleDir);
  return [join(repo, "packages", "sources"), join(repo, "packages", "scan")].filter((d) => existsSync(d));
}

/**
 * Validate + clamp a caller's cap overrides. The API contract (and wing round-3
 * finding 6) is that an override may only ever *tighten* a cap — never raise or disable
 * one. So each override is clamped to the DEFAULT for that field (the hard cap), not to
 * the higher {@link SANDBOX_LIMIT_CEILINGS} absolute bound: a caller (Task 2.4) can pick
 * a smaller value, but any value ≥ the default collapses to the default. A non-finite /
 * non-positive / non-integer value (undefined / NaN / Infinity / ≤0 / a fraction that
 * floors to 0) also falls back to the default — a bad value can never disable a cap.
 *
 * {@link SANDBOX_LIMIT_CEILINGS} remains the absolute upper bound the defaults
 * themselves are asserted against (defence in depth), but it is NOT a raise target for
 * overrides.
 */
export function resolveLimits(overrides?: Partial<SandboxLimits>): SandboxLimits {
  const keys = Object.keys(DEFAULT_SANDBOX_LIMITS) as (keyof SandboxLimits)[];
  const out = {} as { -readonly [K in keyof SandboxLimits]: number };
  for (const k of keys) {
    // The default is the hard cap AND the ceiling for any override (never raise it).
    const cap = Math.min(DEFAULT_SANDBOX_LIMITS[k], SANDBOX_LIMIT_CEILINGS[k]);
    const raw = overrides?.[k];
    // Only a finite override that floors to a positive integer (≥ 1) is acceptable;
    // anything else falls back to the cap — a bad value can never disable a cap.
    const floored = typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : Number.NaN;
    const candidate = Number.isFinite(floored) && floored >= 1 ? floored : cap;
    // An override may only LOWER the cap: clamp to the default (never above it).
    out[k] = Math.min(candidate, cap);
  }
  return out;
}

/**
 * Run `opts.modulePath` under the host backend's confinement and resolve its raw io.
 * The child is spawned with an EMPTY environment and an explicit stdio layout:
 *   fd0 = ignore, fd1 = output pipe, fd2 = diagnostics, fd3 = control pipe,
 *   plus any backend {@link ExtraChildFd}s (Linux seccomp blob) at their fixed numbers.
 * No other parent fd is inherited (they are close-on-exec) — the `no-inherited-fds`
 * guarantee. A wall-clock watchdog force-kills the child past `limits.wallClockMs`;
 * `limits.maxOutputBytes` caps fd1 (exceeding it is a kill, never a truncated success).
 */
export function spawnSandboxed(opts: SpawnSandboxedOpts): Promise<RawSandboxRun> {
  const backend = selectBackend();
  if (backend === null) {
    return Promise.reject(new SandboxUnsupportedError(process.platform + "-" + process.arch, []));
  }
  // Ensure the worker-private temp exists (its cleanup is the caller's — runInSandbox
  // owns the temp it creates; tests own theirs).
  mkdirSync(opts.request.workTmp, { recursive: true });

  const codeRoots = opts.codeRoots ?? importClosureRoots(dirname(opts.modulePath));
  const plan = backend.buildSpawn({
    nodePath: process.execPath,
    workerModule: opts.modulePath,
    request: opts.request,
    limits: opts.limits,
    codeRoots,
    denyReadRoots: opts.denyReadRoots ?? [],
  });

  // Open any extra fds the backend needs wired (Linux seccomp blob → fd 10).
  const openedFds: number[] = [];
  const stdio: Array<"ignore" | "pipe" | number> = ["ignore", "pipe", "pipe", "pipe"];
  for (const ef of plan.extraFds ?? []) {
    const fd = openSync(ef.path, "r");
    openedFds.push(fd);
    while (stdio.length < ef.childFd) stdio.push("ignore");
    stdio[ef.childFd] = fd;
  }

  return new Promise<RawSandboxRun>((resolve, reject) => {
    let settled = false;
    const stdoutChunks: Uint8Array[] = [];
    let stdoutLen = 0; // cumulative bytes SEEN on fd1 (the cap counter)
    let stdoutStored = 0; // bytes actually retained in `stdoutChunks`
    let oversize = false;
    let timedOut = false;
    let memExceeded = false;
    let channelOverflow = false;
    const stderrChunks: string[] = [];
    let stderrLen = 0;
    const controlChunks: string[] = [];
    let controlLen = 0;

    const child = spawn(plan.command, plan.args, { env: {}, stdio });

    const watchdog = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.limits.wallClockMs);
    watchdog.unref?.();

    // RSS memory watchdog. On Linux RLIMIT_AS (prlimit) is the primary enforced memory
    // cap; on macOS the kernel does NOT enforce RLIMIT_AS, so this launcher-side RSS
    // poll IS the memory cap there (analogous to the wall-clock + output watchdogs).
    // It polls the child's resident set via `ps` and force-kills on breach. On Linux
    // the child pid is the bwrap monitor (node runs in its pid namespace), so the poll
    // rarely fires — RLIMIT_AS already killed the parser — which is fine (belt & braces).
    const rssPoll = setInterval(() => {
      if (child.pid === undefined) return;
      try {
        const kb = Number.parseInt(execFileSync("ps", ["-o", "rss=", "-p", String(child.pid)], { encoding: "utf8" }).trim(), 10);
        if (Number.isFinite(kb) && kb * 1024 > opts.limits.maxAddressSpaceBytes) {
          memExceeded = true;
          child.kill("SIGKILL");
        }
      } catch {
        /* child gone / ps unavailable — nothing to enforce */
      }
    }, 120);
    rssPoll.unref?.();

    const out = child.stdio[OUTPUT_FD];
    out?.on("data", (chunk: Uint8Array) => {
      stdoutLen += chunk.length;
      if (stdoutLen > opts.limits.maxOutputBytes) {
        oversize = true;
        child.kill("SIGKILL");
        return;
      }
      stdoutChunks.push(chunk);
      stdoutStored += chunk.length;
    });
    // stderr + the fd3 control channel are capped independently of the fd1 payload
    // (wing round-3 finding 5): a flood on either is a KILL, never unbounded growth in
    // the trusted parent. On overflow we stop accumulating, flag it, and SIGKILL.
    child.stderr?.on("data", (c: Buffer) => {
      stderrLen += c.length;
      if (stderrLen > STDERR_BYTE_CAP) {
        if (!channelOverflow) {
          channelOverflow = true;
          child.kill("SIGKILL");
        }
        return;
      }
      stderrChunks.push(c.toString("utf8"));
    });
    const control = child.stdio[CONTROL_FD];
    control?.on("data", (c: Buffer) => {
      controlLen += c.length;
      if (controlLen > CONTROL_BYTE_CAP) {
        if (!channelOverflow) {
          channelOverflow = true;
          child.kill("SIGKILL");
        }
        return;
      }
      controlChunks.push(c.toString("utf8"));
    });

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      clearInterval(rssPoll);
      for (const fd of openedFds) {
        try {
          closeSync(fd);
        } catch {
          /* already closed by spawn inheritance */
        }
      }
      try {
        plan.cleanup();
      } catch {
        /* best-effort scratch cleanup */
      }
      fn();
    };

    child.on("error", (err) => finish(() => reject(new SandboxWorkerError(err.message))));
    child.on("close", (code, signal) => {
      finish(() =>
        resolve({
          code,
          signal,
          stdoutBytes: concat(stdoutChunks, stdoutStored),
          stderr: stderrChunks.join(""),
          control: controlChunks.join(""),
          timedOut,
          oversize,
          memExceeded,
          channelOverflow,
        }),
      );
    });
  });
}

/** Concatenate collected chunks into one buffer of known length. */
function concat(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/** `sha256:<hex>` over `bytes` — the attestation binding the consumer re-verifies. */
export function sha256Hex(bytes: Uint8Array): string {
  return "sha256:" + createHash("sha256").update(bytes).digest("hex");
}

/** Public request for {@link runInSandbox}. */
export interface RunInSandboxRequest {
  readonly inputPath: string;
  readonly format: SourceFormat;
  /** Optional cap overrides (defaults to {@link DEFAULT_SANDBOX_LIMITS}). */
  readonly limits?: Partial<SandboxLimits>;
  /**
   * Directories to additionally deny data reads inside the jail (the configured vault
   * root belongs here so the untrusted parser cannot read sibling notes).
   */
  readonly denyReadRoots?: readonly string[];
}

/** Internal knobs (test-only). Not part of the public contract. */
export interface RunInSandboxInternal {
  /** Override the worker module (tests use a hanging/flooding probe to exercise caps). */
  readonly workerModule?: string;
}

/**
 * Launch the parser worker on `req.inputPath` inside the sandbox and return a
 * {@link WorkerResult}: a clean digest-bound stream + attestation, a distinct exit-3
 * scan rejection, or a typed normalization rejection. NEVER a directory path (D15).
 */
export async function runInSandbox(req: RunInSandboxRequest, internal?: RunInSandboxInternal): Promise<WorkerResult> {
  const report = await probeSandbox();
  if (!report.supported) {
    const missing = report.checks.filter((c) => !c.available).map((c) => c.guarantee);
    throw new SandboxUnsupportedError(report.host, missing);
  }

  // Validate + clamp any caller override (never raise or disable a hard cap).
  const limits: SandboxLimits = resolveLimits(req.limits);
  // Disposable, worker-private temp — created here, removed in the finally (so it is
  // cleaned even after a forced termination).
  const workTmp = mkdtempSync(join(tmpdir(), "atlas-worker-"));
  try {
    const raw = await spawnSandboxed({
      modulePath: internal?.workerModule ?? defaultWorkerModule(),
      request: { inputPath: req.inputPath, format: req.format, workTmp, maxOutputBytes: limits.maxOutputBytes },
      limits,
      denyReadRoots: req.denyReadRoots ?? [],
    });

    if (raw.timedOut) throw new SandboxCapExceededError("wall-clock");
    if (raw.oversize) throw new SandboxCapExceededError("output-bytes");
    if (raw.channelOverflow) throw new SandboxCapExceededError("channel-bytes");
    if (raw.memExceeded) throw new SandboxCapExceededError("memory");

    if (raw.control.trim() === "") {
      throw new SandboxWorkerError(
        `no control message (exit ${raw.code}, signal ${raw.signal})${raw.stderr ? `: ${raw.stderr.slice(0, 500)}` : ""}`,
      );
    }
    const control = parseWorkerControl(raw.control);

    switch (control.kind) {
      case "worker-error":
        throw new SandboxWorkerError(control.message);
      case "scan-rejection":
        return { ok: false, kind: "scan-rejection", code: "secret-detected", exit: 3, scannerRulesetVersion: control.scannerRulesetVersion };
      case "normalization-rejection":
        return { ok: false, kind: "normalization-rejection", rejection: control.rejection };
      case "clean": {
        // A "clean" outcome is only trustworthy if the worker also EXITED CLEANLY (wing
        // round-2 finding: a clean message followed by exit 4 / a signal was becoming a
        // success). A non-zero exit or any terminating signal means the process died
        // after emitting the control — the bytes on the pipe may be truncated/partial —
        // so we refuse to expose them.
        if (raw.code !== 0 || raw.signal !== null) {
          throw new SandboxWorkerError(
            `worker reported clean but did not exit cleanly (exit ${raw.code}, signal ${raw.signal}) — output discarded`,
          );
        }
        // D15 output contract: recompute the digest over the RECEIVED bytes and confirm
        // it equals the worker's attestation BEFORE exposing them. A mismatch is a scan
        // failure — the bytes are discarded, never surfaced.
        const att: ScanAttestation = control.attestation;
        const digest = sha256Hex(raw.stdoutBytes);
        if (digest !== att.outputDigest) {
          throw new SandboxAttestationError(`received ${digest}, attested ${att.outputDigest}`);
        }
        if (raw.stdoutBytes.length !== att.scannedBytes) {
          throw new SandboxAttestationError(`received ${raw.stdoutBytes.length} bytes, attested ${att.scannedBytes}`);
        }
        const bytes = raw.stdoutBytes;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        });
        return { ok: true, stream, attestation: att };
      }
    }
  } finally {
    rmSync(workTmp, { recursive: true, force: true });
  }
}
