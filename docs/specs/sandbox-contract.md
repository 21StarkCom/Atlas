# Sandbox contract (normative) — Atlas V1 Phase 2

**Owner task:** 2.0 · **Consumed by:** Task 2.3 (`@atlas/sources` sandboxed parser worker). This fixes
the per-guarantee isolation primitive on each supported host, the startup capability checks, and the
supported-host matrix. The sandbox launcher implements this contract verbatim; a host that fails a
required capability probe MUST fail closed (no parse runs).

> Threat model. The parser worker processes UNTRUSTED input (arbitrary files being ingested). It must
> not reach the network, the vault, the keychain/credentials, inherited fds, or any path outside its
> disposable worker-private temp; it must not spawn subprocesses or make forbidden syscalls; and it
> runs the secret scanner INSIDE the sandbox (D15), emitting an attested clean stream — never writing
> unscanned normalized bytes to a shared sink.

## 1. Per-guarantee isolation matrix

Each guarantee is enforced by a concrete primitive on each host. `runInSandbox` refuses to launch if
any REQUIRED primitive is unavailable.

```json sandboxContract
{
  "version": 1,
  "supportedHosts": ["darwin-arm64", "linux-x86_64", "linux-arm64"],
  "guarantees": [
    {
      "guarantee": "no-network",
      "required": true,
      "darwin": "Seatbelt profile denies network* (outbound/inbound); per-UID pf anchor as defense-in-depth",
      "linux": "unshare network namespace (CLONE_NEWNET) with no interfaces + seccomp deny of socket() for AF_INET/AF_INET6"
    },
    {
      "guarantee": "empty-environment",
      "required": true,
      "darwin": "spawn with an allowlisted empty env (no inherited vars)",
      "linux": "spawn with an allowlisted empty env (no inherited vars)"
    },
    {
      "guarantee": "isolated-filesystem",
      "required": true,
      "darwin": "Seatbelt file-read* allowlist = the read-only input handle + worker-private temp only; file-write* = worker-private temp only",
      "linux": "user namespace (CLONE_NEWUSER) + mount namespace with a minimal read-only bind of the input + a private tmpfs; everything else unmapped"
    },
    {
      "guarantee": "no-credential-access",
      "required": true,
      "darwin": "Seatbelt denies keychain-access + the credential paths are outside the read allowlist",
      "linux": "credential dirs are not mapped into the mount namespace (unreachable)"
    },
    {
      "guarantee": "no-inherited-fds",
      "required": true,
      "darwin": "close-on-exec all fds except the sealed input + the output pipe",
      "linux": "close-on-exec all fds except the sealed input + the output pipe"
    },
    {
      "guarantee": "no-subprocess",
      "required": true,
      "darwin": "Seatbelt denies process-exec* / process-fork",
      "linux": "seccomp deny of execve/execveat/fork/vfork/clone(new process)"
    },
    {
      "guarantee": "syscall-restriction",
      "required": true,
      "darwin": "Seatbelt default-deny profile allowing only the parse-necessary operations",
      "linux": "seccomp-bpf allowlist filter (default EPERM) covering only parse-necessary syscalls"
    },
    {
      "guarantee": "resource-caps",
      "required": true,
      "darwin": "posix rlimits (RLIMIT_CPU, RLIMIT_AS, RLIMIT_FSIZE, RLIMIT_NOFILE) + a wall-clock watchdog killing the worker on timeout",
      "linux": "rlimits + a cgroup (memory/pids/cpu) the worker cannot leave + a wall-clock watchdog"
    },
    {
      "guarantee": "scan-before-persist",
      "required": true,
      "darwin": "the scanner runs in-worker; output leaves only via the attested pipe/sealed memory-backed fd — no shared outputDir",
      "linux": "the scanner runs in-worker; output leaves only via the attested pipe/sealed memory-backed fd — no shared outputDir"
    }
  ]
}
```

## 2. Startup capability checks (`probeSandbox`)

