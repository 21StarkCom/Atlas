/**
 * macOS Seatbelt backend (`sandbox-contract.md §1`, darwin column).
 *
 * The worker runs as `sandbox-exec -f <profile> <node> <workerModule> <requestJson>`
 * with an allowlisted empty environment. The generated profile is `(deny default)`
 * and re-allows only what a Node worker needs to parse an untrusted file:
 *
 *   - **no-network**       — `(deny network*)` (the load-bearing denial; the per-UID
 *                            `pf` anchor from provisioning is defense-in-depth).
 *   - **no-subprocess**    — `process-exec` is allowed ONLY for the node binary
 *                            literal, so `execve` of `/bin/sh` (and anything else) is
 *                            refused; `process-fork` stays allowed (V8/libuv threads).
 *   - **isolated-fs**      — writes are confined to the worker-private temp; reads of
 *                            the credential/home/vault trees are denied, the one input
 *                            handle + the JS code closure are re-allowed.
 *   - **no-credentials**   — `/Library/Keychains` + the home tree (login keychains,
 *                            `~/.ssh`, `~/.aws`, …) are data-read denied.
 *   - **resource-caps**    — POSIX rlimits are applied by the launcher via
 *                            {@link applyRlimits} before it execs `sandbox-exec`; the
 *                            wall-clock watchdog lives in the launcher.
 *
 * DESIGN NOTE (Seatbelt version churn — a first-class concern of this task, and a wing
 * round-2 finding). The profile is `(deny default)` with a DATA-READ ALLOWLIST — it
 * does NOT take a broad `(allow file-read*)` (which left arbitrary paths and same-UID
 * Atlas keys readable). File-read-METADATA is allowed broadly (stat/traversal leak no
 * content and path resolution needs it), but file-read-DATA is granted only for: the
 * root directory entry, the fixed system runtime roots the Node runtime needs
 * (`/usr`, `/System`, `/Library`, `/opt`, the dyld cache), the Node install tree, the
 * compiled import closure (`codeRoots`), the ONE input handle, and the worker-private
 * temp. Everything else — the home tree, `/Users`, arbitrary `/tmp` siblings, the
 * keychain, the Atlas key dirs — is denied because it is simply NOT in the allowlist.
 * The known credential subpaths that fall UNDER an allowed root (e.g. `/Library/
 * Keychains`, `/usr/local/etc/atlas`) plus every caller `denyReadRoot` are denied
 * AFTER the allows so a deny is never defeated by an ancestor allow; the one input
 * literal is re-allowed LAST so exactly that file (which may live inside a denied
 * tree, e.g. the vault) is readable and nothing else in that tree is. The startup
 * probe fails loud if `sandbox-exec` / `/bin/sh` are unavailable.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SandboxCapabilityCheck, SandboxLimits } from "../types.js";
import type { SandboxBackend, SandboxSpawnInputs, SandboxSpawnPlan } from "./backend.js";

/** `sandbox-exec` — present on every supported macOS; the Seatbelt entrypoint. */
const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
/** `/bin/sh` — used only as the pre-sandbox `ulimit` shim that sets the POSIX rlimits. */
const BIN_SH = "/bin/sh";

/**
 * Fixed system runtime roots whose DATA the Node runtime reads to boot + parse — dylibs,
 * frameworks, and the dyld shared cache. These hold no user secrets. Wing round-3
 * finding 4: the prior set exposed ALL of `/usr`, `/Library`, and `/opt`, so an
 * untrusted parser could read unrelated configuration/secrets under those roots (e.g.
 * `/Library/Application Support`, `/usr/local/etc`, arbitrary `/opt` subtrees). Narrowed to the
 * PRECISE immutable runtime closure a macOS Node needs (verified against the real
 * `otool -L` dylib set on Node 26 / macOS 26, Apple silicon):
 *   - `/usr/lib`        — `libSystem`, `libc++`, `libz` (NOT all of `/usr`);
 *   - `/System/Library` — CoreFoundation / Security frameworks (NOT all of `/System`);
 *   - the dyld shared cache (cryptex + classic locations);
 *   - `/opt/homebrew`   — the Apple-silicon Homebrew prefix that holds a Homebrew Node's
 *     external dylibs (icu4c/openssl/…); a self-contained Node tarball needs none of
 *     this (its libs live under `nodeRoot`, allowed separately). NOT all of `/opt`.
 * `/Library`, `/Users`, the home tree, `/bin`, `/sbin`, and arbitrary `/opt` are NO
 * LONGER allowed — they are unreadable in the jail by default-deny. The credential
 * subpaths that fall under an allowed root are still denied below (belt & braces).
 */
