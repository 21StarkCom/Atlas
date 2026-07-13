/**
 * `sandbox.containment.test` (Task 2.3, adversarial) — proves the parser worker jail
 * upholds every REQUIRED guarantee of `sandbox-contract.md §1` against adversarial
 * probe modules run under the EXACT same confinement as the real worker
 * (`spawnSandboxed`):
 *
 *   - no-network, empty-environment, no-credential-access (keychain), no-inherited-fds,
 *     out-of-scope path read/write, no-subprocess — all fail;
 *   - positive controls (the input handle is readable, the worker temp is writable)
 *     prove the jail is not merely denying everything;
 *   - resource caps enforce: the wall-clock watchdog force-kills a hung worker and the
 *     output-byte ceiling force-kills a flooding worker, and the launcher cleans up the
 *     worker-private temp AFTER the forced termination;
 *   - a Linux-only case asserts the forbidden `socket` syscall is refused by seccomp.
 *
 * The whole suite skips (with a reason) on a host whose `probeSandbox()` is
 * unsupported — that is expected locally (e.g. a Linux host without `bwrap`); CI
 * provisions both OS so it never skips there.
 */
import { describe, expect, it, beforeAll } from "vitest";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, mkdtempSync, openSync, closeSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUDIT_ARCH,
  buildSeccompProgram,
  DEFAULT_SANDBOX_LIMITS,
  evalSeccomp,
  MAX_BYTES,
  detectCodeRoot,
  probeSandbox,
  runInSandbox,
  SandboxCapExceededError,
  spawnSandboxed,
  type SandboxLimits,
} from "../src/index.js";

const CONTAINMENT_PROBE = fileURLToPath(new URL("./probes/containment.cjs", import.meta.url));
const HANG_PROBE = fileURLToPath(new URL("./probes/hang.cjs", import.meta.url));
const FLOOD_PROBE = fileURLToPath(new URL("./probes/flood.cjs", import.meta.url));
const STDERR_FLOOD_PROBE = fileURLToPath(new URL("./probes/stderr-flood.cjs", import.meta.url));
const CONTROL_FLOOD_PROBE = fileURLToPath(new URL("./probes/control-flood.cjs", import.meta.url));
const CPU_PROBE = fileURLToPath(new URL("./probes/cpu.cjs", import.meta.url));
const MEM_PROBE = fileURLToPath(new URL("./probes/mem.cjs", import.meta.url));
const REAL_WORKER = fileURLToPath(new URL("../dist/worker/main.js", import.meta.url));

const LIMITS: SandboxLimits = { ...DEFAULT_SANDBOX_LIMITS, wallClockMs: 25_000 };

/**
 * A CI runner on a supported OS is PROVISIONED — the sandbox MUST be supported there,
 * so an unsupported report is a hard failure, not a silent skip (wing round-2 finding:
 * the suite used to green-skip on CI when unsupported, exercising no containment). Set
 * by CI; also implied on any `CI=true` runner on darwin/linux.
 */
const REQUIRE_SUPPORTED =
  process.env.ATLAS_SANDBOX_REQUIRE === "1" ||
  (process.env.CI === "true" && (platform() === "darwin" || platform() === "linux"));

let supported = false;
let skipReason = "";
beforeAll(async () => {
  const rep = await probeSandbox();
  supported = rep.supported;
  if (!supported) {
    skipReason = `sandbox unsupported on ${rep.host}: ${rep.checks.filter((c) => !c.available).map((c) => c.guarantee).join(", ")}`;
    if (REQUIRE_SUPPORTED) {
      throw new Error(
        `[sandbox.containment] provisioned CI host must support the sandbox but does not — ${skipReason}. ` +
          `Refusing to green-skip the containment suite.`,
      );
    }
  }
});

/** One scratch tree per run: a config file (the probe's input handle) + a worker temp + a sensitive dir. */
interface Scratch {
  base: string;
  configPath: string;
  workTmp: string;
  sensitiveDir: string;
  cleanup(): void;
}

