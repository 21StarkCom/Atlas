# SP-2 planning inputs — Atlas Console (SwiftUI cockpit)

> **Status: working doc, gathered 2026-07-19.** Not a contract. Inputs for authoring the SP-2 spec; fold what survives into the spec's Research appendix, then delete this file. Sources: the merged SP-1 spec (`2026-07-18-console-watch-stream-spec.md`), the merged SP-3 spec + ADR-0002, `security-broker-contract.md`, the cli-contract registry/schemas at `ee7d5d4`, PR #206 (`feat/daemon-services`), the s2p-review sidecar, and repo/docs CLAUDE.md sharp edges. Compiled by three parallel readers + direct review; spec↔code spot-checks found **zero divergence** on the watch contract.

## 0. Charter (binding, already decided)

- Console = SwiftUI macOS app over a **single local Atlas install**; a face over `brain`. Never opens broker sockets, never holds credentials, never imports atlas internals. Lives in-repo under `console/` (outside pnpm globs).
- Consumes ONLY: `brain watch --json` + the `--json` read surface. Detail-on-demand via read commands (`note show`, `git review`, `jobs list`, …); events are change signals only.
- Privileged flow: display → shell out to `atlas-signer` → `brain <cmd> --authorization <path>`. `atlas-signer` is the **only** signing path; a Console that renders its own Touch ID prompt or touches key material is rejected by SP-3.
- Install posture: build-from-source (no quarantine xattr ⇒ no Gatekeeper friction). No SE in CI (macOS runners are Virtualization.framework VMs) — software P-256 fixtures only. SP-2's CI owns the Swift compile job (SP-3 R5).
- Any capability gap = an atlas-side PR (new additive event type or read command), never a workaround in the Console (SP-1 §15).
- No tracking issue exists yet for SP-2 — open one when planning starts. Open repo issues: #60, #65 only (neither blocks SP-2).

---

## 1. `brain watch --json` — the stream contract (SP-1, merged SSOT)

Spec: `docs/specs/2026-07-18-console-watch-stream-spec.md` (311 lines). Schema: `docs/specs/cli-contract/watch.schema.json` (443 lines). Implementation verified matching on every spot-checked point. **Contract deltas vs the original PR #163 text are all folded in below — read the merged spec, never #163.**

### Envelope
- NDJSON, one object per `\n`-terminated line, UTF-8, no BOM. Every event line: `v: 1` (const; additive event types do NOT bump it), `event` (discriminator), `at` (RFC-3339 ms UTC, emission clock).
- **Consumers MUST ignore unknown `event` values.**
- First success line is always `watch.hello`. The ONE non-event line is the standard error envelope: sole line (startup failure) or final line (mid-stream fatal) — never interleaved, at most one, never a batch envelope.
- Writes are blocking with per-line flush; nothing dropped for a slow consumer.

### Event taxonomy — exactly 8 types (3 control + 5 domain)
All payloads allowlisted metadata — never note content, job payloads, model text.

| event | required (beyond v/event/at) | optional |
|---|---|---|
| `watch.hello` | `pid`, `ledger {attached, path}`, `snapshot`, `config {pollMs 100–10000, heartbeatSeconds 5–300}` | `resume {auditHeadSeq ≥ −1}` (absent while detached); `replay {sinceSeq ≥ −1, events ≥ 0}` (present iff `--since-seq` AND attached) |
| `watch.heartbeat` | `ledger {attached, path}` | `resume` (absent while detached) |
| `watch.error` | `source ∈ {ledger, broker, egress, internal}`, `code`, `message` (free text) | — |
| `job` | `jobId`, `workflow`, `state ∈ {pending,running,succeeded,failed,cancelled}`, `attempts`, `maxAttempts`, `updatedAt` | `nextRunAt` (absent for terminal), `lastError` (free text). **Coalesces** per tick (latest state, kubectl-MODIFIED semantics). Shape = `@atlas/jobs JobListRow` + `updatedAt`. |
| `model_call` | `callId`, `runId`, `provider`, `model`, `operation`, `inputTokens`, `outputTokens`, `costMicros`, `createdAt` | — . Insert-only, exactly-once per ledger incarnation, **no replay**, no history read command in SP-1 (R2). |
| `audit` | `seq ≥ 0`, `runId`, `eventType` (14-value enum, drift-pinned to DDL), `createdAt` | `gitHead`. Never coalesces. |
| `backup` | `watermarkSeq ≥ −1`, `healthy`, `updatedAt` | `lastBackupAt`. Coalesces. DDL `seq` → `watermarkSeq` is the ONE correlation rename. |
| `daemon` | `daemon ∈ {broker, egress}`, `socketPath`, `reachable`, `previousReachable` | — . **Transition-only**; probed at heartbeat cadence + once at start. |