Before any parse, `probeSandbox()` verifies each REQUIRED guarantee's primitive is actually
available on this host and returns a `SandboxCapabilityReport`. `doctor` surfaces this report.

```json sandboxProbeExample
{
  "host": "darwin-arm64",
  "supported": true,
  "checks": [
    { "guarantee": "no-network", "available": true, "primitive": "seatbelt+pf" },
    { "guarantee": "isolated-filesystem", "available": true, "primitive": "seatbelt-file-allowlist" },
    { "guarantee": "syscall-restriction", "available": true, "primitive": "seatbelt-default-deny" },
    { "guarantee": "resource-caps", "available": true, "primitive": "rlimit+watchdog" }
  ]
}
```

Rules:

- If any REQUIRED guarantee is `available: false`, `supported` is `false` and `runInSandbox` refuses
  to launch (fail closed) — normalization then returns a typed rejection, nothing is parsed.
- The probe is side-effect-free and fast; it is run at process startup and cached for the process
  lifetime.

## 3. Supported-host matrix

| Host | Backend | Status |
|---|---|---|
| `darwin-arm64` (Apple silicon, current major) | Seatbelt (`sandbox-exec` profile) + per-UID `pf` anchor | supported |
| `linux-x86_64` | userns + mountns + netns + seccomp-bpf + cgroup + rlimits | supported |
| `linux-arm64` | userns + mountns + netns + seccomp-bpf + cgroup + rlimits | supported |
| any other host | — | unsupported (fail closed; `doctor` reports it) |

## 4. Output contract (D15)

`runInSandbox` returns a readable stream + a scan attestation, NOT a directory path. The attestation
is **bound to the emitted bytes**: `outputDigest` is the SHA-256 the in-worker scanner computed over
the exact clean byte stream it released. The consumer MUST recompute the digest over the bytes it
receives and confirm it equals `attestation.outputDigest` **before** those bytes are exposed to any
caller or persisted to any sink — a mismatch is treated as a scan failure (bytes discarded), so
unscanned or tampered bytes can never be attested clean.

```json sandboxResultExample
{
  "ok": true,
  "attestation": {
    "scannerRulesetVersion": 1,
    "scannedBytes": 990,
    "clean": true,
    "outputDigest": "sha256:3f9a...c012"
  }
}
```

Three disjoint result kinds — secret detection is NOT folded into the normalization rejection set:

- **clean** (`ok: true`, above): the digest-bound attestation accompanies the stream.
- **scan rejection** (`ok: false`, `kind: "scan-rejection"`): the in-sandbox secret scanner hit.
  This is the **distinct exit-3 path** (`secret-detected`), separate from the exhaustive
  `NormalizationRejection` set (exit 1). NO normalized bytes are emitted; the source is quarantined
  and nothing is written to any temp/parser/worktree sink.
- **normalization rejection** (`ok: false`, `kind: "normalization-rejection"`): a typed
  `NormalizationRejection` (unsupported-encoding / encrypted-source / no-extractable-text / … —
  `normalization-contract.md §2`, exit 1). Also emits no bytes.

```json sandboxScanRejectionExample
{
  "ok": false,
  "kind": "scan-rejection",
  "code": "secret-detected",
  "exit": 3,
  "scannerRulesetVersion": 1
}
```

```json sandboxNormalizationRejectionExample
{
  "ok": false,
  "kind": "normalization-rejection",
  "rejection": { "code": "encrypted-source", "format": "pdf", "detail": "password-protected document" }
}
```

## 5. Acceptance (implemented by Task 2.3 tests)

- Adversarial probe parsers: network, env, keychain, inherited fds, out-of-scope paths, subprocess
  spawn, and forbidden syscalls all fail; caps enforce (including cleanup after forced termination).
- `scan-before-persist`: a secret-bearing source yields no file on any temp/parser/worktree sink
  before the reject; a filesystem probe during the run finds no unscanned normalized bytes.
- Both suites green on macOS + Linux in CI.
