# `@atlas/sources` — sandboxed parser worker + normalizers

Turns an untrusted local file (`markdown`/`text`/`pdf`/`html`) into a deterministic
`NormalizedRendition` **or** a typed rejection, running the parse **and** the secret scan
INSIDE a per-host OS jail. Two specs are the SSOT and the code transcribes them verbatim —
edit the spec first, then the code:

- `docs/specs/sandbox-contract.md` — isolation matrix, startup probe, host support, D15 output contract.
- `docs/specs/normalization-contract.md` — per-format signatures/limits, rejection codes, determinism.

**Deps:** `@atlas/contracts` (type-only DTOs, erased at compile), `@atlas/scan` (in-worker scanner
+ trusted-side `PrePersistenceGuard`), `parse5` (HTML). **Dependent:** only `apps/cli` (the ingest
pipeline calls `normalize()`). **Build:** `tsc -p tsconfig.json` → `dist/`. **Test:**
`vitest run --passWithNoTests`.

The package splits along two git-distinct tasks: **Task 2.3** (the sandbox, `src/sandbox/` +
`src/worker/`) and **Task 2.4** (normalization, `src/normalize/`).

## Key files

**Detection + shared types**
- `src/formats.ts` — `SOURCE_FORMATS`, `CANONICAL_MEDIA_TYPE`, `MAX_BYTES` (md/txt 5 MiB, html 10 MiB,
  pdf 50 MiB), `signatureMatches` (`%PDF-` / `<!doctype html`|`<html` / `looksTextual`), and
  `decodeTextStrict` — the single FATAL UTF-8/UTF-16 decode seam (invalid ⇒ `unsupported-encoding`,
  never lossy `U+FFFD`).
- `src/types.ts` — `SandboxLimits`, `DEFAULT_SANDBOX_LIMITS`, `SANDBOX_LIMIT_CEILINGS`,
  `ScanAttestation`, the 3-kind `WorkerResult` union, `NormalizationRejection(Code)`, and the sandbox
  report types. Owned here (not `@atlas/contracts`) on purpose — this is the sandbox seam, not a
  cross-store DTO.

**Sandbox (`src/sandbox/`)**
- `backend.ts` — host-agnostic `SandboxBackend` seam + `detectHost()` (darwin-arm64 / linux-x86_64 /
  linux-arm64, else `null` = unsupported).
- `darwin.ts` — Seatbelt: `buildSeatbeltProfile` (`(deny default)` + DATA-READ allowlist), `ulimitShim`
  (POSIX rlimits via `/bin/sh` before exec), `functionalSeatbelt`/`functionalRlimit` FUNCTIONAL probes.
- `linux.ts` — bwrap: `buildSeccompProgram` (pure classic-BPF allowlist, x64+arm64) + `evalSeccomp` (a
  BPF interpreter, so both arch filters are asserted on ANY host incl. macOS CI) + cgroup-v2 helpers.
- `probes.ts` — `probeSandbox()` (cached process-lifetime report; `doctor` surfaces it) +
  `selectBackend()` + `resetSandboxProbeCache()`.
- `launcher.ts` — `runInSandbox` (public entry), `spawnSandboxed` (also used by the containment tests),
  `resolveLimits` (clamp), `importClosureRoots`/`detectCodeRoot` (the read closure), `sha256Hex`, the
  watchdogs, and the four error classes: `SandboxUnsupportedError` (exit 2),
  `SandboxCapExceededError`/`SandboxWorkerError` (exit 4), `SandboxAttestationError` (exit 3).
- `protocol.ts` — the wire protocol: `OUTPUT_FD=1` (clean bytes), `CONTROL_FD=3` (one JSON outcome),
  `WorkerRequest` (argv JSON, NON-secret metadata only), `parseWorkerControl` (STRICT per-field
  validation). `MAX_QUARANTINE_CONTROL_BYTES` = 1 MiB.
