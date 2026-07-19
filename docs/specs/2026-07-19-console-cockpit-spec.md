# SP-2 — Atlas Console cockpit (SwiftUI macOS)

> Slug: `docs/specs/2026-07-19-console-cockpit-spec.md`. Third and final spec of the Console arc. SP-1 (`brain watch` stream) and SP-3 (`atlas-signer` Secure-Enclave signer) are merged and are this spec's binding upstream contracts. This document conforms to the nine-section Spec Contract.

## intent — Intent & Soundness

**Problem.** An operator running a single local Atlas install has no cockpit. Every read is a hand-typed `brain … --json` in a terminal; every privileged mutation is a three-command `--export-challenge` → sign → `--authorization` dance the operator assembles by hand. SP-1 shipped a live change stream (`brain watch --json`) and SP-3 shipped the only sanctioned signing path (`atlas-signer` over the Secure Enclave), but nothing ties dashboard, jobs, audit timeline, and the privileged flow into one face.

**Design.** A SwiftUI macOS app — **Atlas Console** — that is (1) a pure **read-face** over `brain watch --json` plus the read-class `--json` command surface, and (2) a **privileged-flow driver** that renders an authorization challenge, shells out to `atlas-signer`, and re-invokes `brain … --authorization <path>`. The Console:

- **Never** opens a broker socket, holds a credential, imports an atlas internal package, or renders its own Touch ID / signing prompt.
- Consumes only the two public process contracts: `brain` (SP-1 stream + SP-2's read commands) and `atlas-signer` (SP-3).
- Treats any capability gap as an **atlas-side additive PR** (a new event type or read command), never a workaround in Swift (SP-1 §15).

**Why this approach over alternatives.** The alternative — a Console that talks to the broker sockets or reads the SQLite/LanceDB projections directly — would duplicate the security kernel's trust boundary in an unprivileged GUI process and re-derive state the CLI already owns. Reusing the two existing public process contracts means the Console adds **zero new trust surface**: it is exactly as privileged as a terminal, and the broker's fail-closed authorization is unchanged. Trade-off accepted: all reduction, coalescing, and rendering happen consumer-side, and detail-on-demand costs a `brain` subprocess spawn rather than a shared-memory read. For a single-operator human dashboard at a 500 ms poll cadence, that cost is irrelevant (SP-1 §9.1).

**Scope tier (anti-inflation anchor).** Console is a **single-user, single-machine, local playground-tier app** that faces a **production-grade security kernel**. The kernel's hardening (privilege separation, WORM ledger, fail-closed scan) is upstream and unchanged; the Console inherits it by construction. Absence of multi-user auth, HA, remote access, or 10× scale in the Console is **correct restraint**, declared in `scope`. Where the Console touches the production kernel — the privileged-flow UX and the audited-read cadence rule — it is held to the kernel's standard.

**Assumptions (stated, load-bearing).**
- Daemons (`atlas-broker`, `atlas-egress`) run as **launchd system services surviving reboot** (PR #206). The Console assumes boot-persistent daemons and treats reachability as a signal, not a lifecycle it manages.
- The operator has provisioned and enrolled a signer (SP-3 `provisioning/enroll-signer.sh`); the Console surfaces the enrollment runbook but never runs `sudo`.
- `brain` and `atlas-signer` are built-from-source on the same machine (no Gatekeeper friction; ad-hoc-signed).

**Success criteria (objective).** An engineer can determine the spec is implemented iff:
1. The Console decodes **all 8 SP-1 event types** from the `watch.schema.json` `examples` (used directly as decoder fixtures) with zero decode errors, and ignores an injected unknown `event` value.
2. Dashboard, jobs, audit-timeline, model-call-activity, and privileged-flow surfaces render from live stream + read commands against a real local install.
3. A full **export → sign → authorize** round trip completes against a live broker for at least one privileged op, and correctly re-exports (never retry-submits) after a simulated broker restart voids the nonce.
4. The Console **never spawns an audited read on a timer** — verified by a test asserting the only periodic subprocess is `brain watch`.
5. The **CI Swift compile job** (SP-2 owns it, SP-3 R5) is green on `macos-15`.

## scope — Scope & Boundaries

Console lives in-repo at **`console/`** (outside the pnpm workspace globs), as one or more Swift Packages, **build-from-source, entitlement-free, ad-hoc-signed** — the same posture as `console/signer/` from SP-3. SP-2's CI owns the Swift compile job.

**In V1 (normative).**

| Area | What ships |
|---|---|
| Dashboard / status | Health cockpit built from `watch.hello.snapshot` + live events: open runs, jobs {queued, failed}, quarantine count, backup {watermark, covered, healthy}, audit head + anchor, daemon reachability. |
| Jobs | List view fed by `jobs list --json` (detail) + coalesced `job` events (live state). |
| Audit timeline | Seq-ordered timeline of **run.\*-space** `audit` events; cursor persistence + `--since-seq` resume; anchor/verify status surfaced on demand. |
| Model-call activity | Live `model_call` event feed (insert-only, no history — SP-1 R2). Session-scoped only. |
| Banners / badges | Backup-unhealthy + restore banners, quarantine badge, evidence-retry badge (high-space signals), daemon-down indicators, "service not installed" empty state. |
| Privileged flow | Display challenge → shell to `atlas-signer` → `brain … --authorization`. Covers the full authorizable-op set (derived, not hardcoded — see `open-questions`). |
| Detail-on-demand | Read-class `--json` commands invoked on user focus/action (`note show`, `git review`, `jobs list`, `git status`, `index status`, …). |
| Egress-gated actions | `query` and `index eval` behind explicit user action, with `ATLAS_EGRESS_CAPABILITY_KEY`. Never polled. |
| Process config | `brain`/`atlas-signer` path resolution, `--config`/cwd/env spawn contract, settings persistence. |

**Out of V1 (normative — deferred, with the trigger that would revive each).**

| Deferred | Why / what it needs |
|---|---|
| **Signer settings / enrolled-signer list view** | Needs SP-3 R3 `brain authz signers --json` (a one-row phase-6 registry addition). Operator decision: **do NOT trigger the R3 addition in SP-2.** Revive when a settings view is the first real need. |
| **Model-call history view** | SP-1 R2: no history read command exists. Needs a future additive `--json` read command (e.g. `model calls list`). |
| **Daemon lifecycle management** | launchd owns start/stop/keepalive (PR #206). Console shows reachability + the install runbook, never `launchctl`. |
| **Vault-file-change / fs-watch events** | SP-1 R1: no such events. File views poll `git status --json` / `note show --json` on focus. |
| **Schema-derived egress-minting set** | No machine-readable registry field today. V1 uses a pinned constant + drift test (see `ssot`); revive on the additive `x-atlas-contract` field PR. |
| **Multi-install / remote / multi-user** | Charter: single operator, single machine, 1–2 concurrent watchers. |
| **Stream secret redaction** | SP-1 operator deferral; revisit only if a shared consumer appears. |
| **Any write not routed through the signer flow** | The signer is the only signing path (SP-3). No `--yes`-driven privileged mutation. |

**Not built:** no generic plugin surface, no scripting/automation layer, no config editor for `brain.config.yaml`, no daemon installer UI. These solve no stated V1 use case.

## interfaces — Interfaces & Contracts

Two subprocess contracts (`brain`, `atlas-signer`), one local settings/cursor store. **Strict parsing against the published schemas; no defensive parsing.** `x-atlas-contract` blocks are normative API docs.

### 1. `brain` binary resolution (`brainPath`)

Resolution order, **first hit wins, no silent fallthrough past an explicitly configured value**:

1. Explicit path in Console settings.
2. `ATLAS_BRAIN_PATH` env var.
3. Repo-layout default derived from the configured Atlas checkout: run `node <atlasRoot>/apps/cli/dist/bin.js` with `ATLAS_ROOT=<atlasRoot>`.

If the source that hit is missing / non-executable / fails the probe, the Console enters a **blocking "brain unavailable" error state** naming the failing path + remediation; it does **not** try the next source. **Validation probe** = spawn `brain db status --json` (a `pure` command — no ledger row; never probe with an audited read like `status`) and require **exit 0 + schema-valid output**. Re-probe **on settings change and on Console launch only**.

`atlas-signer` path resolves analogously (settings → `ATLAS_SIGNER_PATH` → `<atlasRoot>/console/signer` build product), with its own blocking error state. Probe = `atlas-signer pubkey` (no SE access, prints SPKI PEM) exit 0.

### 2. Spawn contract (how the Console runs `brain`)

- **cwd / config:** the Console MUST either spawn with `cwd = <atlasRoot>` **or** pass `--config <atlasRoot>/brain.config.yaml`. Config resolution: `--config` wins, else `<cwd>/brain.config.yaml`, then `ATLAS_*` overrides, then strict Zod (12 required sections). Getting cwd/config wrong is a load-bearing failure (exit 2).
- **`--vault` is not parsed by the router** (it appears in schema `commonFlags` but is inert) — vault location is `vault.path` in `brain.config.yaml`. The Console never passes `--vault` and never re-derives the vault path.
- **`ATLAS_ROOT`** exported when off the repo layout (packaged install fails exit-4 without it; root discovery walks up for `commands.json`).
- **`ATLAS_EGRESS_CAPABILITY_KEY`** exported **only** for `query` / `index eval`. Never for any other command; never logged.
- Router globals available: `--json --plain --no-color --quiet --verbose --config <path>`. The Console always passes `--json`.

Representative invocations:

```
# stream (the one long-lived, periodic subprocess)
brain watch --json --poll-ms 500 --heartbeat-seconds 30 [--since-seq <cursor>]
brain watch --json --once                       # one hello, exit 0 — attach baseline
# read-on-focus (spawned per user action, never on a timer)
brain jobs list --json --limit 50
brain note show --json <id>
brain db status --json                          # also the brainPath probe
# egress-gated (explicit user action only, key in env)
brain query --json "<q>"
```

### 3. `brain watch --json` stream (SP-1 SSOT — decode contract)

- **NDJSON**, one object per `\n`-terminated line, UTF-8, no BOM. Blocking writes with per-line flush — nothing dropped for a slow consumer.
- Every event line carries `v: 1` (const; additive event types do **not** bump it), `event` (discriminator), `at` (RFC-3339 ms UTC).
- First success line is always `watch.hello`. The **one** non-event line is the standard error envelope (sole line on startup failure, or final line on mid-stream fatal — never interleaved, at most one).
- **Consumers MUST ignore unknown `event` values.** Optional fields are **omitted, never null** — decode with optionals, never expect `null`.
- Both free-text fields (`job.lastError`, `watch.error.message`) arrive already escaped over C0 **and** C1 (`U+0000–U+001F`, `U+007F–U+009F` → `\uXXXX`) — decoded Swift strings are terminal-/display-safe as delivered.

**Swift model** — a `WatchEvent` enum with 8 cases (associated payload structs), decoded by the `event` discriminator, falling through to an `.unknown(raw:)` case for forward compatibility:

| case | required payload | optional |
|---|---|---|
| `.hello` | `pid`, `ledger{attached,path}`, `snapshot`, `config{pollMs 100–10000, heartbeatSeconds 5–300}` | `resume{auditHeadSeq ≥ −1}` (absent while detached), `replay{sinceSeq ≥ −1, events ≥ 0}` (iff `--since-seq` AND attached) |
| `.heartbeat` | `ledger{attached,path}` | `resume` (absent while detached) |
| `.watchError` | `source ∈ {ledger,broker,egress,internal}`, `code`, `message` | — |
| `.job` | `jobId, workflow, state ∈ {pending,running,succeeded,failed,cancelled}, attempts, maxAttempts, updatedAt` | `nextRunAt` (absent when terminal), `lastError`. **Coalesces** per tick. |
| `.modelCall` | `callId, runId, provider, model, operation, inputTokens, outputTokens, costMicros, createdAt` | — . Insert-only, **no replay**. |
| `.audit` | `seq ≥ 0, runId, eventType` (14-value enum, drift-pinned to DDL), `createdAt` | `gitHead`. Never coalesces. |
| `.backup` | `watermarkSeq ≥ −1, healthy, updatedAt` | `lastBackupAt`. Coalesces. |
| `.daemon` | `daemon ∈ {broker,egress}, socketPath, reachable, previousReachable` | — . Transition-only. |

`hello.snapshot` = `status --json` shape **plus** `daemons {broker, egress}` each `{socketPath, reachable}`. Ledger-derived keys are **absent when detached** (never fabricated zeros): `openRuns`, `jobs{queued,failed}`, `quarantineCount`, `backup{watermarkSeq,coveredSeq,healthy}`, `audit{headSeq,head,anchorOk,anchorSource ∈ {git, sqlite-only}}`.

**Flags / exit codes (watch):** `--json` required; `--since-seq <n ≥ −1>` (exclusive `seq > n`; `−1` = from row 0; mutually exclusive with `--once` ⇒ exit 5); `--once`; `--poll-ms` (default **500**, 100–10000); `--heartbeat-seconds` (default **30**, 5–300). Exits: `0` (`--once` done / SIGINT / SIGTERM / EPIPE — detach is success, never 141), `2` (startup config/vault), `4` (internal / broker protocol fault — unreachability is data, not an error), `5` (usage). No 1/3/6/7. A **mid-stream fatal** exit (2/4/5) emits the single error-envelope line last, carrying `retryable` — the Console's restart gate (§behavior) branches on it.

### 4. Read command contracts

Each read command: spawn → read one JSON object on stdout → **validate against its `schemaRef`** (strict). The 25-command read surface (17 `read` + 4 `audited-read` + 4 `pure`) is inventoried **at runtime by `executionClass`** from the schemas — the Console never trusts a prose command list. `jobs list --json` post-#205 returns `{command, jobs[], pagination{limit 1..500, offset, total, hasMore}}`, ordered `createdAt desc` tiebreak `jobId`, `--limit` default 50 max 500.

### 5. Error envelope (client parser)

`error-envelope.schema.json`, `unevaluatedProperties: false`. Required: `code` (stable discriminator; composites like `locked:<scope>`, `authz.<reason>`), `message`, `hint`, `retryable`. Optional: `details` (structured — read `field`/`path`/`location`, **never parse `message` for data**), `errors[]`, `retryAfterMs`, `runId`, `jobId`.

**Rule: branch on `retryable` + `retryAfterMs`, never on the exit code.** Some schemas still nominally enumerate a `7`; retryability rides the envelope flags at exit 4/6. The sole real exit-7 is the `jobs run` batch aggregate (`{command, items[], aggregate}`) — the Console does not drive batch commands in V1, so it need not parse the aggregate envelope.

### 6. Two exit-code namespaces (kept separate in Swift)

| | `brain` | `atlas-signer` |
|---|---|---|
| 0 | ok | signed |
| 1 | validation | internal fault |
| 2 | config/vault/lock | malformed/invalid challenge (incl. re-derivation mismatch) |
| 3 | secret-scan | expired `expiresAt` (checked before prompting) |
| 4 | internal | user cancelled / biometry failed |
| 5 | usage | key invalidated by biometry re-enrollment |
| 6 | action-required | — |
| (7) | `jobs run` aggregate only | — |

Two distinct Swift interpreters. A `brain` exit code MUST never be read against the signer table or vice-versa.

### 7. `atlas-signer` challenge/response (SP-3 SSOT)

`atlas-signer sign` reads one `AuthorizationChallenge` JSON on **stdin**, emits one `AuthorizationResponse {schemaVersion:1, challenge, signature:"p256:…", signerId}`. **Channel contract the Console parses:** summary + diagnostics always → **stderr**; no `--out` ⇒ response is the only **stdout** content on success, **stdout empty on failure**; with `--out` ⇒ file-only (`0600`, refuses existing without `--force`), stdout empty always. Exactly one destination.

**Console MUST display** (control-character-safe: length-bounded, quoted, C0/ANSI made visible): `op`, `runId`/`targetCommit` when present, `canonicalBaseCommit`, every `intendedEffect` field, `expiresAt`, and the **SHA-256 of `signingPayload`**. The signer re-derives `signingPayload` from these fields and refuses **exit 2** on mismatch *before prompting* — bytes signed are provably bytes shown; broker recompute (`authz.payload_mismatch`) is the second backstop. `signingPayload` shape (§8.2): `atlas.authz.v1\n<op>\n<runId|->\n<targetCommit|->\n<canonicalBaseCommit>\n<nonce>` + op-specific `intendedEffect` commitment lines.

### 8. Authorizable-op set (which ops drive the signer flow)

The set of ops that require the export→sign→authorize flow is **read at runtime from the registry `privilege` field in `docs/specs/cli-contract/commands.json`** — the same registry §4 already reads for `executionClass`. Any command whose `privilege` marks it as requiring broker authorization is in the set; the Console builds the set at launch by scanning the registry, **never** from a hardcoded Swift list. This is the sole authority (see `ssot`). The broker's runtime **exit 6 (`action-required`)** is the **fail-closed backstop** — if the Console ever mis-derived the set, the broker still refuses the un-authorized mutation — not a second classification authority. (One known atlas-side data discrepancy affecting this field is tracked in `open-questions`; the Console consumes whatever the registry says and does not arbitrate it.)

### 9. Local store (Console-owned data model)

Single-user local state, two stores, both **finalized** here:

- **Settings** live in `UserDefaults` (standard suite, plist-backed) — small, flat, human-editable-in-a-pinch.
- **Cursors** live in a **single SQLite database** at `~/Library/Application Support/com.atlas.console/console.sqlite` (created `0600`), one table `ledger_cursor`. SQLite (not a plist) because the cursor is written on a hot path (the post-replay checkpoint heartbeat) and benefits from a transactional single-row upsert.

| entity | fields | notes |
|---|---|---|
| `Settings` (`UserDefaults`) | `atlasRoot: String`, `brainPathOverride: String?`, `signerPathOverride: String?`, `pollMs: Int? (100–10000)`, `heartbeatSeconds: Int? (5–300)`, `egressCapabilityKeySource: enum{env, keychain}`, `resumeMode: enum{resume, replayAll, liveOnly} (default resume)` | one blob; `null`/absent override ⇒ use resolution order. `resumeMode` selects the attach strategy (§behavior). |
| `ledger_cursor` (SQLite) | `incarnation_key TEXT PRIMARY KEY`, `audit_head_seq INTEGER NOT NULL DEFAULT -1`, `updated_at TEXT NOT NULL` (RFC-3339) | one row **per ledger incarnation**; `−1` = nothing checkpointed yet. **Sole owner of resume state** (see `ssot`). See the `incarnation_key` derivation below. Writes are single-writer (the reducer checkpoint), wrapped in a transaction; an unseen `incarnation_key` creates a fresh row at `−1`. |

**`incarnation_key` derivation (finalized, deterministic today).** `incarnation_key = SHA-256 of the absolute `ledger.path`` carried in the attaching `watch.hello` — a **required, Zod-validated** field present on every `hello`/`heartbeat` (`ledger{attached,path}`), and the one incarnation identifier that is both available and deterministic without any atlas-side change. It is **stable across a Console/process restart** (same ledger path) and **distinct across a broker re-clone to a fresh path** (the live-drive runbook mandates a fresh clone directory per incarnation). The one residual edge — a re-clone to the **same path** with a fresh anchor (fresh ledger, seq 0) — does **not** silently reuse the stale cursor: resuming `--since-seq <staleHigh>` against a fresh low ledger yields `replay.events: 0` with `resume.auditHeadSeq < n`, which fires the **stale-cursor → re-baseline** path (§behavior), creating correct fresh state. **Binding the key to a stable audit-anchor *genesis* identity** (distinguishing a same-path re-clone without relying on that re-baseline net) requires an atlas-side additive `hello.snapshot` field that SP-1 does not emit today (e.g. the audit-ref root-commit hash) — deferred, tracked as `open-questions` #5.

The `keychain` egress-key source (§security) reads an **external, operator-owned** Keychain item — it is not part of this Console-owned store and the Console never writes it.

## behavior — Behavior & Correctness

### Attach → resume (the sequence a client gets wrong first)

1. On launch (after `brainPath` probe passes), spawn `brain watch --json --once` → read exactly one `hello` → exit 0. Use its `snapshot` to paint the dashboard and read `resume.auditHeadSeq` (absent ⇒ detached).
2. Choose the resume point from **`Settings.resumeMode`** (§interfaces §9, default `resume`):
   - **`resume`** — look up the persisted `ledger_cursor` row for this incarnation. If present and `≥ 0`, spawn the live stream with `--since-seq <audit_head_seq>`. If the incarnation is unseen (no row) or the cursor is `−1`, spawn **live-only** (no `--since-seq`) — a large existing ledger is not replayed on first sight.
   - **`replayAll`** — spawn with `--since-seq -1` (full run-space replay from row 0).
   - **`liveOnly`** — spawn with no `--since-seq` (live events only); the cursor is still checkpointed so a later switch to `resume` works.
3. Live stream runs at the 500 ms poll cadence — **the only periodic subprocess.**

**Any `watch.hello` ⇒ full re-baseline.** All dedup/cursor state is per-ledger-incarnation; re-attach may legitimately re-issue seen `seq`s (`seq` is the idempotency key). On re-baseline: clear in-memory reducer state, rebuild from the new `snapshot`, re-establish the cursor.

### Audit reducer — run.\*-space only (invariant)

Two disjoint `audit_events.seq` spaces: `run.*` rows gapless from **0**; every non-`run.%` kind (3 `db.*` + `evidence.retry_enqueued`) allocates from **`DB_EVENT_SEQ_BASE = 10¹²`**.

- The reducer accepts an `audit` event **into the timeline iff `seq < DB_EVENT_SEQ_BASE`**. Only those events advance the displayed audit head and the persisted cursor.
- High-space events (`db.backup`, `db.restore`, `db.force_unblock`, `evidence.retry_enqueued`) are **live-only signals**: routed to their own surfaces (restore/backup banners, `force_unblock` notice, evidence badge). They **never** enter the run timeline, **never** advance head or cursor, **never** persist as resume state.
- Stated invariant, holding under any interleaving: **`displayedAuditHead == max contiguous run.*-space seq observed`**, unaffected by any high-space event.
- Order the timeline **by `seq`, not by line arrival** — line order ≠ seq order across batches (late commits). A gap in the run-space prefix is a **pending intent**, never pruning.

### Replay + cursor checkpoint

- Replayed rows arrive as ordinary `audit` lines immediately after `hello`, strict seq order, then a **`watch.heartbeat`** carrying the first safe-to-persist post-replay cursor (`hello.resume.auditHeadSeq` during replay is `min(n, prefix)` — do not persist it until the checkpoint heartbeat).
- `resume.auditHeadSeq` is the **contiguous-committed-prefix** high-water mark (NOT `snapshot.audit.headSeq`, NOT max-emitted). At-least-once across restarts; exactly-once per incarnation.
- **Stale cursor = cursor-above-head only** (post-`db restore` rewind): the stream returns `replay.events: 0`; the consumer detects `resume.auditHeadSeq < n` and **re-baselines**. There is no pruning path in V1 and no `earliestAvailableSeq` field.

### Coalescing + ordering

Per-source only; fixed per-tick source order `audit, model_call, job, backup`. `job` and `backup` coalesce (latest state per id, kubectl-MODIFIED semantics); `audit` and `model_call` never coalesce. **Never infer cross-source causality from line order.**

### Detach / attach / daemon transitions

- Ledger absent/unmigrated at startup is **not an error**: the stream runs detached (`ledger:{attached:false}`, no `resume`), re-probes each tick, emits a fresh `hello` on attach (a pending `--since-seq` executes against the first attached ledger). The Console shows a **detached** state, not an error.
- Mid-stream vault vanish/replace → `watch.error(source:"ledger")` → the Console shows a transient re-attach state and awaits the fresh `hello`.
- `daemon` events (transition-only, probed at heartbeat cadence + once at start) drive reachability indicators. Broker unreachable also surfaces as `anchorSource:"sqlite-only"` (degraded anchor verdict). Egress unreachable is `daemon`-only. `backup-unhealthy` **never** blocks watch — it streams as `backup{healthy:false}` and paints a banner.
- "Service not installed" (no socket, never reachable) is a distinct **empty state** pointing at the PR #206 install runbook — not a lifecycle control.

### Fail-fast posture (no silent fallbacks)

- `brainPath` probe failure ⇒ blocking error state naming the path + remediation. No fallthrough (§interfaces).
- **Watch subprocess exit ⇒ gated restart, never blind retry.** Classify the exit before doing anything:
  - **Clean detach** — exit 0 (EPIPE / SIGTERM / SIGINT). Not a failure; no restart, no error surface.
  - **Non-retryable fault** — exit **5** (usage: a malformed invocation is a Console bug that will never self-heal), exit **2** (config / vault / lock: needs operator action, will not fix itself by respawning), **or** exit **4** whose final error-envelope line carries `retryable: false`. ⇒ **terminal "watch failed" error state** naming the exit + the envelope `code`/`hint`; **zero restarts** (fail-fast). This is distinct from a *detached* ledger, which is exit-0 streaming data and never exit 2.
  - **Retryable fault** — exit **4** whose final envelope carries `retryable: true`, or a dropped stream that produced no envelope line. ⇒ restart under the backoff + cap below.
  - **Backoff policy** (the single definition; the constants are proposed defaults tracked for tuning in `open-questions`): **initial delay 500 ms, ×2 per successive attempt, capped at 30 s, ±20 % jitter**; when the envelope carries `retryAfterMs`, use it as a **floor** for the next delay. The delay **and** the consecutive-failure counter **both reset** on the next successful `hello`.
  - **Terminal condition (the fail-fast backstop):** after **`WATCH_MAX_CONSECUTIVE_FAILURES = 6`** restart attempts with **no** intervening successful `hello`, stop retrying and enter the terminal "watch failed" error state — the Console does **not** spin forever on a persistent fault. A single `hello` between failures resets the counter to 0, so genuinely-transient blips never trip the cap.
  - **User-visible retry state:** attempt count, next-retry time, and the last exit/`code` are **surfaced to the user** (a retry banner), never a silent loop; the next `hello` re-baselines and clears it.
- **Broker restart voids the nonce** (128-bit, TTL 300 s, single-use, in-memory; enrollment restarts the broker). A privileged flow spanning a restart MUST **re-export a fresh challenge, never retry-submit** a signed authorization. `authz.nonce_expired` / `nonce_unknown` (exit 6/1) ⇒ drop the stale authorization, re-run `--export-challenge`.

### Privileged-flow state machine

```
Idle → Export (brain … --export-challenge, exit 6 mints challenge.json)
     → Display (render challenge fields, control-char-safe; user confirms)
     → Sign (atlas-signer sign < challenge.json; branch on signer exit 0–5)
     → Authorize (brain … --authorization authorization.json)
     → Done | Retry(re-export) | Failed
```

- Signer **exit 3** (expired) / any broker `authz.*_expired`/`_unknown` ⇒ back to **Export** (never resubmit).
- Signer **exit 4** (cancel/biometry fail) ⇒ back to Idle, no state change.
- Signer **exit 5** (key invalidated by re-enrollment) ⇒ surface the SP-3 re-enroll runbook (`keygen --force` → enroll `-v(N+1)` → revoke old); Console runs no `sudo`.
- Idempotent replay of a completed op returns `authz.ok` + `noop:true` — render as success, not error.
- Egress-minting actions (`query`, `index eval`) are their own explicit user actions with the capability key in env; **never** entered on a timer.

### Cadence rule (load-bearing)

**Poll `watch` (500 ms). Never poll an audited read.** `status`, `inspect`, `graduation audit`, and `query` are `audited-read` — each executed run writes a `run.readonly` ledger row (and `query` additionally writes `retrieval_runs`/`retrieval_results` + fires a post-run backup + costs egress budget). Polling them grows the audit ref and the ledger. Read commands run **only on user focus/action**. `pure` commands (`db status`, `db verify`, `doctor`, `validate`) are safe even when the backup watermark blocks writes.

### Observability

Console logs to the standard macOS unified log (`os.Logger`, subsystem `com.atlas.console`) at info for state transitions and error for probe/spawn/decode failures. Every spawned `brain`/`atlas-signer` invocation logs argv **sanitized per the §security argv-classification rule** (structural argv, flags, and enumerated/ID operands logged; the egress key rides env and is redacted; user-supplied free-text operands — notably the `query` search string — are elided, never logged verbatim) + exit code. No `brain` stderr is swallowed — it is captured and shown on the relevant error surface. This is self-debugging level, not SRE dashboards (playground tier).

## ssot — Single Source of Truth

Every value/rule has one owner; the Console **consumes**, never re-derives.

| Value / rule | Authoritative owner | Console behavior |
|---|---|---|
| Command membership / phase / privilege / executionClass / idempotency | `docs/specs/cli-contract/commands.json` + per-command `*.schema.json` (`x-atlas-contract`) | Read at runtime by `executionClass`; never hardcode a command list. |
| Event shape + seq/resume semantics | `watch.schema.json` (SP-1) | Decoder validated against its `examples` fixtures; no hand-authored event shape. |
| Vault location | `vault.path` in `brain.config.yaml` | Never re-derive; never pass `--vault`. |
| **Privileged-op set (which ops need the signer flow)** | **Registry `privilege` field in `commands.json` — sole authority** | Built at launch by scanning the registry `privilege` field (§interfaces §8); never hardcoded. Broker runtime **exit 6 is a fail-closed backstop, not a second authority**. The prose-vs-code `git refresh` discrepancy is an **atlas contract-drift bug to file** (contract-lint binds each schema's `privilege` to its registry row) — the Console does **not** arbitrate it at runtime; it consumes the registry field as-is. |
| Exit-code → meaning maps | `brain` EXIT set (0–6, +7 aggregate) and `atlas-signer` (0–5), each in its own schema/contract | Two separate Swift interpreters; parse `retryable`/`retryAfterMs`, not the code. |
| Error codes per command | each schema's `x-atlas-contract.errorCodes` | Consume; never parse `message` for data. |
| Resume cursor | Console `ledger_cursor.audit_head_seq` (sole owner) | `displayedAuditHead` is **derived** from the reducer, checkpointed into the cursor at the post-replay heartbeat. One writer. |
| Watch restart-backoff constants, retryability gate, `WATCH_MAX_CONSECUTIVE_FAILURES`, & `resumeMode` default | This spec's `behavior` section (single definition) | Not duplicated elsewhere; `open-questions` tracks the tunable constants, referencing these values. |
| `signingPayload` bytes | `atlas-signer` re-derivation (+ broker recompute backstop) | Console **displays** the fields + payload SHA-256; never computes the signature or the payload it signs. |

**One honest exception — the egress-minting set.** No machine-readable registry field exists today. V1 pins `{query, index eval}` in **one named Swift constant** `EgressMintingCommands`, documented as a **temporary mirror** of `apps/cli/CLAUDE.md`'s mint-bearing list, guarded by a **named drift test** (`egressMintingConstantMatchesSchemas`) that fails once an authoritative schema field exists and disagrees. **Atlas-side follow-up (recorded, Out-of-V1):** add a boolean `mintsEgressCapability` to `x-atlas-contract` in the relevant command schemas + registry lint (an additive one-field contract PR); after it lands, the Console derives the set from schemas and **deletes the constant**. V1 does **not** claim schema-derivation for this set.

## security — Security & Trust

**Trust model.** The Console runs as the **operator** (not `atlas-agent`), unprivileged. Its entire attack surface is two subprocess spawns. It **holds no credential, opens no broker socket, imports no atlas internal, and reads no projection store directly.** It is exactly as privileged as the operator's terminal — it adds no trust surface to the security kernel.

**Signing path.** `atlas-signer` is the **only** signing path (SP-3). The Console **never** renders a Touch ID prompt, never touches key material, never constructs a `signingPayload`. A Console that did any of these is rejected by SP-3's contract. The Console's job in the privileged flow is **display fidelity + process orchestration**, nothing cryptographic.

**Challenge display (the one real Console security duty).** The Console renders the challenge fields the operator approves. Rendering is **control-character-safe**: every displayed field is length-bounded, quoted, and has C0/ANSI sequences made visible — a challenge cannot smuggle terminal-control or spoofing bytes through the GUI. The signer's pre-prompt re-derivation (exit 2 on mismatch) guarantees the **bytes signed are the bytes derived from the displayed fields**; the broker recompute (`authz.payload_mismatch`) is the second backstop.

**Inherited threat honesty (SP-3).** One biometric per signing **burst**, not per signature. A **spoofed display** can get a legitimate-but-misunderstood challenge approved — it can never cause a *different* effect than the one committed in `signingPayload`, because the signer re-derives and the broker recomputes. The Console does not close the spoofed-display gap and does not claim to; it inherits SP-3's honesty.

**Secret handling — the egress capability key.** `ATLAS_EGRESS_CAPABILITY_KEY` has two operator-selected sources (`Settings.egressCapabilityKeySource`), **both read-only to the Console**:

- **`env`** — inherited from the operator's process environment. The Console does not store it; it passes through what the operator's shell already holds.
- **`keychain`** — read (never written) from a **pre-existing, operator-provisioned macOS Keychain generic-password item** that is **external, operator-owned storage**. Access/storage contract:
  - **Item identity:** service `com.atlas.console.egress-capability-key`, account = the operator's login name.
  - **Provisioning:** created **out-of-band by the operator** (the enrollment runbook / `security add-generic-password`) with accessibility class `kSecAttrAccessibleWhenUnlocked` (readable only while the login keychain is unlocked). The Console **never** creates, updates, or deletes it — no `SecItemAdd`/`SecItemUpdate`/`SecItemDelete`, only `SecItemCopyMatching`.
  - **Access:** read **on demand, once per `query`/`index eval` spawn**; the plaintext is held **in process memory only for that spawn's lifetime**, injected into the child env, and dropped after the child exits. It is never cached across spawns and never survives Console exit in Console-owned storage.

In both cases the key is injected into the child env **only** for `query`/`index eval`, **never** for any other command, and **never logged** (argv/env logging redacts it). **"The Console never persists the key" means the Console performs no write of the key to any store it owns** — not the `UserDefaults` settings, not the cursor SQLite, not the unified log. Reading the operator-owned Keychain item does **not** contradict that rule: the Console only *reads* external storage the operator created and manages; it persists nothing itself. No other secret is handled.

**Log sanitization — argv classification (mandatory).** The Console logs every subprocess invocation for self-debugging, so its own unified-log stream is a **data sink** and is classified accordingly. Argv is logged under an **allowlist**, never verbatim:

- **Loggable (structural / non-sensitive):** the binary path, the command/subcommand tokens, flag *names*, enumerated flag *values*, and structural / ID operands — e.g. `jobId`, note `id`, `--limit`, `--since-seq`, `--poll-ms`, `--heartbeat-seconds`, `--config <path>`. These carry no user content.
- **Redacted (sensitive):** any **user-supplied free-text operand** — most importantly the `query` search string (`brain query "<q>"`), which can carry arbitrary operator content — is replaced in the log with a fixed placeholder + byte length (`<redacted:query len=NN>`), the same posture applied to the capability key. Free-text operands are classified by their command's argument contract (the `query` positional is the one such operand in the V1 command set), not by heuristics on the value.

This keeps the Console's own logs to **allowlisted metadata only**, matching the stream's no-content rule (see **Data classification**): note text, query text, and job payloads never reach the unified log or any Console-owned store. The classification is a fixed, per-command mapping — a command whose argument contract grows a new free-text operand must be added to the redaction list before it is logged.

**Data classification.** The stream and read surfaces emit **allowlisted metadata only** — never note content, job payloads, or model text (SP-1). Free-text fields (`job.lastError`, `watch.error.message`) arrive C0/C1-escaped. There is no PII beyond what `brain` chooses to emit; the Console adds no new sink beyond its own log, which is held to the same allowlist (above).

**Executable trust.** `brainPath`/`signerPath` are operator-configured executables the Console spawns. Single-user local posture: the Console trusts the binaries it is pointed at (the probe checks liveness/schema-validity, not authenticity). This is proportional — the operator owns the machine and built the binaries from source. Adversarial binary-substitution defense is **out of scope** (declared, playground tier).

**Fail-closed.** No credential, no socket, no `--yes` path to a privileged mutation. Every privileged effect goes through export → sign → authorize; missing authorization ⇒ broker exit 6. The Console cannot bypass the kernel.

## test-plan — Test Plan

**Types:** Swift unit (decoders, reducers, resolution), contract (against atlas schemas/fixtures), and a manual/E2E live-drive checklist against a real install. CI owns the **Swift compile job** (`macos-15`, SP-3 R5) — build + run the compile-safe suites. **No Secure Enclave in CI** (macOS runners are Virtualization.framework VMs): SE paths use **software P-256 fixtures**; SwiftUI views compile and run but never exercise the SE.

| # | Test | Break it catches |
|---|---|---|
| 1 | **Decoder ⨯ all 8 event types** from `watch.schema.json` `examples` (attached + detached hellos). | A payload field renamed/retyped upstream; a `null` where the contract says omitted. |
| 2 | **Unknown-event tolerance** — inject `{"v":1,"event":"watch.future","at":…}`. | Decoder crashing on a future additive event instead of ignoring it. |
| 3 | **Mixed-space fixture** — an NDJSON stream interleaving run.\*-space `audit` with **all four** high-space kinds in adversarial orders (high-space first; interleaved; high-space last; high-space **between a replay window and its checkpoint heartbeat**). Assert: (a) timeline holds only run.\*-space rows in seq order, (b) displayed head/cursor never moves on a high-space event, (c) banners/badges fire for each high-space kind, (d) a subsequent `--since-seq` resume built from the persisted cursor is unaffected. Seed from schema `examples`. | A high-space `db.backup`/`restore`/`force_unblock`/`evidence.retry` corrupting the audit head or cursor. |
| 4 | **Coalescing** — repeated `job`/`backup` for one id collapse to latest; two `audit`/`model_call` never collapse. | Timeline losing events or a stale job state sticking. |
| 5 | **Resume/replay** — cursor selection per `resumeMode`, pre-replay `min(n,prefix)` not persisted until the checkpoint heartbeat, `--since-seq` exclusivity. | Persisting an unsafe cursor mid-replay ⇒ a gap on next resume. |
| 6 | **Stale-cursor re-baseline** — `replay.events:0` + `resume.auditHeadSeq < n` ⇒ full re-baseline (also covers the same-path re-clone edge of §interfaces §9). | Silent divergence after a `db restore` rewind or a same-path re-clone. |
| 7 | **Re-baseline on any `hello`** — dedup/cursor state cleared, snapshot rebuilt. | Ghost state from a prior incarnation after re-attach. |
| 8 | **Detach/attach** — detached `hello`/`heartbeat` (no `resume`, no fabricated zeros) → attached `hello`; `watch.error(ledger)` → re-attach. | Rendering `0` for absent ledger-derived keys. |
| 9 | **Daemon transitions** — `daemon` events flip reachability; `anchorSource:"sqlite-only"` degraded; "service not installed" empty state. | Treating broker-unreachable as a fatal error. |
| 10 | **Privileged flow — both exit namespaces.** Drive export→sign→authorize with **software-P-256** fixtures; assert `brain` 0–6 and `atlas-signer` 0–5 are interpreted by the correct table. Include signer exit 3/4/5 branches and broker `authz.*` exit-6 handling. | Reading a signer exit code against the `brain` table. |
| 11 | **Broker-restart voids nonce** — simulate `nonce_expired`/`nonce_unknown`; assert the flow **re-exports**, never retry-submits the stale authorization. | Resubmitting a dead authorization in a loop. |
| 12 | **`brainPath` resolution + probe** — each source hit; missing/non-exec/probe-fail ⇒ blocking error naming the path, **no fallthrough**; probe uses `db status` (pure), never an audited read. | Silently falling through to a default when an explicit path is set; probing with `status` and growing the ledger. |
| 13 | **Error-envelope parse** — branch on `retryable`+`retryAfterMs`, ignore the enumerated `7`; read `details` structured, never parse `message`. | Retry decisions keyed off an exit code. |
| 14 | **Egress-minting constant drift** (`egressMintingConstantMatchesSchemas`) — fails if the constant disagrees with the schemas once the authoritative field exists. | The `{query,index eval}` mirror silently drifting from atlas. |
| 15 | **Cadence guard** — assert the only periodic subprocess is `brain watch`; no audited read ever runs on a timer. | A refresh timer quietly polling `status`. |
| 16 | **Read-command conformance** — parse representative `jobs list`/`note show`/`git status` `--json` against their `schemaRef` (reuse atlas fixtures). | Strict-parse breakage on a schema field change. |
| 17 | **Control-safe challenge rendering** — feed an `AuthorizationChallenge` whose displayed fields (`op`, every `intendedEffect.*`, `canonicalBaseCommit`, `runId`/`targetCommit`) embed raw C0 bytes, C1 bytes, ANSI CSI/escape sequences, RTL-override glyphs, and over-length strings; assert every rendered field is length-bounded, quoted, and has control/ANSI/spoofing bytes **made visible** — no raw control byte reaches the SwiftUI view **or** its accessibility label. | A crafted challenge smuggling terminal-control or display-spoofing bytes through the approval UI. |
| 18 | **Egress-key scoping + redaction + no-persist** — assert the capability key is injected into the child env **only** for `query`/`index eval` and for **no** other spawn (drive every read/privileged command and assert absence); assert logged argv/env redact it; assert it is **never written** to `UserDefaults`, the cursor SQLite, or the unified log. For `egressCapabilityKeySource:keychain`, assert a **read-only** `SecItemCopyMatching` (no `SecItemAdd`/`Update`/`Delete`) and that the plaintext is dropped after the child exits. | The capability key leaking to a log/store, riding a non-egress command's env, or the Console writing the Keychain item. |
| 19 | **Unified-log observability + argv sanitization** — assert every `brain`/`atlas-signer` spawn emits an `os.Logger` record (subsystem `com.atlas.console`) carrying **allowlist-sanitized** argv + exit code; drive `brain query "<sensitive text>"` and assert the query operand is logged as the `<redacted:query len=NN>` placeholder (never verbatim) while structural argv / flags / IDs (`jobId`, `--limit`, `--since-seq`, `--config`) are logged intact; assert a probe/spawn/decode failure logs at `error`; assert `brain` stderr is **captured and surfaced** on the relevant error surface, never swallowed. | A spawn/probe/decode failure with no diagnostic trail; user query text leaking into the Console's own logs. |
| 20 | **Watch restart backoff + retry gate + reset** — feed a controllable spawn harness a scripted sequence of watch exits and assert the full §behavior policy: (a) a **retryable** fault (exit 4, envelope `retryable:true`, no `retryAfterMs`) restarts with delays progressing 500 ms → ~1 s → ~2 s → … capped at 30 s, each within the ±20 % jitter band; a `retryAfterMs` present is honored as a floor; (b) attempt count + next-retry time + last `code` are **surfaced** as observable retry state (assert the banner state, not a silent loop); (c) a successful `hello` between two failures **resets both** the delay to 500 ms and the consecutive-failure counter to 0 (assert the delay after the reset, not just the counter); (d) a **non-retryable** exit — exit 5 (usage), exit 2 (config/vault), or exit 4 with `retryable:false` — ⇒ **terminal "watch failed" error state naming the exit/`code`, zero restarts**; (e) `WATCH_MAX_CONSECUTIVE_FAILURES` consecutive retryable failures with **no** intervening `hello` ⇒ terminal error state, no further spawn. | Infinite silent retry on a permanent fault; a usage/config bug respawned forever; backoff that never resets after recovery; retry state hidden from the operator. |

**Environment / parity:** compile-safe suites in CI; the SE-exercising and live-broker paths are a documented manual live-drive checklist (real install, real broker, real signer) — CI parity gap is explicitly the SE and the running daemons, called out here. The backoff test (#20) runs fully in CI against a scripted spawn harness (no real broker needed); the *real* broker-restart timing that tunes the constants is confirmed on the live-drive checklist (open-questions #7).

## accessibility — Accessibility

The Console is a real user-facing SwiftUI surface — **not** `n_a`. macOS accessibility bar (proportional to a desktop app; touch-target sizing is N/A on a pointer platform, replaced by adequate click targets):

- **Semantic structure:** SwiftUI accessibility roles/traits on every control; the dashboard, jobs list, and audit timeline expose heading/landmark structure to VoiceOver.
- **No color-only information.** Health/reachability states (daemon up/down, backup healthy/unhealthy, job succeeded/failed) carry a **redundant icon + text label**, never color alone.
- **Keyboard operability:** all interactive elements reachable and operable via Full Keyboard Access; the privileged-flow confirm/cancel is keyboard-drivable end to end.
- **Focus indicators:** visible, standard macOS focus rings; focus moves predictably into the challenge-display modal and returns on dismiss.
- **VoiceOver labels** on all status indicators, and **live-region announcements** for consequential state changes: job succeeded/failed, backup went unhealthy, a daemon went unreachable, the arrival/expiry of an authorization challenge, and the watch-retry / watch-failed state (§behavior).
- **Data-viz alternative:** the audit timeline has a list/table representation (seq, runId, eventType, time) as its primary form — no chart-only encoding.
- **Text scaling:** honors Dynamic Type; layout survives the system large-text setting without truncation.
- **Reduced motion:** any transition/animation respects `NSWorkspace.shared.accessibilityDisplayShouldReduceMotion` (and the SwiftUI reduce-motion environment).
- **Contrast:** all text and non-text indicators meet the macOS contrast bar in both light and dark appearance.
- **Challenge display + error text** are programmatically associated with their surfaces and announced — a screen-reader operator gets the same approval information a sighted operator does.

## open-questions — Open Questions

1. **`git refresh` privilege drift (atlas-side).** The authorizable-op set is **resolved** — read at runtime from the registry `privilege` field (see `ssot` / `interfaces` §8). One unresolved *atlas* data discrepancy remains: contract prose classes `git refresh` `shared` while code `SIGNATURE_AUTHORIZABLE_OPS` includes it (9 ops). *Owner:* SP-2 implementer files an atlas contract-drift bug (contract-lint binds schema `privilege` to the registry row); the Console consumes whatever the registry `privilege` field says and does **not** encode a hardcoded list.
2. **`mintsEgressCapability` schema field.** The egress-minting set is a pinned constant in V1 (see `ssot`). The atlas-side additive `x-atlas-contract` field (name at atlas's discretion) + registry lint is a one-field contract PR. *Owner:* atlas maintainer; until then the drift-tested constant stands.
3. **Signer-list / settings view (SP-3 R3).** Deferred by operator decision — SP-2 does **not** trigger `brain authz signers --json`. Revive when a settings view is the first real need. *Owner:* deferred, no scheduled work.
4. **Model-call history view (SP-1 R2).** No history read command exists; a history view needs a future additive `--json` read command (e.g. `model calls list`). V1 shows only the live, session-scoped `model_call` feed. *Owner:* future atlas additive-command PR.
5. **Anchor-genesis binding for `incarnation_key` (atlas additive).** V1 finalizes `incarnation_key = SHA-256(absolute `ledger.path`)` from a validated `hello` field (§interfaces §9), and the same-path re-clone edge is caught by the stale-cursor → re-baseline net (§behavior, tested at test-plan #6). The **stronger** binding — a stable audit-anchor *genesis* identity that distinguishes a same-path re-clone with a fresh anchor **without** relying on the re-baseline net — needs an atlas-side additive `watch.hello.snapshot` field (e.g. the audit-ref root-commit hash); SP-1 emits no such field today. *Owner:* atlas maintainer (additive `hello` field); until it lands, the path-keyed V1 + re-baseline net stands, confirmed on the live-drive checklist.
6. **Resume-mode default.** `Settings.resumeMode` defaults to **`resume`** (§interfaces §9, §behavior). Confirm `resume` (vs `liveOnly`) is the right first-launch default for an operator with a large existing ledger — the `resume` path already avoids replaying an unseen incarnation, so the risk is low, but the default is an implementer decision. *Owner:* SP-2 implementer.
7. **Watch restart-backoff parameters.** The restart policy defaults to **500 ms initial, ×2, 30 s cap, ±20 % jitter, reset on `hello`, and `WATCH_MAX_CONSECUTIVE_FAILURES = 6`** (§behavior; owned there per `ssot`). These are proposed defaults, not derived from an upstream contract; confirm/tune the cap and the timing against real broker restart behavior (nonce TTL 300 s; enrollment restarts the broker) on the live-drive checklist. *Owner:* SP-2 implementer.
8. **Concurrent watchers.** SP-1 declares 1–2 concurrent watchers for the install; V1 Console runs **one** `brain watch` process. Confirm no second watcher (e.g. a detail pane) is needed before implementation, or route detail through read-on-focus commands (current assumption). *Owner:* SP-2 implementer.
9. **SP-2 tracking issue.** No issue exists yet — open one at planning start (open repo issues are #60, #65 only; neither blocks SP-2). *Owner:* SP-2 lead.