`hello.snapshot`: `status --json` shape + `daemons {broker, egress}` each `{socketPath, reachable}`. Ledger-derived keys **absent when detached** (never fabricated zeros): `openRuns`, `jobs {queued, failed}`, `quarantineCount`, `backup {watermarkSeq, coveredSeq, healthy}`, `audit {headSeq, head, anchorOk, anchorSource ∈ {git, sqlite-only}}` (`sqlite-only` = broker unreachable, degraded verdict).

Optional fields are **omitted, never null** — everywhere.

### Seq spaces + resume/replay (the part a client gets wrong first)
- **Two disjoint `audit_events.seq` spaces:** `run.*` rows gapless from **0**; every non-`run.%` kind (3 `db.*` + `evidence.retry_enqueued`) allocates from **`DB_EVENT_SEQ_BASE = 10¹²`**. High space defined by `NOT LIKE 'run.%'`.
- **Cursor + replay cover the run.\* space ONLY.** High-space rows are live-only: never in `resume.auditHeadSeq`, never replayed.
- `--since-seq <n>`: integer **≥ −1**, exclusive (`seq > n`, journalctl `--after-cursor` semantics); `−1` replays from row 0. Replayed rows arrive as ordinary `audit` lines immediately after hello, strict seq order. Mutually exclusive with `--once` (exit 5).
- `resume.auditHeadSeq` = **contiguous-committed-prefix** high-water mark (NOT `snapshot.audit.headSeq`, NOT max-emitted). `−1` = "nothing yet". At-least-once across restarts (boundary dupes possible; `seq` is the idempotency key), exactly-once per incarnation.
- **Pre-replay checkpoint:** during replay `hello.resume.auditHeadSeq = min(n, prefix)`; after the last announced replay row, an **immediate `watch.heartbeat`** carries the first safe-to-persist post-replay cursor.
- Line order ≠ seq order across batches (late commits) — **order the audit timeline by `seq`**. A gap is a pending intent, never pruning.
- **Stale cursor = cursor-above-head only** (post-`db restore` rewind): `replay.events: 0`, consumer detects `resume.auditHeadSeq < n`, re-baselines. No pruning path exists in V1; no `earliestAvailableSeq` field.
- **Any `watch.hello` = full re-baseline.** All dedup state is per-ledger-incarnation; re-attach may legitimately re-issue seen seqs.

### Heartbeat / detach / attach
- Heartbeat every `heartbeatSeconds` (default 30) of quiet or activity — liveness + cursor checkpoint. Detached heartbeat: `ledger:{attached:false}`, no `resume`.
- Ledger absent/unmigrated at startup = **not an error**: streams detached, re-probes each tick, fresh hello on attach (a pending `--since-seq` executes against the first attached ledger). Mid-stream vanish/replace → `watch.error(source:"ledger")` → re-attach loop → fresh hello.
- Broker unreachable → `daemon` event + `anchorSource:"sqlite-only"`. Egress unreachable → `daemon` event only. `backup-unhealthy` never blocks watch — streamed as `backup {healthy:false}`.