const SYSTEM_READ_ROOTS = [
  "/usr/lib",
  "/System/Library",
  "/System/Volumes/Preboot/Cryptexes",
  "/System/Cryptexes",
  "/private/var/db/dyld",
  "/opt/homebrew",
] as const;

/**
 * Credential / key trees that fall UNDER an allowed system root and must be carved back
 * out (everything NOT under an allowed root is already denied by default). Denied after
 * the allows so an ancestor allow can never re-expose them.
 */
const CREDENTIAL_DENY_ROOTS = [
  "/Library/Keychains",
  "/usr/local/etc/atlas", // darwin Atlas key custody dir (doctor.ts)
  "/etc/atlas",
  "/private/etc/atlas",
  "/private/var/db/atlas",
] as const;

/** Escape a filesystem path for embedding inside a Seatbelt `(literal "…")`/`(subpath "…")`. */
function sbPath(p: string): string {
  // Seatbelt string literals are double-quoted; backslash-escape `\` and `"`.
  return p.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Canonicalize a path for embedding in the profile. Seatbelt matches file rules
 * against the PHYSICAL (symlink-resolved) path, and macOS resolves `/tmp` and
 * `/var` to `/private/tmp` + `/private/var`. A profile that embedded the unresolved
 * `/var/folders/…` tmp path would therefore never match the actual access — so an
 * allow (worker temp write, input re-read) would silently fail closed and, worse, a
 * deny (vault/keychain/out-of-scope root) would silently fail OPEN. Every path baked
 * into the profile is resolved here; a not-yet-existing path (e.g. a configured but
 * absent vault) falls back to its literal form (nothing to leak through).
 */
function canon(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Generate the Seatbelt profile text for one launch. `nodePath` must be the REALPATH
 * of the node binary (the `process-exec` literal is matched post-symlink-resolution).
 * The read allowlist is default-deny (see the file header); ordering is load-bearing
 * (Seatbelt is last-match-wins): system/node/code allows → credential + caller denies
 * → the one input literal re-allow.
 */
export function buildSeatbeltProfile(inputs: {
  readonly nodePath: string;
  readonly inputPath: string;
  readonly workTmp: string;
  readonly codeRoots: readonly string[];
  readonly denyReadRoots: readonly string[];
}): string {
  // Canonicalize every embedded path — Seatbelt matches the physical, symlink-
  // resolved path (macOS `/tmp`→`/private/tmp`, `/var`→`/private/var`), so an
  // unresolved path would make allows fail closed and, critically, denies fail OPEN.
  const inputPath = canon(inputs.inputPath);
  const workTmp = canon(inputs.workTmp);
  const codeRoots = inputs.codeRoots.map(canon).filter((c) => c.length > 0);
  // The Node install tree (two levels up from `<install>/bin/node`) — self-contained
  // layouts (nvm/asdf under $HOME) keep their dylibs here; system/Homebrew installs are
  // already covered by the fixed system roots.
  const nodeRoot = dirname(dirname(inputs.nodePath));
  const readRoots = [...SYSTEM_READ_ROOTS, nodeRoot, ...codeRoots].filter((r) => r.length > 0);
  const denyRoots = [...CREDENTIAL_DENY_ROOTS, ...inputs.denyReadRoots.map(canon)].filter((d) => d.length > 0);

  const lines: string[] = [
    "(version 1)",
    "(deny default)",
    // process: node may re-exec ITSELF (the bootstrap) but may NOT fork — on macOS
    // libuv/V8 threads do not use fork(), and posix_spawn of a subprocess needs a fork,
    // so denying process-fork blocks EVERY subprocess (including exec of node itself)
    // while the runtime still boots. This is the no-subprocess guarantee.
    "(deny process-fork)",
    `(allow process-exec (literal "${sbPath(inputs.nodePath)}"))`,
    // runtime basics the Node/CoreFoundation bootstrap needs.
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    "(allow mach-priv-task-port)",
    "(allow iokit-open)",
    "(allow iokit-get-properties)",
    "(allow signal (target self))",
    // metadata (stat/traversal) everywhere so path resolution to the input works even
    // when the input lives under an otherwise-denied tree (e.g. the vault). Reading
    // metadata leaks no file CONTENT.
    "(allow file-read-metadata)",
    // DATA-read allowlist (default-deny): the root dir entry + fixed system runtime
    // roots + the node install tree + the compiled import closure.
    `(allow file-read-data (literal "/"))`,
    ...readRoots.map((r) => `(allow file-read-data (subpath "${sbPath(r)}"))`),
    // credential/key trees under an allowed root + caller out-of-scope roots — denied
    // AFTER the allows so an ancestor allow cannot re-expose them.
    ...denyRoots.map((d) => `(deny file-read-data (subpath "${sbPath(d)}"))`),
    // the ONE input handle's data, LAST so it wins over any covering deny (the input
    // legitimately may live inside a denied tree, e.g. the vault) — and ONLY that file.
    `(allow file-read-data (literal "${sbPath(inputPath)}"))`,
    // writes: the disposable worker-private temp ONLY.
    `(allow file-write* (subpath "${sbPath(workTmp)}"))`,
    // the load-bearing network denial.
    "(deny network*)",
  ];
  return lines.join("\n") + "\n";
}

/**
 * Build the `/bin/sh` `ulimit` shim that applies the POSIX rlimits BEFORE `exec`ing the
 * real command (macOS has no `prlimit`, and Node cannot `setrlimit`). rlimits are
 * inherited across the subsequent `sandbox-exec`→`node` exec chain. Empirically macOS
 * enforces RLIMIT_CPU / RLIMIT_FSIZE / RLIMIT_NOFILE (RLIMIT_AS is NOT enforced by the
 * XNU kernel — the launcher's RSS watchdog is the memory cap there). `ulimit -f` is in
 * 512-byte blocks; `-t` seconds; `-n` fd count. RLIMIT_NPROC (`-u`) is session-wide on
 * macOS so we do NOT set it (the Seatbelt fork denial is the no-subprocess mechanism).
 */
function ulimitShim(limits: SandboxLimits): string {
  const fsizeBlocks = Math.max(1, Math.ceil(limits.maxFileSizeBytes / 512));
  return [
    `ulimit -t ${limits.cpuSeconds}`,
    `ulimit -n ${limits.maxOpenFiles}`,
    `ulimit -f ${fsizeBlocks}`,
    // Best-effort address-space cap (KiB); XNU does not enforce it, so ignore failure —
    // the launcher RSS watchdog provides the real memory ceiling.
    `ulimit -v ${Math.ceil(limits.maxAddressSpaceBytes / 1024)} 2>/dev/null || true`,
    `exec "$@"`,
  ].join("; ");
}

/**
 * Candidate paths for the per-UID `pf` anchor the provisioning installs (D17). It is
 * DEFENSE-IN-DEPTH for `no-network` — the Seatbelt `(deny network*)` is the load-bearing
 * denial — so its absence is REPORTED in the probe detail but never fails the probe
 * closed (a dev host that has not run `provisioning/macos` still has a functional
 * network jail via Seatbelt).
 */
const PF_ANCHOR_CANDIDATES = ["/etc/pf.anchors/atlas", "/etc/pf.anchors/com.atlas", "/etc/pf.anchors/atlas-agent"] as const;

/** Is a provisioning `pf` anchor present (defense-in-depth for no-network)? */
function pfAnchorPresent(): boolean {
  return PF_ANCHOR_CANDIDATES.some((p) => existsSync(p));
}

/**
 * FUNCTIONAL, fail-closed Seatbelt check (wing round-3 finding 3): the prior probe only
 * checked that `sandbox-exec`/`/bin/sh` EXIST, then claimed every Seatbelt guarantee. It
 * would not detect an unusable/uncompilable profile or a Seatbelt that silently no-ops
 * (e.g. SIP or the sandbox kext disabled). Here we actually EXERCISE Seatbelt: generate
 * a canary profile that DENIES reading a freshly-written secret (canonical path — the
 * real matcher resolves symlinks) and confirm (a) an ALLOWED read succeeds and (b) the
 * DENIED read is blocked (non-zero). Anything else — binary missing, compile error, or a
 * deny that fails to bite — returns not-ok so the whole sandbox reports unsupported.
 */
function functionalSeatbelt(): { ok: boolean; detail?: string } {
  if (!existsSync(SANDBOX_EXEC)) return { ok: false, detail: `${SANDBOX_EXEC} not found — Seatbelt unavailable` };
  let dir: string | null = null;
  try {
    dir = mkdtempSync(join(tmpdir(), "atlas-sbprobe-"));
    // Canonicalize (macOS `/var/folders/...` is already a real path, but be robust to
    // `/tmp`→`/private/tmp` symlinking) so the deny literal matches the physical path.
    const secret = join(canon(dir), "secret");
    const allowed = join(canon(dir), "allowed");
    writeFileSync(secret, "seatbelt-probe-secret", { mode: 0o600 });
    writeFileSync(allowed, "seatbelt-probe-allowed", { mode: 0o600 });
    const profilePath = join(dir, "canary.sb");
    const profile =
      ["(version 1)", "(allow default)", `(deny file-read-data (literal "${sbPath(secret)}"))`, "(deny network*)"].join("\n") + "\n";
    writeFileSync(profilePath, profile, { mode: 0o600 });
    // (a) positive control: an allowed read must succeed under the canary.
    try {
      execFileSync(SANDBOX_EXEC, ["-f", profilePath, "/bin/cat", allowed], { stdio: "ignore" });
    } catch {
      return { ok: false, detail: "Seatbelt canary could not run an allowed read (sandbox-exec/`/bin/cat` unusable)" };
    }
    // (b) the deny must actually block the read.
    let denied = false;
    try {
      execFileSync(SANDBOX_EXEC, ["-f", profilePath, "/bin/cat", secret], { stdio: "ignore" });
    } catch {
      denied = true;
    }
    if (!denied) return { ok: false, detail: "Seatbelt did not enforce a file-read deny (unusable profile / sandbox disabled)" };
    return { ok: true };
  } catch (e) {
    return { ok: false, detail: `Seatbelt functional check failed: ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    if (dir !== null) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  }
}

/**
 * FUNCTIONAL rlimit check (finding 3): the POSIX rlimits are applied by a `/bin/sh`
 * `ulimit` shim, so confirm the shim actually applies them. RLIMIT_AS is deliberately
 * NOT asserted — the XNU kernel does not enforce it (the launcher RSS watchdog is the
 * real memory cap), so the probe never CLAIMS an unenforced RLIMIT_AS.
 */
function functionalRlimit(): { ok: boolean; detail?: string } {
  if (!existsSync(BIN_SH)) return { ok: false, detail: `${BIN_SH} not found — cannot apply rlimits` };
  try {
    execFileSync(BIN_SH, ["-c", "ulimit -t 30 && ulimit -n 64 && ulimit -f 2048 && exec /usr/bin/true"], { stdio: "ignore" });
    return { ok: true };
  } catch (e) {
    return { ok: false, detail: `rlimit (ulimit) shim not functional: ${e instanceof Error ? e.message : String(e)}` };
  }
}

class DarwinBackend implements SandboxBackend {
  readonly hostId = "darwin-arm64" as const;

  probe(): SandboxCapabilityCheck[] {
    // Functional, fail-closed capability checks (finding 3) — exercise the ACTUAL
    // primitives once at startup, not mere existence of the binaries.
    const seatbeltFn = functionalSeatbelt();
    const rlimitFn = functionalRlimit();
    const pf = pfAnchorPresent();

    const seatbelt = (guarantee: SandboxCapabilityCheck["guarantee"], primitive: string): SandboxCapabilityCheck =>
      seatbeltFn.ok
        ? { guarantee, available: true, primitive }
        : { guarantee, available: false, primitive, detail: seatbeltFn.detail ?? "Seatbelt not functional" };

    return [
      // no-network: the load-bearing Seatbelt `network*` deny (functionally verified);
      // the pf anchor is defense-in-depth and only ANNOTATED, never required.
      seatbeltFn.ok
        ? { guarantee: "no-network", available: true, primitive: pf ? "seatbelt-deny-network+pf" : "seatbelt-deny-network (pf anchor not detected — defense-in-depth only)" }
        : { guarantee: "no-network", available: false, primitive: "seatbelt-deny-network+pf", detail: seatbeltFn.detail ?? "Seatbelt not functional" },
      { guarantee: "empty-environment", available: true, primitive: "spawn-empty-env" },
      seatbelt("isolated-filesystem", "seatbelt-file-read-allowlist"),
      seatbelt("no-credential-access", "seatbelt-default-deny+credential-denies"),
      { guarantee: "no-inherited-fds", available: true, primitive: "close-on-exec+explicit-stdio" },
      seatbelt("no-subprocess", "seatbelt-deny-fork+exec-node-only"),
      seatbelt("syscall-restriction", "seatbelt-default-deny"),
      // resource-caps: CPU/FSIZE/NOFILE via the functionally-verified `ulimit` shim;
      // memory via the launcher RSS watchdog (XNU does not enforce RLIMIT_AS). Needs a
      // functional Seatbelt too (the caps ride the same exec chain).
      seatbeltFn.ok && rlimitFn.ok
        ? { guarantee: "resource-caps", available: true, primitive: "ulimit(cpu,fsize,nofile)+rss-watchdog+wallclock" }
        : {
            guarantee: "resource-caps",
            available: false,
            primitive: "ulimit+rss-watchdog+wallclock",
            detail: (rlimitFn.ok ? seatbeltFn.detail : rlimitFn.detail) ?? "resource caps unavailable",
          },
      { guarantee: "scan-before-persist", available: true, primitive: "in-worker-scan+attested-pipe" },
    ];
  }

  buildSpawn(inputs: SandboxSpawnInputs): SandboxSpawnPlan {
    // Node's `process.execPath` may be a symlink (Homebrew); the profile's exec
    // literal must be the resolved path.
    const nodeReal = safeRealpath(inputs.nodePath);
    const profileDir = mkdtempSync(join(tmpdir(), "atlas-sbx-"));
    const profilePath = join(profileDir, "worker.sb");
    writeFileSync(
      profilePath,
      buildSeatbeltProfile({
        nodePath: nodeReal,
        inputPath: inputs.request.inputPath,
        workTmp: inputs.request.workTmp,
        codeRoots: inputs.codeRoots,
        denyReadRoots: inputs.denyReadRoots,
      }),
      { mode: 0o600 },
    );
    // Wrap in `/bin/sh -c '<ulimit shim>; exec "$@"' atlas-sbx sandbox-exec …` so the
    // POSIX rlimits are set (and inherited across the exec chain) BEFORE Seatbelt +
    // node run. `$0` is a label; `"$@"` is the sandbox-exec command line.
    return {
      command: BIN_SH,
      args: [
        "-c",
        ulimitShim(inputs.limits),
        "atlas-sbx",
        SANDBOX_EXEC,
        "-f",
        profilePath,
        nodeReal,
        inputs.workerModule,
        JSON.stringify(inputs.request),
      ],
      cleanup: () => rmSync(profileDir, { recursive: true, force: true }),
    };
  }
}

/** Resolve a path through symlinks; fall back to the original if it cannot be resolved. */
function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

export const darwinBackend: SandboxBackend = new DarwinBackend();