- `src/worker/main.ts` — the confined worker entrypoint, compiled to `dist/worker/main.js` and spawned
  as a real process. Flow: bounded read (`stat`+`ceiling+1`, never slurp) → signature check → normalize
  in memory → in-sandbox `scanBytes` → clean: fd1 bytes + digest-bound attestation on fd3; dirty: ZERO
  fd1 bytes, `scan-rejection` on fd3 with a bounded base64 quarantine window.

**Normalization (`src/normalize/`)**
- `index.ts` — `normalize({path, guard})` (guard-enforced orchestrator), `EXTRACTOR_VERSION`/
  `NORMALIZER_VERSION` (both `1`), `EXTRACTOR_PINS` (`parse5` + `atlas-pdf-1`), `LOCATOR_SCHEME`,
  `readSourceBounded` (single-fd, `O_NONBLOCK|O_NOCTTY`, regular-file-only),
  `UnsupportedSourceError`/`IrregularSourceError` (both exit 5).
- `text.ts` (+ `markdown.ts` reuses it) — verbatim strict-decode; empty ⇒ `no-extractable-text`.
- `pdf.ts` — hand-rolled deterministic extractor using ONLY `node:zlib` (FlateDecode). Faithful-or-
  reject: rejects CID/Type0/Identity/`/Differences`/`/ToUnicode` fonts, unsupported filters, missing
  page-tree branches; resolves the ACTIVE trailer/`/Root`/xref chain; WinAnsi via a PDF Annex-D map.
- `html.ts` — parse5 inert static-DOM extractor; drops `<script>/<style>/<template>/<noscript>`;
  charset only from a real `<meta>` via a tokenizer-style lexical scan; `dom-anchor` locators.
- `media.ts` — `classifyMedia` alt rules. `pins.ts` — `PARSE5_VERSION = "8.0.1"`.

## Public surface (`src/index.ts` barrel)

`runInSandbox`, `spawnSandboxed`, `probeSandbox`, `selectBackend`, `detectHost`,
`resetSandboxProbeCache`; the seccomp primitives (`buildSeccompProgram`/`evalSeccomp`/`AUDIT_ARCH`) for
cross-host tests; the protocol (`OUTPUT_FD`/`CONTROL_FD`/`parseWorkerControl`); format constants +
`decodeTextStrict`; the limits/attestation/report types; and the guarded `normalize()` + version pins.