function makeScratch(config: Record<string, unknown>): Scratch {
  const base = mkdtempSync(join(tmpdir(), "atlas-containment-"));
  const configPath = join(base, "probe-config.json");
  const workTmp = join(base, "work");
  const sensitiveDir = join(base, "sensitive");
  // The sensitive dir stands in for the vault / credential store (a denyReadRoot).
  mkdirSync(sensitiveDir, { recursive: true });
  writeFileSync(join(sensitiveDir, "secret.txt"), "TOP-SECRET-VAULT-CONTENT");
  writeFileSync(configPath, JSON.stringify(config));
  return {
    base,
    configPath,
    workTmp,
    sensitiveDir,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

/** Run the containment probe with `config` and return its parsed control report. */
async function runProbe(
  config: Record<string, unknown>,
  denyReadRoots: string[] = [],
  limitsOverride: Partial<SandboxLimits> = {},
): Promise<Record<string, unknown>> {
  const s = makeScratch(config);
  try {
    const raw = await spawnSandboxed({
      modulePath: CONTAINMENT_PROBE,
      request: { inputPath: s.configPath, format: "text", workTmp: s.workTmp, maxOutputBytes: 1 << 20 },
      limits: { ...LIMITS, ...limitsOverride },
      denyReadRoots: [s.sensitiveDir, ...denyReadRoots],
    });
    expect(raw.control.trim(), `probe emitted no control (stderr: ${raw.stderr.slice(0, 400)})`).not.toBe("");
    return JSON.parse(raw.control) as Record<string, unknown>;
  } finally {
    s.cleanup();
  }
}

describe.skipIf(platform() !== "darwin" && platform() !== "linux")("sandbox containment (adversarial)", () => {
  it("host is supported (else skipping the adversarial suite with a reason)", async () => {
    const rep = await probeSandbox();
    if (!rep.supported) {
      console.warn(`[sandbox.containment] SKIP: ${skipReason}`);
    }
    expect(Array.isArray(rep.checks)).toBe(true);
  });

  it("no-network: an outbound connection is refused", async () => {
    if (!supported) return;
    const r = await runProbe({ action: "network" });
    expect(String(r.result)).toMatch(/^blocked:/);
  });

  it("empty-environment: no inherited application vars leak", async () => {
    if (!supported) return;
    // Set a marker in the parent; the confined child must NOT see it (spawn env is {}).
    process.env.ATLAS_CONTAINMENT_MARKER = "leak-me";
    try {
      const r = await runProbe({ action: "env" });
      const env = (r.env as string[]) ?? [];
      expect(env).not.toContain("ATLAS_CONTAINMENT_MARKER");
      expect(env).not.toContain("PATH");
      expect(env).not.toContain("HOME");
      expect(env).not.toContain("ANTHROPIC_API_KEY");
    } finally {
      delete process.env.ATLAS_CONTAINMENT_MARKER;
    }
  });

  it("no-credential-access: a credential/keychain path is unreadable", async () => {
    if (!supported) return;
    // The sensitive dir models the credential/keychain store (a denyReadRoot on both hosts).
    const s = makeScratch({ action: "read-keychain" });
    writeFileSync(s.configPath, JSON.stringify({ action: "read-keychain", target: join(s.sensitiveDir, "secret.txt") }));
    try {
      const raw = await spawnSandboxed({
        modulePath: CONTAINMENT_PROBE,
        request: { inputPath: s.configPath, format: "text", workTmp: s.workTmp, maxOutputBytes: 1 << 20 },
        limits: LIMITS,
        denyReadRoots: [s.sensitiveDir],
      });
      const r = JSON.parse(raw.control) as { result: string };
      expect(r.result, `keychain read must be blocked, got ${r.result}`).toMatch(/^blocked:/);
    } finally {
      s.cleanup();
    }
    // On macOS also assert the REAL system keychain dir is default-denied (not merely a
    // denyReadRoot) — the profile denies /Library/Keychains data reads unconditionally.
    if (platform() === "darwin") {
      const r2 = await runProbe({ action: "read-keychain", target: "/Library/Keychains/System.keychain" });
      expect(String(r2.result)).toMatch(/^blocked:/);
    }
  });

  it("out-of-scope path: reading an out-of-scope secret NOT passed as a denyReadRoot is refused", async () => {
    if (!supported) return;
    // The strongest form of the check (wing round-2 finding): the secret is NOT handed
    // to the jail via denyReadRoots — it must be unreadable purely because it is not in
    // the read allowlist (default-deny). A broad-allow profile would LEAK it here. The
    // secret lives in its own tmp dir (a stand-in for any arbitrary out-of-scope path),
    // and the ONLY thing supplied is the input handle.
    const secretHome = mkdtempSync(join(tmpdir(), "atlas-oos-"));
    const secretFile = join(secretHome, "out-of-scope-secret.txt");
    writeFileSync(secretFile, "ARBITRARY-OUT-OF-SCOPE-SECRET");
    const s = makeScratch({ action: "read-oos", target: secretFile });
    try {
      const raw = await spawnSandboxed({
        modulePath: CONTAINMENT_PROBE,
        request: { inputPath: s.configPath, format: "text", workTmp: s.workTmp, maxOutputBytes: 1 << 20 },
        limits: LIMITS,
        denyReadRoots: [], // <-- deliberately empty: default-deny must contain it
      });
      const r = JSON.parse(raw.control) as { result: string };
      // Require a real access denial (EACCES/EPERM on darwin; ENOENT on linux where the
      // path is simply not mounted) — never a successful read.
      expect(r.result, `out-of-scope read must be denied, got ${r.result}`).toMatch(/^blocked:(EACCES|EPERM|ENOENT)/);
    } finally {
      s.cleanup();
      rmSync(secretHome, { recursive: true, force: true });
    }
  });

  it("out-of-scope path: writing outside the worker temp is refused", async () => {
    if (!supported) return;
    const s = makeScratch({ action: "write-oos" });
    writeFileSync(s.configPath, JSON.stringify({ action: "write-oos", target: s.sensitiveDir }));
    try {
      const raw = await spawnSandboxed({
        modulePath: CONTAINMENT_PROBE,
        request: { inputPath: s.configPath, format: "text", workTmp: s.workTmp, maxOutputBytes: 1 << 20 },
        limits: LIMITS,
        denyReadRoots: [s.sensitiveDir],
      });
      const r = JSON.parse(raw.control) as { result: string };
      expect(r.result).toMatch(/^blocked:/);
    } finally {
      s.cleanup();
    }
  });

  it("no-inherited-fds: parent-held fds are not visible in the worker", async () => {
    if (!supported) return;
    // Open a secret file in the PARENT — its fd must NOT be inherited by the child.
    const secret = mkdtempSync(join(tmpdir(), "atlas-fd-"));
    const secretFile = join(secret, "s");
    writeFileSync(secretFile, "PARENT-FD-SECRET");
    const heldFd = openSync(secretFile, "r");
    try {
      const r = await runProbe({ action: "inherited-fd", fds: [heldFd, 4, 5, 6] });
      const results = (r.result as string[]) ?? [];
      for (const line of results) expect(line).toMatch(/:blocked:/);
      expect(results.join(",")).not.toMatch(/LEAK/);
    } finally {
      closeSync(heldFd);
      rmSync(secret, { recursive: true, force: true });
    }
  });

  it("no-subprocess: spawning a child process — /bin/echo AND node itself — is refused", async () => {
    if (!supported) return;
    const r = await runProbe({ action: "subprocess" });
    // Neither an arbitrary binary NOR a re-spawn of node (process.execPath) may succeed.
    // The node case is the real adversary move: the profile permits exec of the node
    // literal for the bootstrap, so no-subprocess rests on the fork/process-creation
    // denial, which must block a posix_spawn of node too (wing round-2 finding).
    const results = (r.results as string[]) ?? [];
    expect(results.join(","), `subprocess results: ${results.join(",")}`).not.toMatch(/LEAK/);
    for (const line of results) expect(line).toMatch(/:blocked:/);
    expect(String(r.result)).toMatch(/^blocked:/);
  });

  it("positive control: the input handle is readable and the worker temp is writable", async () => {
    if (!supported) return;
    const read = await runProbe({ action: "read-input" });
    expect(read.result).toBe("read");
    const write = await runProbe({ action: "write-tmp" });
    expect(write.result).toBe("wrote");
  });

  it("resource-caps: the wall-clock watchdog force-kills a hung worker and cleans its temp", async () => {
    if (!supported) return;
    const input = mkdtempSync(join(tmpdir(), "atlas-hang-in-"));
    const inputFile = join(input, "in.md");
    writeFileSync(inputFile, "# hang\n");
    const before = countWorkerTemps();
    try {
      await expect(
        runInSandbox({ inputPath: inputFile, format: "markdown", limits: { wallClockMs: 1200 } }, { workerModule: HANG_PROBE }),
      ).rejects.toBeInstanceOf(SandboxCapExceededError);
      // The disposable worker-private temp is removed even after the forced kill.
      expect(countWorkerTemps()).toBeLessThanOrEqual(before);
    } finally {
      rmSync(input, { recursive: true, force: true });
    }
  });

  it("resource-caps: the output-byte ceiling force-kills a flooding worker", async () => {
    if (!supported) return;
    const input = mkdtempSync(join(tmpdir(), "atlas-flood-in-"));
    const inputFile = join(input, "in.md");
    writeFileSync(inputFile, "# flood\n");
    try {
      await expect(
        runInSandbox(
          { inputPath: inputFile, format: "markdown", limits: { maxOutputBytes: 256 * 1024, wallClockMs: 25_000 } },
          { workerModule: FLOOD_PROBE },
        ),
      ).rejects.toBeInstanceOf(SandboxCapExceededError);
    } finally {
      rmSync(input, { recursive: true, force: true });
    }
  });

  it.skipIf(platform() !== "linux")("forbidden-syscall (linux): seccomp refuses the socket syscall with EPERM", async () => {
    if (!supported) return;
    const r = await runProbe({ action: "forbidden-syscall" });
    // The socket() syscall is not in the allowlist ⇒ EPERM (default action). Require the
    // access denial specifically — NOT a timeout / ECONNREFUSED, which would falsely
    // read as "contained" while actually attempting the connection (wing round-2 finding).
    expect(String(r.result), `socket must be EPERM/EACCES, got ${r.result}`).toMatch(/^blocked:(EPERM|EACCES)/);
  });

  it("positive control: the REAL worker boots and parses a clean source under the jail", async () => {
    // This is the Linux seccomp positive control (wing round-2 finding): if the allowlist
    // denied Node's bootstrap exec / a boot syscall, the worker could never run — so a
    // clean parse proves the filter permits the runtime. It is meaningful on every host.
    if (!supported) return;
    if (!existsSync(REAL_WORKER)) {
      expect(REQUIRE_SUPPORTED, `real worker dist missing at ${REAL_WORKER} — build first`).toBe(false);
      return;
    }
    const base = mkdtempSync(join(tmpdir(), "atlas-posctl-"));
    const input = join(base, "clean.md");
    writeFileSync(input, "# Clean\n\nNothing secret here.\n");
    try {
      const res = await runInSandbox({ inputPath: input, format: "markdown", denyReadRoots: [base] });
      expect(res.ok, "the worker must boot + parse a clean source under the jail").toBe(true);
      if (res.ok) expect(res.attestation.clean).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("out-of-scope path: a sibling workspace package / node_modules is NOT in the closure (finding 4)", async () => {
    if (!supported) return;
    // Wing round-3 finding 4: the worker's read closure is now exactly packages/sources
    // + packages/scan. A sibling workspace package (packages/contracts) and the root
    // node_modules pnpm store are NO LONGER mapped — reading them must fail (they were
    // readable under the prior over-broad `<repo>/packages` + `<repo>/node_modules`).
    const repo = detectCodeRoot(fileURLToPath(new URL(".", import.meta.url)));
    const targets = [
      join(repo, "packages", "contracts", "package.json"),
      join(repo, "node_modules", ".modules.yaml"),
    ].filter((t) => existsSync(t));
    expect(targets.length, "expected at least one sibling target to exist to prove the tightening").toBeGreaterThan(0);
    for (const target of targets) {
      const r = await runProbe({ action: "read-oos", target });
      expect(String(r.result), `${target} must be unreadable, got ${r.result}`).toMatch(/^blocked:(EACCES|EPERM|ENOENT)/);
    }
  });

  it("resource-caps: a stderr flood is capped and force-kills the worker (finding 5)", async () => {
    if (!supported) return;
    const s = makeScratch({ action: "noop" });
    try {
      const raw = await spawnSandboxed({
        modulePath: STDERR_FLOOD_PROBE,
        request: { inputPath: s.configPath, format: "text", workTmp: s.workTmp, maxOutputBytes: 1 << 20 },
        limits: { ...LIMITS, wallClockMs: 25_000 },
      });
      expect(raw.channelOverflow, `stderr flood must trip the channel cap: code=${raw.code} signal=${raw.signal}`).toBe(true);
    } finally {
      s.cleanup();
    }
  });

  it("resource-caps: an fd3 control flood is capped and force-kills the worker (finding 5)", async () => {
    if (!supported) return;
    const s = makeScratch({ action: "noop" });
    try {
      const raw = await spawnSandboxed({
        modulePath: CONTROL_FLOOD_PROBE,
        request: { inputPath: s.configPath, format: "text", workTmp: s.workTmp, maxOutputBytes: 1 << 20 },
        limits: { ...LIMITS, wallClockMs: 25_000 },
      });
      expect(raw.channelOverflow, `control flood must trip the channel cap: code=${raw.code} signal=${raw.signal}`).toBe(true);
    } finally {
      s.cleanup();
    }
  });

  it("normalization: a source above the format ceiling is rejected too-large without slurping it (finding 7)", async () => {
    if (!supported || !existsSync(REAL_WORKER)) return;
    const base = mkdtempSync(join(tmpdir(), "atlas-big-"));
    const input = join(base, "big.md");
    // Substantially above the 5 MiB markdown ceiling; all-'A' so it is valid text — the
    // size guard must reject it BEFORE the signature/decode step ever reads it.
    writeFileSync(input, Buffer.alloc(MAX_BYTES.markdown + 1024 * 1024, 0x41));
    try {
      const r = await runInSandbox({ inputPath: input, format: "markdown", denyReadRoots: [base] });
      expect(r.ok).toBe(false);
      if (!r.ok && r.kind === "normalization-rejection") {
        expect(r.rejection.code).toBe("too-large");
      } else {
        throw new Error(`expected too-large normalization-rejection, got ${JSON.stringify(r)}`);
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("normalization: an invalid-encoding text source is rejected unsupported-encoding, not lossy-clean (finding 8)", async () => {
    if (!supported || !existsSync(REAL_WORKER)) return;
    const base = mkdtempSync(join(tmpdir(), "atlas-enc-"));
    const input = join(base, "bad.txt");
    // Lone UTF-8 continuation bytes (no NUL, so it passes the coarse binary gate) — a
    // non-fatal decode would have produced lossy U+FFFD "clean" output; the fatal decode
    // must instead yield unsupported-encoding.
    writeFileSync(input, Buffer.from([0x41, 0x80, 0x81, 0x42]));
    try {
      const r = await runInSandbox({ inputPath: input, format: "text", denyReadRoots: [base] });
      expect(r.ok).toBe(false);
      if (!r.ok && r.kind === "normalization-rejection") {
        expect(r.rejection.code).toBe("unsupported-encoding");
      } else {
        throw new Error(`expected unsupported-encoding normalization-rejection, got ${JSON.stringify(r)}`);
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("resource-caps: RLIMIT_FSIZE refuses an oversized write to the worker temp", async () => {
    if (!supported) return;
    const r = await runProbe({ action: "fsize", bytes: 4 * 1024 * 1024 }, [], { maxFileSizeBytes: 64 * 1024 });
    expect(String(r.result), `fsize result: ${r.result}`).toMatch(/^blocked:(EFBIG|EPERM)/);
  });

  it("resource-caps: RLIMIT_NOFILE refuses opening past the fd ceiling", async () => {
    if (!supported) return;
    const r = await runProbe({ action: "fd", count: 5000 }, [], { maxOpenFiles: 64 });
    expect(String(r.result), `fd result: ${r.result}`).toMatch(/^blocked:EMFILE/);
  });

  it("resource-caps: RLIMIT_CPU force-terminates a CPU-bound worker", async () => {
    if (!supported) return;
    const input = mkdtempSync(join(tmpdir(), "atlas-cpu-"));
    const inputFile = join(input, "in.md");
    writeFileSync(inputFile, "# cpu\n");
    try {
      // cpuSeconds << wallClockMs, so the CPU rlimit (SIGXCPU) fires first, not the watchdog.
      const raw = await spawnSandboxed({
        modulePath: CPU_PROBE,
        request: { inputPath: inputFile, format: "markdown", workTmp: join(input, "w"), maxOutputBytes: 1 << 20 },
        limits: { ...DEFAULT_SANDBOX_LIMITS, cpuSeconds: 1, wallClockMs: 20_000 },
      });
      // The probe emits no control; it must have been terminated (signal) or exited non-zero.
      expect(raw.control.trim()).toBe("");
      expect(raw.signal !== null || (raw.code !== 0 && raw.code !== null), `cpu run: code=${raw.code} signal=${raw.signal}`).toBe(true);
    } finally {
      rmSync(input, { recursive: true, force: true });
    }
  });

  it.skipIf(platform() !== "linux")(
    "resource-caps (linux): the per-worker cgroup caps a memory-hungry worker AND the leaf is removed after the run (finding 1)",
    async () => {
      if (!supported) return; // reaching here means cgroup v2 is usable (else unsupported)
      const base = process.env.ATLAS_SANDBOX_CGROUP_ROOT ?? "/sys/fs/cgroup";
      const before = countCgroupLeaves(base);
      const input = mkdtempSync(join(tmpdir(), "atlas-cg-"));
      const inputFile = join(input, "in.md");
      writeFileSync(inputFile, "# cg\n");
      try {
        // A low memory.max (128 MiB) — the mem probe grows past it and must be killed by
        // the cgroup (memory.max OOM) or RLIMIT_AS; it must NOT exit cleanly.
        const raw = await spawnSandboxed({
          modulePath: MEM_PROBE,
          request: { inputPath: inputFile, format: "markdown", workTmp: join(input, "w"), maxOutputBytes: 1 << 20 },
          limits: { ...DEFAULT_SANDBOX_LIMITS, maxAddressSpaceBytes: 128 * 1024 * 1024, wallClockMs: 20_000 },
        });
        const cleanExit = raw.code === 0 && raw.signal === null && !raw.memExceeded;
        expect(cleanExit, `cgroup must cap the mem worker: code=${raw.code} signal=${raw.signal}`).toBe(false);
        // The launcher removed the per-worker cgroup leaf after the run (cleanup).
        expect(countCgroupLeaves(base), "the per-worker cgroup leaf must be removed after the run").toBeLessThanOrEqual(before);
      } finally {
        rmSync(input, { recursive: true, force: true });
      }
    },
  );

  it("resource-caps: the memory cap force-terminates a memory-hungry worker", async () => {
    if (!supported) return;
    const input = mkdtempSync(join(tmpdir(), "atlas-mem-"));
    const inputFile = join(input, "in.md");
    writeFileSync(inputFile, "# mem\n");
    try {
      // On Linux RLIMIT_AS refuses the allocation (non-zero exit); on macOS the RSS
      // watchdog SIGKILLs it. Either way it must not exit cleanly.
      const raw = await spawnSandboxed({
        modulePath: MEM_PROBE,
        request: { inputPath: inputFile, format: "markdown", workTmp: join(input, "w"), maxOutputBytes: 1 << 20 },
        limits: { ...DEFAULT_SANDBOX_LIMITS, maxAddressSpaceBytes: 300 * 1024 * 1024, wallClockMs: 20_000 },
      });
      const cleanExit = raw.code === 0 && raw.signal === null && !raw.memExceeded;
      expect(cleanExit, `mem run must be capped: code=${raw.code} signal=${raw.signal} memExceeded=${raw.memExceeded}`).toBe(false);
    } finally {
      rmSync(input, { recursive: true, force: true });
    }
  });
});

/** Count leftover `atlas-worker-*` temp dirs (to assert the launcher cleans them up). */
function countWorkerTemps(): number {
  try {
    return readdirSync(tmpdir()).filter((n) => n.startsWith("atlas-worker-")).length;
  } catch {
    return 0;
  }
}

/** Count per-worker cgroup leaves (named after the `atlas-lsbx-*` scratch) under `base`. */
function countCgroupLeaves(base: string): number {
  try {
    return readdirSync(base).filter((n) => n.startsWith("atlas-lsbx-")).length;
  } catch {
    return 0;
  }
}

/**
 * Host-INDEPENDENT seccomp-BPF assertions (wing round-3 finding 2). The classic-BPF
 * program is pure data, so we assert both the x86_64 AND aarch64 filters on ANY host
 * (incl. this macOS runner) via the {@link evalSeccomp} interpreter — proving the ARM64
 * worker can BOOT (execve allowed) while re-exec/subprocess creation stays denied. The
 * "real worker boots + parses under the jail" positive control (above) is what exercises
 * the live ARM64 filter on linux-arm64 CI.
 */
describe("seccomp-bpf filter (both arches, finding 2)", () => {
  // Stable syscall numbers per arch (matching the tables in linux.ts).
  const NR = {
    x64: { read: 0, write: 1, execve: 59, execveat: 322, fork: 57, vfork: 58, clone: 56, clone3: 435, socket: 41 },
    arm64: { read: 63, write: 64, execve: 221, execveat: 281, clone: 220, clone3: 435, socket: 198 },
  } as const;
  const CLONE_THREAD = 0x00010000;

  for (const target of ["x64", "arm64"] as const) {
    describe(target, () => {
      const prog = buildSeccompProgram(target);
      const nr = NR[target];
      const act = (n: number, arg0 = 0) => evalSeccomp(prog!, { arch: AUDIT_ARCH[target], nr: n, arg0 });

      it("builds a non-empty program", () => {
        expect(prog).not.toBeNull();
        expect(prog!.length % 8).toBe(0);
        expect(prog!.length).toBeGreaterThan(0);
      });

      it("ALLOWS execve (the bwrap→node bootstrap) so the worker can boot", () => {
        expect(act(nr.execve)).toBe("allow");
      });

      it("DENIES execveat + all process-creation (re-exec cannot spawn a NEW process)", () => {
        expect(act(nr.execveat)).toBe("eperm");
        if ("fork" in nr) expect(act(nr.fork)).toBe("eperm");
        if ("vfork" in nr) expect(act(nr.vfork)).toBe("eperm");
        // clone WITHOUT CLONE_THREAD is a new process ⇒ denied; WITH it is a thread ⇒ allowed.
        expect(act(nr.clone, 0)).toBe("eperm");
        expect(act(nr.clone, CLONE_THREAD)).toBe("allow");
        // clone3 is forced to ENOSYS so glibc/libuv fall back to the flag-checked clone.
        expect(act(nr.clone3)).toBe("enosys");
      });

      it("DENIES the network syscall (socket) — the seccomp belt behind netns", () => {
        expect(act(nr.socket)).toBe("eperm");
      });

      it("ALLOWS the parse-necessary syscalls (read/write)", () => {
        expect(act(nr.read)).toBe("allow");
        expect(act(nr.write)).toBe("allow");
      });

      it("KILLS on an architecture mismatch (nr aliasing defence)", () => {
        const otherArch = target === "x64" ? AUDIT_ARCH.arm64 : AUDIT_ARCH.x64;
        expect(evalSeccomp(prog!, { arch: otherArch, nr: nr.read })).toBe("kill");
      });

      it("EPERMs an unknown / non-allowlisted syscall (default action)", () => {
        expect(act(0x3fff)).toBe("eperm");
      });
    });
  }
});