### Exit + flags
- Exits: `0` (`--once` done; SIGINT/SIGTERM; **EPIPE ⇒ 0, never 141** — detach = success), `2` (startup config/vault), `4` (internal; broker *protocol* fault — unreachability is data), `5` (usage; missing `--json`; `--once`+`--since-seq`). No 1/3/6/7 paths.
- Flags: `--json` **required**; `--since-seq <n≥−1>`; `--once`; `--poll-ms` (default **500**, 100–10000); `--heartbeat-seconds` (default **30**, 5–300).
- `--once` emits exactly one hello and exits 0 — **what the Console calls at attach before choosing a resume point** (§5).
- Registry row: phase 6, `privilege: shared`, `executionClass: read` (NOT audited-read — emits no `run.readonly`), `streaming: true`, `exitCodes: [0,2,4,5]`; `prohibitedEffects` pins readonly connection / no locks / no git / no egress / sole broker call `getAuditChainStatus`.

### Free text + escaping
- Exactly two free-text fields: `job.lastError`, `watch.error.message`. Whole serialized line escaped over **C0 AND C1** (`U+0000-U+001F`, `U+007F-U+009F` -> `\uXXXX`) — decoded strings are terminal-safe. Secret redaction deferred by operator call (revisit if a shared consumer appears).

### Ordering summary
Per-source only; fixed source order per tick: `audit`, `model_call`, `job`, `backup`. Never infer cross-source causality from line order. `job`/`backup` coalesce; `audit`/`model_call` never.