**Deliberately NOT exported:** the raw per-format parsers (`normalize/{markdown,text,pdf,html}`) and
`classifyMedia`. Exporting them would offer a supported bypass around BOTH the `PrePersistenceGuard`
and sandbox containment — the ONLY public normalization surface is the guarded `normalize()`
(#73, wing round-2 finding 3). Don't re-export them.

## Invariants & guardrails

- **Signature first, extension second.** A `.pdf` whose bytes aren't `%PDF-` is `signature-mismatch`,
  never a guess (`signatureMatches` runs before parse).
- **Partial extraction is a rejection**, never truncated text as success. PDF is the heavy enforcer.
- **Determinism.** Identical bytes + identical extractor/normalizer versions ⇒ byte-identical
  `normalizedContentHash`. Bumping `EXTRACTOR_VERSION` mints a NEW rendition identity — never silent
  drift. The conformance test asserts the RESOLVED `parse5` equals `EXTRACTOR_PINS.parse5` AND the
  manifest uses `catalog:` (no floating range).
- **Scan-before-persist (D15).** Clean bytes leave only via fd1 AFTER the in-worker scan; a dirty
  verdict emits ZERO fd1 bytes. The launcher recomputes SHA-256 over received bytes and confirms
  `== attestation.outputDigest` AND `length == scannedBytes` BEFORE exposing them — mismatch ⇒
  `SandboxAttestationError` (exit 3, discarded). A "clean" control is trusted ONLY if the worker also
  exited cleanly (`code===0 && signal===null`).
- **Fail-closed.** Any REQUIRED guarantee unavailable ⇒ `probeSandbox().supported=false` and
  `runInSandbox` throws `SandboxUnsupportedError` — nothing parsed. Never a silent downgrade.
- **Override clamp.** `resolveLimits` lets a caller only LOWER a cap: every override clamps to the
  DEFAULT (not the higher `SANDBOX_LIMIT_CEILINGS`); NaN/Infinity/≤0/non-integer/missing → default. A
  bad value can never disable a cap.
- **`normalize()` requires a `PrePersistenceGuard`** and scans BOTH sides (raw bytes before the sandbox,
  normalized output after). **Every scan rejection MUST land a non-empty quarantine artifact** (#73
  finding 7): if the worker's bounded payload is absent/empty, `normalize` quarantines the trusted raw
  snapshot (empty raw source ⇒ a non-empty sentinel).
- **Staged snapshot (TOCTOU).** `normalize` stages the exact scanned bytes into a fresh private temp and
  points the worker at THAT immutable handle — never the mutable source pathname.
- **Strict control parsing.** `parseWorkerControl` validates every field of every kind; a `clean`
  message must carry an EXPLICIT `gaps` array (omission rejected, never coerced to `[]` — #73 finding 6).

## Gotchas & sharp edges

- **The worker is the COMPILED `dist/worker/main.js`** — spawned as a real process, resolved from
  `packageRoot()`, never `import.meta.url`. Even under vitest-from-`src`, **build `@atlas/sources` first**
  or the D15/containment suites loud-skip.
- **macOS memory cap is a launcher-side RSS poll** (via `ps`) — XNU does NOT enforce `RLIMIT_AS`;
  `ulimit -v` is best-effort. `RLIMIT_NPROC` is session-wide on macOS so it's NOT applied — Seatbelt
  `process-fork` denial is the no-subprocess mechanism there.
- **Seatbelt matches the PHYSICAL (symlink-resolved) path** — macOS resolves `/tmp`→`/private/tmp`,
  `/var`→`/private/var`. Every profile path is `canon()`'d; an unresolved path makes allows fail closed
  and, worse, **denies fail OPEN**. Last-match-wins ordering: system/node/code allows → credential+caller
  denies → the ONE input literal re-allow (so the input can live inside an otherwise-denied tree).
- **Linux `execve` is ALLOWED** (the bwrap→node bootstrap is one execve under the fresh filter; classic
  BPF can't count execs), but ALL process CREATION (fork/vfork/clone-new-proc/execveat) is denied — a
  re-exec can only REPLACE the worker in place. `clone3`→ENOSYS forces glibc/libuv onto the flag-checked
  `clone` (allow only `CLONE_THREAD`).
- **cgroup v2 is the authoritative Linux mem/pids/cpu cap** and is non-escapable (bwrap never binds
  `cgroupfs`). It needs a delegated writable base (`ATLAS_SANDBOX_CGROUP_ROOT` or writable
  `/sys/fs/cgroup`) — stock hosted CI runners don't provide it; userns is gated by Debian's
  `unprivileged_userns_clone` and Ubuntu 24.04+'s `apparmor_restrict_unprivileged_userns` sysctls.
- **The read closure is narrow** (#73 finding 4): exactly `packages/sources` + `packages/scan` + the
  resolved `parse5` + `entities` store dirs. `@atlas/contracts`/`zod` are TYPE-ONLY (erased), so the root
  `node_modules`/pnpm store + sibling packages stay UNREADABLE. Add a dir in `importClosureRoots` ONLY
  when the worker gains a new RUNTIME import — omission fails the boot loudly (positive-control test),
  never silent over-exposure.
- **PDF is hand-rolled on purpose** — pdf.js would widen the jail closure + nondeterminism. Targets
  classic single-generation + append-update PDFs; xref STREAMS + multi-generation are outside V1. Anything
  it can't faithfully decode ⇒ `partial-extraction`.
- **HTML charset traps**: `charset=` in `<script>`/comment/RCDATA/body, `<meta-widget>`, fake `<meta>`
  inside a quoted attr, unclosed comments — none may read as declarations; `metaCharset`'s lexical scan
  handles each (round-2/3 findings + regression tests).
- **Test strictness is OS-split** (`ATLAS_SANDBOX_REQUIRE`): `CI=true` on darwin is strict (Seatbelt runs
  on hosted macOS); Linux is opt-in strict only once cgroup delegation is provisioned — else the
  containment/D15 suites **loud-skip**, never green-skip. A provisioned host reporting unsupported is a
  hard failure (wing round-2 finding).
- **Quarantine bytes ride the fd3 control channel** base64 (≤ 1 MiB): whole output if it fits, else a
  `±4096`-char window around the first match, re-verified dirty. stderr + fd3 are independently byte-capped
  (4 MiB each); overflow is a KILL, never unbounded parent growth.

## History (real PRs)

- **#61** — Phase 0 scaffold (package skeleton + retained harness).
- **#72** (issue #29) — Task 2.3 sandboxed worker. Landed **HUMAN-LED** ("do not merge without real-host
  containment validation"), WITH known-open blockers documented in the commit (Linux seccomp allowed
  execve with no re-exec denial; FS jail mounted all of `/usr`; silent cgroup writes + no CI cgroup root;
  Seatbelt keychain undenied + unrestricted mach-lookup; darwin probes were a single allow-canary; vacuous
  scan-poll). Follow-ups in-PR: loud-skip Linux containment on stock hosted CI (keep macOS strict); make
  `doctor` sandbox-capability non-blocking unless `ATLAS_SANDBOX_REQUIRE=1`.
- **#73** (issue #30) — Task 2.4 normalizers; 7 dispatched-review findings adjudicated. The "wing
  round-2/round-3" findings cited throughout the source comments were fixed here: mandatory non-empty
  quarantine; explicit `gaps` array; single-fd bounded read (no `statSync→readFileSync` TOCTOU);
  FIFO/device/non-regular rejected; PDF `/Encrypt`+`/Root` from the ACTIVE trailer/xref chain
  (incremental-update + freed-object + name-escape + in-string decoys all rejected); indirect
  `/Font`/`/Encoding` resolution; WinAnsi via Annex-D; HTML charset only from a real `<meta>`; RAWTEXT
  close requires an exact end-tag name.

Recurring themes: (1) fail-closed everywhere — a missing primitive/unresolved path/bad override must never
weaken the jail; (2) faithful-or-reject over best-effort; (3) the "decoy" fixtures show adversarial review
drove the PDF/HTML robustness, not spec text alone.

## Open items

- **Sandbox-hardening residuals deferred to real-host human validation** (from #72's commit body — NOT a
  live open issue; #5 is the closed Phase-2 tracker, and only #60/#65 are open, neither of which is this):
  delegated writable cgroups so CI can set `ATLAS_SANDBOX_REQUIRE=1` on Linux (until then Linux containment
  loud-skips on hosted runners); full HTML tokenizer edge cases (comment recovery `<!-->`/`--!>`,
  duplicate-attr last-wins); PDF generation-aware xref completeness + WinAnsi Annex-D completeness. NOTE:
  much of what #73's commit body "carried forward" was actually fixed in the round-3 pass (indirect
  encoding, freed-object xref, divergent WinAnsi bytes) — confirm current state on a new host before citing
  any as still-open.
- **PDF xref streams + multi-generation objects** beyond the append-update convention are outside V1
  (classic `xref` tables only).
- **Auto-generated image alt descriptions are out of Phase 2** (they'd be synthesis) — a meaningful image
  with no `alt` stays a durable `image-no-alt` gap; the Tier-3 gate applies once Phase 4 enables descriptions.
- The `atlas-pdf-1` generation is an in-repo string, not a resolvable library version — its pin is by
  convention (bump `EXTRACTOR_VERSION` on ANY behavioural change), unlike `parse5` which the conformance
  test enforces against the resolved package.