### Spec passages explicitly addressed to SP-2
- §9.1: no fs-watch hint shipped — 500 ms poll is fine for a human dashboard; hint only if the Console feels sluggish (it won't).
- §14 R1: no vault-file-change events — file views poll `git status --json` / `note show --json` on focus. R4: re-baseline = SIGTERM+restart or `--once` ("one line of Swift"). R5: filtering is consumer-side.
- §7.5: chain-level truth (gapless seq, anchor, ref/ledger agreement) comes from `git verify` / `doctor` / `db verify` **on demand** — watch reports the ledger mirror only.
- Schema `examples` contain one instance of every event type (attached + detached hellos) — **usable directly as Swift decoder test fixtures**.
- §4 scope: single operator, single machine, 1–2 concurrent watchers.

---

## 2. The `--json` read surface — 25 commands

Registry: `docs/specs/cli-contract/commands.json` (50 rows, all implemented). Inventory is **runtime-derived by `executionClass`** from schemas (the sweep test) — never trust prose lists. 17 `read` + 4 `audited-read` + 4 `pure`. All `privilege: shared` except `quarantine inspect` (privileged, challenge-bound per invocation — not pollable). All idempotency `none` except `git verify` (`intrinsic`).

| group | commands |
|---|---|
| status/health | `status`ᴬ · `doctor`ᴾ · `inspect`ᴬ · `validate`ᴾ · `watch` |
| jobs | `jobs list` |
| quarantine | `quarantine inspect` (privileged read) |
| graduation | `graduation audit`ᴬ · `graduation scan` (read-class but heavy: creates grad copy, persists scan-state, can exit 3) |
| trust/sources | `source trust show` · `source list` · `source show` |
| index/retrieval | `index status` · `index verify` · `index eval`⚡ · `query`ᴬ⚡ |
| db | `db status`ᴾ · `db verify`ᴾ |
| git/audit/notes | `git status` · `git review` · `git verify` (convergent-repair — mutates drift back) · `evidence review` · `note history` · `note related` · `note show` |

ᴬ = audited-read (4: `query`, `inspect`, `status`, `graduation audit`) — **each executed run emits a `run.readonly` audit event**; `query` additionally writes `retrieval_runs`/`retrieval_results` + triggers a post-run backup (both modes); `graduation audit` writes a ledger row + backup. **Cadence rule for the cockpit: poll `watch`, not audited reads** — hammering `status`/`inspect` grows the audit ref; polling `query` grows the ledger and fires backups.

⚡ = mints egress capability, needs **`ATLAS_EGRESS_CAPABILITY_KEY`** exported, costs provider budget — gate behind explicit user action, never poll. (`query --no-answer` skips generation/`model_calls` but still embeds via egress.)

ᴾ = pure — no ledger row, available even when the backup watermark blocks writes (`db status`, `db verify`, `doctor`, `validate`).

### Privileged mutations (Console renders, never drives without the signer flow)
`db restore` · `purge` · `graduation migrate --apply/--rollback` · `git approve` · `git rollback` · `source trust promote` · `source trust revoke` · `quarantine resolve` (+ `quarantine inspect` as privileged read). Flow: `--export-challenge` → sign → `--authorization <path>`; no authorization ⇒ exit 6; `--yes` never authorizes.

### Exit codes + error envelope (client parser facts)
- EXIT caps at 6: 0 ok · 1 validation · 2 config/vault/lock · 3 secret-scan · 4 internal · 5 usage · 6 action-required. Retryability rides `retryable: true` + optional `retryAfterMs` on the envelope at exit 4/6 — **parse envelope flags, not the code** (some schemas still nominally enumerate 7, e.g. `query`).
- The one real exit-7: `jobs run` batch aggregate. Batch commands (`jobs run|retry|cancel`) emit `{command, items[], aggregate}` — the sole envelope exception.
- Error envelope (`error-envelope.schema.json`, `unevaluatedProperties: false`): required `code` (stable discriminator; composites `locked:<scope>`, `authz.<reason>`), `message`, `hint`, `retryable`; optional `details` (structured — `field`/`path`/`location`/code-specific keys; never parse `message` for data), `errors[]` (nested), `retryAfterMs`, `runId`, `jobId`. Per-command `code`→exit map in each schema's `x-atlas-contract.errorCodes`.
- `jobs list --json` (post-#205): `{command, jobs[], pagination {limit 1..500, offset, total, hasMore}}`; ordering pinned `createdAt desc`, tiebreak `jobId`; `--limit` default 50, max 500.

### Invocation facts (how the Console runs `brain`)
- Router globals: `--json --plain --no-color --quiet --verbose --help --config <path>`. **`--vault` appears in schema `commonFlags` but the router does NOT parse it** — vault location is `vault.path` in `brain.config.yaml`. Resolution: `--config <path>` wins, else `<cwd>/brain.config.yaml`, then `ATLAS_*` env overrides, then strict Zod (12 required sections). **The Console must spawn `brain` with the right cwd or pass `--config` — load-bearing.**
- **`ATLAS_ROOT`** required off the repo layout (root discovery walks up for `commands.json`; packaged install fails exit-4 without it).
- Conformance guarantee: every read command's live `--json` validates against its `schemaRef` in CI (runtime-derived sweep, fix-forward) — **strict parsing against the schemas, no defensive parsing; `x-atlas-contract` blocks are normative API docs.**

---

## 3. `atlas-signer` — the privileged-flow contract (SP-3, merged)

Sources: SP-3 spec §5–§11, ADR-0002, `security-broker-contract.md` §7–§10. **SSOT note:** post-merge the broker contract is the operational SSOT where it overlaps; the §5.3 amendments had NOT landed in the contract at `ee7d5d4` (still Ed25519-pinned text) — the SP-3 implementation PR carries them. Write SP-2 against the spec's rules.

### CLI surface (Swift Package at `console/signer/`, macOS-only, entitlement-free, ad-hoc-signed)
- `keygen [--signer-id <id>] [--force]` — SE key under `.biometryCurrentSet` (fires Touch ID), writes blob + `config.json`, prints SPKI PEM + signerId. Ids must carry `-vN`; default `approver-se-<hostname>-v1`; `--force` derives `-v(N+1)`.
- `pubkey [--out <path>]` — SPKI PEM alone on stdout; signerId on stderr (redirect yields PEM-only file).
- `sign [--out <path>] [--force]` — one `AuthorizationChallenge` JSON on stdin → validate → display approval summary (stderr) → one pre-armed `LAContext` (summary as `localizedReason`) → sign `signingPayload` UTF-8 (P-256 DER) → invalidate context → emit `AuthorizationResponse {schemaVersion:1, challenge, signature:"p256:…", signerId}`.

**Channel contract (Console parses this):** summary + diagnostics → stderr always. No `--out`: response is the only stdout content on success, stdout **empty on failure**. With `--out`: file-only (`0600`, refuses existing without `--force`), stdout empty always. Exactly one destination.

**Exit codes (branch on these, never string-match stderr — a SEPARATE namespace from `brain`'s EXIT map):**
`0` signed · `1` internal fault · `2` malformed/invalid challenge **incl. re-derivation mismatch** · `3` expired `expiresAt` (checked before prompting) · `4` user cancelled / biometry failed · `5` key invalidated by biometry re-enrollment (stderr carries the re-enroll runbook pointer).

### Flow end to end
```bash
brain <cmd> … --export-challenge > challenge.json     # exit-6 path mints it
atlas-signer sign < challenge.json > authorization.json
brain <cmd> … --authorization authorization.json
```
- **Console must DISPLAY:** `op`, `runId`/`targetCommit` when present, `canonicalBaseCommit`, every `intendedEffect` field, `expiresAt`, SHA-256 of `signingPayload`. Rendering control-character-safe (length-bounded, quoted, C0/ANSI made visible).
- **Re-derivation rule:** signer re-derives `signingPayload` from the displayed fields and refuses exit-2 on mismatch **before prompting** — bytes signed are provably bytes shown. Broker recompute is the second backstop (`authz.payload_mismatch`).
- `signingPayload` (§8.2): `atlas.authz.v1\n<op>\n<runId|->\n<targetCommit|->\n<canonicalBaseCommit>\n<nonce>` + op-specific `intendedEffect` commitment lines. Per-op field/verification/drift table: contract §7.4/§7.5 (`authzContract` JSON block — the lint SSOT).
- **Nonce: 128-bit, TTL 300 s, single-use, in-memory — broker restart voids challenges** (enrollment restarts the broker). Slow signing ⇒ `authz.nonce_expired` (exit 6) ⇒ re-export + re-sign. Console flows spanning a broker restart must **re-export, not retry submit**.
- Error surfacing (`brain` side, contract §7.3): state-drift codes (`canonical_moved`, `target_mismatch`, `nonce_expired`, …) → exit 6; `signer_unknown/revoked/not_permitted`, `signature_invalid`, `payload_mismatch`, `nonce_unknown/replayed`, … → exit 1; `quarantine_key_denied` → 2. Idempotent replay of a completed op = `authz.ok` + `noop: true`.

### Enrollment / lifecycle (Console surfaces the runbook, never runs sudo itself)
- `provisioning/enroll-signer.sh --pubkey <pem> --signer-id <id> --alg p256 [--presence]` — sudo-gated, DER-SPKI-fingerprint-unique registry, `--presence` requires p256 and unlocks the two quarantine ops; **last step restarts the broker**. Revoke = `--revoke --signer-id <id>` (status flip, never delete).
- Biometry re-enrollment invalidates the key → sign exit 5 → `keygen --force` → enroll `-v(N+1)` → revoke old.
- Fresh-Mac: `console/signer/install.sh` (build + keygen + pubkey + prints the exact sudo enroll line — the sudo step stays human-typed).
- `presence` is an enrollment-time custody claim; refusal path is `authz.signer_not_permitted`; `authz.presence_unverified` reserved/unemitted.

### Gaps the SP-2 author must resolve
1. **Which ops need the signing flow** — derive from `commands.json` `privilege` + runtime exit-6, never hardcode (known tension: contract prose says `git refresh` is shared; code `SIGNATURE_AUTHORIZABLE_OPS` includes it — 9 ops).
2. **No signer-list read API** (SP-3 R3 deferred to "SP-2's first real need") — a settings view showing enrolled signers needs the R3 registry row (`brain authz signers --json`, one-row addition under phase 6) or gets dropped.
3. **Two exit-code interpreters** — `atlas-signer` 0–5 vs `brain` 0–6(+7 aggregate): keep them separate in the Swift layer.
4. SP-3 threat honesty inherited: one biometric per signing **burst** (not per signature); a spoofed display can get a legitimate-but-misunderstood challenge approved, never a different effect.

---

## 4. Runtime / install posture (incl. PR #206, in flight)

- **PR #206 `feat/daemon-services`** (open, reviewed 2026-07-19, 3 findings posted): `tools/build-artifact.sh` (esbuild single-file CJS bundles of `atlas-broker`/`atlas-egress` + sha256 manifests — broker dep tree is pure JS, no native modules) → `sudo provisioning/install-artifact.sh dist-artifact` (hash-verified, root-owned `/usr/local/lib/atlas/bin`) → `sudo provisioning/macos/services.sh install` (launchd system daemons `com.atlas.{broker,egress}`, `RunAtLoad`+`KeepAlive`, per-identity `UserName`, logs `/usr/local/var/log/atlas/`). **SP-2 consequence: the Console can assume daemons run as launchd services surviving reboot — `daemon` events + a "service not installed" empty-state are the UX, not daemon lifecycle management.** Broker vault path override = `ATLAS_VAULT_REPO_DIR` in the plist + re-install.
- Console spawns `brain` as the operator (not `atlas-agent`): needs correct cwd or `--config`, `ATLAS_ROOT` if off-repo-layout, `ATLAS_EGRESS_CAPABILITY_KEY` for `query`/`index eval`.
- Live-drive gotchas that shape the runbook: fresh clone + fresh anchor per broker, `db migrate` before `db rebuild`, short challenge-nonce TTL (retro `2026-07-18-search-index-live-drive-retro.md` is authoritative).

## 5. Repo sharp edges relevant to SP-2 authoring

- **Exit-code set tension:** design SSOT says 0–7; plan §2.5 + contract tables enumerate 0–6 — quote the SSOT for the set, note the 0–6 tables (docs/CLAUDE.md).
- **Dead-link trap:** `config-schema.md`, `state-inventory.md`, `vault-format.md`, `broker-deployment.md` are cited by the design spec but were never authored — never link them.
- Spec conventions: dated `YYYY-MM-DD-<topic>-spec.md` in `docs/specs/`; review companions (`.red-team.md`, `.review-analytics.md`, `.s2p-review.md`) sit beside the doc.
- s2p-review lesson (SP-1 sidecar): interface-declaration gaps (exact types, file paths, argv) were what burned 5 review rounds — the SP-2 spec should pin the Swift↔`brain` process contract (spawn args, env, parsing) at the same precision.

## 6. Process guardrails for the SP-2 spec run (from memory, non-negotiable)

- Spec review: `/stark-review-spec` pattern, **hard cap 2 review rounds** — round 3 = escalate with open findings.
- Reviewer must prove it can run the relevant harness before round 1.
- Ceremony tier: real product, lean process — spec **or** plan review, not chains; decompose to phases, not 26 tasks.
- pnpm pin 11.15.0; blank global shim workaround = run `node_modules/.bin/vitest` directly.
- The **fact-check-workflow-before-fixing** pattern (parallel readers + adversarial cross-check) caught implementation-blocking defects that 3 review rounds missed — use it on the SP-2 spec's process-contract claims.
