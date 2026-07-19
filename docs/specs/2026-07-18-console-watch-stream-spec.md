# Atlas Console SP-1 — `brain watch`: the NDJSON event stream + `--json` read-surface audit

> **Status:** proposed · **Version:** 1 · **Arc:** Atlas Console SP-1 (of SP-1 enablement / SP-2 SwiftUI cockpit / SP-3 Secure-Enclave signing)
> **Consumes:** the CLI-contract registry machinery ([`tools/CLAUDE.md`](../../tools/CLAUDE.md), `docs/specs/cli-contract/commands.json`), the exit-code set and single-error-envelope rule (plan §2.5, [`error-envelope.schema.json`](cli-contract/error-envelope.schema.json)), the ledger DDL ([`sqlite-data-dictionary.md`](sqlite-data-dictionary.md) §3–§4), the Tier-0 audit exception (design SSOT *Audit SSOT* / `apps/cli/src/audit/readonly.ts`), and the `status`/`doctor` health shapes ([`status.schema.json`](cli-contract/status.schema.json), [`doctor.schema.json`](cli-contract/doctor.schema.json)).
> **Produces:** the normative contract for the `watch` command (event taxonomy, NDJSON envelope v1, resume semantics, exit behavior, registry integration) and the read-surface `--json` conformance bar SP-2 builds on.

Atlas Console is a SwiftUI macOS app that visualizes and manages a **single local Atlas install**. It is a **face over `brain`** — it never opens broker sockets, never holds credentials, never bypasses the CLI. SP-1 is the atlas-side enablement: the Console needs a *live* surface (today every read command is a point-in-time snapshot) and a *trustworthy* machine surface (every read command's `--json` must actually conform to its schema). This spec defines both.

---

## 1. Problem

A cockpit polling `brain status --json` in a loop is the wrong shape three ways:

- **Latency vs load.** Sub-second freshness means sub-second full-summary recomputation — `status` re-derives open-run counts, backup health, and audit-chain state every call, and (as an audited read) attempts a broker round-trip + ledger write per invocation.
- **No deltas.** A snapshot can't tell the Console *what changed* — it must diff client-side, and transitions between polls (a job that went `pending → running → failed`) are invisible.
- **No timeline.** The audit ledger is an append-only event stream with a global monotonic `seq`; snapshots throw that structure away.

The fix is the standard one (kubectl watch, `docker events`, `journalctl -f -o json`): one long-lived command that emits an initial snapshot, then one JSON line per change.

## 2. What this is

- **One new CLI command, `brain watch`** — a long-lived, JSON-only, read-only NDJSON stream of: job transitions, model-call records, audit-ledger appends, backup-watermark changes, and daemon reachability transitions, preceded by a full snapshot.
- **A registry-integrated contract** — a `commands.json` row, fixture line, and `watch.schema.json` under the existing drift-proof harness, landed contracts-gate-first like every prior phase.
- **A read-surface conformance bar** — an inventory + one sweep test asserting every read-class command's `--json` output validates against its `schemaRef`, so SP-2 can consume any read command without defensive parsing.

## 3. What this is not

- **Not a daemon.** `watch` is a foreground child of its consumer (the Console, or a terminal), exactly like `journalctl -f`. It has no socket, no background lifecycle, no supervision. The design SSOT's out-of-V1 "daemon" exclusion is untouched.
- **Not a second health authority.** Every judgment `watch` emits (backup health, audit-anchor verdict, open-run counts) is produced by the same code paths `status` and `doctor` already own. `watch` adds *transport*, never *derivation* (§7.6).
- **Not a query/detail API.** Events carry change signals with allowlisted metadata — never note content, payloads, or diffs. The Console fetches detail through the existing read commands (`note show --json`, `git review --json`, `jobs list --json`, …).
- **Not a git observer.** `watch` reads the SQLite ledger only. The `refs/audit/runs` git stream is mirrored into `audit_events` (with `git_head`) by the §2.8 write protocol; `watch` observes the mirror (§7.5 states the boundary honestly).
- **Not an egress consumer.** `watch` makes no model calls and therefore needs no `ATLAS_EGRESS_CAPABILITY_KEY`, mints no capability, and never touches the egress socket beyond a connect/close reachability probe.
- **Not SP-2.** The SwiftUI app, its IPC harness, and its install story are SP-2. This spec only fixes every seam SP-2 consumes.

## 4. Scope declaration (binding for review)

Single operator, single machine, personal playground install (repo constitution: "playground, not product"). Expected scale: a personal vault (~10² –10³ notes), a jobs table in the 10²–10³ rows range, audit ledger in the 10³–10⁴ events range, **one or two concurrent `watch` processes** (a Console and maybe a terminal). No multi-user, no remote consumers, no SLA. Review findings that would push `watch` toward fleet-scale streaming infrastructure (brokered pub/sub, snapshot compaction, consumer groups, drop policies under fan-out) are out of scope by this declaration.

---

## 5. Command surface

```
brain watch --json [--since-seq <n>] [--once] [--poll-ms <n>] [--heartbeat-seconds <n>]
```

| Flag | Default | Constraint | Meaning |
|---|---|---|---|
| `--json` | — | **required** | `watch` is machine-only. Invocation without `--json` is a usage error (exit 5). |
| `--since-seq <n>` | absent | integer ≥ −1 | Replay durable **run.\*-space** audit rows with `seq > n` (exclusive, `journalctl --after-cursor` semantics) before going live. `-1` replays from the first row — run.\* seqs start at **0**, so a floor of 0 would make row 0 unreplayable. Applies to the `audit` stream only (§8). |
| `--once` | off | mutually exclusive with `--since-seq` | Emit `watch.hello` (the full snapshot) and exit 0. The cheap probe/test seam; also what SP-2 calls at attach before deciding a resume point. Combining `--once` with `--since-seq` is a usage error (exit 5) — a one-shot snapshot has no live tail to resume into. |
| `--poll-ms <n>` | 500 | 100–10000 | Ledger change-detection cadence (§9). |
| `--heartbeat-seconds <n>` | 30 | 5–300 | `watch.heartbeat` emission + daemon reachability probe interval (§7.1, §7.3). |

**Registry row** (one name-sorted insert; see §10 for the landing mechanics):

```json
{
  "name": "watch",
  "schemaRef": "docs/specs/cli-contract/watch.schema.json",
  "phase": 6,
  "idempotency": "none",
  "privilege": "shared",
  "implemented": false
}
```

The registry vocabulary has no "readonly" privilege class — read-only-ness is carried by `privilege: "shared"` plus the schema's `x-atlas-contract.executionClass`. `watch` declares **`executionClass: "read"`** — the same class as `jobs list` / `source list`, *not* the `audited-read` class (the four commands whose schemas declare `executionClass: "audited-read"`: `status`/`inspect`/`query`/`graduation audit`, §11).

### 5.1 Why `watch` emits no `run.readonly` audit event

The design SSOT's Tier-0 audit exception enumerates the audited reads — `query`/`inspect`/`status`/`graduation audit` (the four `executionClass: "audited-read"` commands, §11): exactly one terminal `run.readonly` per executed run, best-effort. Plain reads (`jobs list`, `note show`, `source list`, …) emit nothing. `watch` is a plain read, deliberately:

1. **An observer must not mutate the observed system.** `run.readonly` funnels through `finalizeLedgerWrite` — a ledger write, a broker RPC, and a coalesced-backup trigger. A Console that attaches/detaches all day would salt the audit stream (and the backup cadence) with its own observation records — records `watch` would then dutifully report back, which is noise reporting noise.
2. **`run.readonly` anchors a computed result** (a query answer, a status summary) for cross-check. A stream relays rows it did not compute; there is no result to anchor.
3. **`watch` must work when the broker is down** — daemon health is one of its jobs. An audited read degrades in that case anyway (`readonly.ts` round-2 finding F3); building the append in just to degrade it is complexity with no gain.

### 5.2 Availability matrix (fail-fast vs observe-the-outage)

`watch` distinguishes *invocation errors* (fail fast, exit non-zero, single error envelope) from *observed-system faults* (they are the product — report them as events and keep streaming):

| Condition | Behavior |
|---|---|
| unknown flag / missing `--json` / bad flag value | usage error, exit 5 |
| `brain.config.yaml` missing/invalid | `config-invalid`, exit 2 (cannot even locate the stores) |
| ledger DB absent or unmigrated at startup | **streams anyway**: `watch.hello` reports `ledger.attached: false`; re-probes each poll tick; emits ledger-sourced events once it appears. A fresh install being watched *is* a valid observation. |
| **broker** socket unreachable | `daemon` event (`broker`, `reachable: false`); snapshot `audit.anchorSource` degrades to `"sqlite-only"` exactly as `status` does (the broker is what verifies the protected ref, §7.2) |
| **egress** socket unreachable | `daemon` event (`egress`, `reachable: false`) **only** — egress plays no part in anchor verification (`watch` makes no egress call, §3), so `audit.anchorSource` is unaffected |
| backup watermark blocked (`backup-unhealthy`) | streamed as a `backup` event with `healthy: false`. `watch` opens the ledger read-only and is never itself blocked by the watermark — same posture as `db status`/`inspect`. |
| ledger DB disappears mid-stream (deleted/replaced by `db restore`) | `watch.error` (non-fatal, `source: "ledger"`), `ledger.attached: false`, re-attach loop. On re-attach, a fresh snapshot section is re-emitted (§8.3). |
| unexpected internal fault (bug) | single error envelope on stdout, exit 4 |

**Read-only enforcement:** `watch` opens the SQLite ledger with `better-sqlite3`'s `readonly: true` (it can never create, migrate, checkpoint, or write), takes **no Atlas lock** in any scope, opens no git repository, and calls no broker method other than the read-only `getAuditChainStatus` (snapshot only, best-effort). The `watch.schema.json` `x-atlas-contract.prohibitedEffects` pins all of this.

---

## 6. Stream framing — NDJSON envelope v1

- One JSON object per line, `\n`-terminated (including the final line), UTF-8, no BOM, no raw newlines inside a record — JSON Lines / `application/x-ndjson` conventions. No RS-framing (RFC 7464 resync is for corruptable transports; this is a local pipe).
- **Every *event* line carries** `v: 1` (the stream-contract version; bump only on a breaking envelope/taxonomy change — an *additive* new event type does not, §15), `event: "<type>"` (the discriminator), and `at` (RFC-3339 ms UTC, the emission clock). These invariants bind the event lines, not the error envelope — which is the one non-event line the stream may emit (see next bullet).
- **The first line of a *successful* stream is always `watch.hello`, and every subsequent success line is an event line.** The one non-event line is the standard single error envelope (`error-envelope.schema.json`), which appears in exactly one of two places and never both: as the **sole** line when startup fails before any `watch.hello` (usage/config faults, §5.2), or as the **final** line after a mid-stream fatal fault — the process then exits with the envelope's mapped code (§10.1). `watch` is **not** a batch-envelope exception like `jobs run`; it emits at most one error envelope, and never interleaves it with event lines.
- Writes are blocking with per-line flush; nothing is ever dropped for a slow consumer (`docker events`/`journalctl` posture — at this scale backpressure is the consumer's problem, and the consumer is on the same machine).
- `watch.schema.json` describes a single line as a discriminated union over `event`; the schema's `examples` include one instance of every event type, so the existing `cli-schemas.test.ts` example-validation gate covers the whole taxonomy.

## 7. Event taxonomy

Eight event types in v1 — three control (§7.1) + five domain (§7.3). Domain events mirror their owning schema/DDL field-for-field (camelCase, as everywhere in the CLI contract), inventing no names **except the handful of documented correlation renames** called out inline (only `backup.watermarkSeq` for the DDL column `seq`, §7.3, so event and snapshot join on one name). All payloads are **allowlisted metadata only** (§2.5 rule): ids, states, hashes, counts, timestamps — never note content, job payloads, or model text.

### 7.1 Control events

| Event | When | Payload (beyond `v`/`event`/`at`) |
|---|---|---|
| `watch.hello` | first line; and again after a mid-stream ledger (re-)attach (§8.3) | `pid`, `ledger: {attached, path}`, `snapshot` (§7.2), `resume: {auditHeadSeq}`, `replay: {sinceSeq, events}` (**absent** — never null — unless `--since-seq`; `events` is the integer count of rows re-sent, per §8.1), `config: {pollMs, heartbeatSeconds}`. **While `ledger.attached: false`, `resume` and `replay` are absent** — no fabricated cursor; the fresh hello emitted on attach (§8.3) carries the first real one, and a pending `--since-seq` executes against that first attached ledger. An attached ledger with **no committed run.\* row** reports `resume: {auditHeadSeq: -1}` — run.\* seqs start at 0, so `-1` means "nothing yet; next is 0" (the same seed convention as `backup_watermark`, `watermark.ts`) and is never ambiguous with row 0 having committed. Under `--since-seq` it also reports `replay: {sinceSeq, events: 0}`. |
| `watch.heartbeat` | every `heartbeatSeconds` of quiet **or** activity | `resume: {auditHeadSeq}` (**absent while `ledger.attached: false`** — a detached heartbeat carries `ledger: {attached: false}` and no cursor, §5.2) — the k8s-BOOKMARK / SSE-keep-alive dual: liveness signal *and* cursor checkpoint. |
| `watch.error` | non-fatal fault in one source (ledger detach, probe exception) | `source: "ledger" \| "broker" \| "egress" \| "internal"`, `code`, `message`. The stream continues; fatal faults use the error envelope instead (§6). |

### 7.2 The `watch.hello` snapshot

`snapshot` reuses the `status --json` shape verbatim (same keys, same derivation code — §7.6), extended with the daemon probes:

```json
{
  "openRuns": { "review-pending": 1 },
  "jobs": { "queued": 3, "failed": 1 },
  "quarantineCount": 2,
  "backup": { "watermarkSeq": 811, "coveredSeq": 907, "healthy": false },
  "audit": { "headSeq": 907, "head": "a1b2c3d4…", "anchorOk": true, "anchorSource": "git" },
  "daemons": {
    "broker": { "socketPath": "/usr/local/var/run/atlas/broker.sock", "reachable": true },
    "egress": { "socketPath": "/usr/local/var/run/atlas/egress.sock", "reachable": true }
  }
}
```

When the ledger is not attached, `snapshot` carries only `daemons` and the other keys are absent (never fabricated zeros). `anchorSource: "sqlite-only"` keeps `status`'s degraded-verdict semantics: the broker was unreachable, so the protected ref itself is unverified.

### 7.3 Domain events

| Event | Source of truth | Trigger | Payload |
|---|---|---|---|
| `job` | `jobs` + latest `job_attempts` row | any change to a job's `(state, attempts, next_run_at, updated_at)` | `jobId`, `workflow`, `state`, `attempts`, `maxAttempts`, `nextRunAt?`, `lastError?`, `updatedAt` — the `jobs-list` item shape + `updatedAt` |
| `model_call` | `model_calls` (insert-only) | new row | `callId`, `runId`, `provider`, `model`, `operation`, `inputTokens`, `outputTokens`, `costMicros`, `createdAt` — the DDL columns, camelCased |
| `audit` | `audit_events` (insert-only; **two disjoint `seq` spaces**: `run.*` rows (`event_type LIKE 'run.%'`) allocate gapless from **0**; every **non-`run.%`** ledger-internal kind — the 3 `db.*` **and** `evidence.retry_enqueued` — allocates from `DB_EVENT_SEQ_BASE = 10¹²` via `nextDbEventSeq` (`sqlite-store` `ledger/intents.ts`), which counts **all** non-`run.%` rows, so the high space is defined by `NOT LIKE 'run.%'`, never by `LIKE 'db.%'`) | new row in either space | `seq`, `runId`, `eventType`, `gitHead?`, `createdAt`. Both spaces stream live; **the resume cursor and `--since-seq` replay are defined over the `run.*` space only** (§8.1). `eventType`'s allowlist is **owned by the `audit_events` DDL CHECK** (the **14** kinds: 10 `run.*` + 3 `db.*` + `evidence.retry_enqueued`); `watch.schema.json`'s enum is a **replica the harness pins against drift** (§13.1) — never a second source of truth. Prose elsewhere in this spec uses "`db.*`-space" as shorthand for the high (non-`run.%`) space; `evidence.retry_enqueued` is a member of it. `payload_hash` is deliberately omitted (an integrity internal, not a console signal). |
| `backup` | `backup_watermark` (single row) | any column change | `watermarkSeq`, `healthy`, `lastBackupAt?`, `updatedAt` — mirroring the **`status --json` `backup` object naming** (the shared-derivation surface, §7.6): the DDL column `seq` is exposed as `watermarkSeq` so event and snapshot correlate on one name; the other fields mirror the DDL. (`coveredSeq` appears only in the snapshot, where the shared `status` code derives it; the event mirrors the row.) |
| `daemon` | socket connect/close probe | reachability **transition** only (probed at heartbeat cadence + once at start) | `daemon: "broker" \| "egress"`, `socketPath`, `reachable`, plus `previousReachable` so a consumer can render the transition without state |

### 7.4 Ordering & delivery guarantees

- **Per-source ordering:** `audit` events are emitted in `seq` order *within each poll batch*; `model_call` in `(created_at, call_id)` order; `job` events in observation order per job. **Line order is not global `seq` order across batches** — see the late-commit rule below; consumers order the audit timeline by `seq`, never by line position.
- **Late-committing rows are emitted late, not lost.** Ledger key allocation order ≠ commit order: the §2.8 intent transaction serializes `seq` *allocation*, and a degraded read's `pending` intent is deliberately converged by a *later* writer's `reconcileInterruptedRuns` — so the system guarantees that a lower `seq` can commit long after higher ones. `watch` therefore tracks emitted seqs explicitly (contiguous prefix + a sparse set above it, §9.1) and emits a late-landing row when it commits.
- **Cross-source ordering is observational only** — events from different tables observed in one poll tick are emitted in a fixed source order (`audit`, `model_call`, `job`, `backup`) but carry their own source timestamps; consumers must not infer cross-source causality from line order.
- **Current-state events may coalesce; append-only events never do.** Polling samples state, so the two single-/current-row sources report only the latest value seen at a tick: a `job` that goes `pending → running → succeeded` inside one poll interval emits one `job` event with the final state (kubectl `MODIFIED` semantics, not a per-transition log), and `backup` likewise reports the watermark row's latest state — an intermediate watermark value that appears and is superseded within one interval is not separately emitted. The durable per-attempt job history stays queryable via `jobs list --json`; backup history is not journaled per-change (and is not needed at this scale, §4). By contrast `audit` and `model_call` are append-only durable rows: they **never** coalesce — every row is emitted exactly once per **ledger incarnation** (attach epoch, §9.1; replay excepted). A re-attach (§8.3) starts a fresh incarnation and re-baselines rather than deduplicating against the old one — a restored ledger may legitimately re-issue previously-seen seqs.
- **At-least-once across restarts:** a consumer resuming with `--since-seq` may re-receive audit events at the boundary; `seq` is the idempotency key. Within one ledger incarnation (attach epoch, §9.1) the stream is exactly-once per durable row (the emitted-seq tracking above makes this hold even under late commits); a re-attach re-baselines instead (§8.3). A `resume.auditHeadSeq` cursor is a **safe checkpoint** — a consumer may persist it and restart from it with **zero loss**. It is the **contiguous-committed-prefix high-water mark of the `run.*` seq space** (`seq < DB_EVENT_SEQ_BASE`, §7.3) among rows already written to this stream — `db.*`-space rows never enter the cursor (they are live-only, §8.1) — distinct from `snapshot.audit.headSeq` (the max committed `run.*` seq, which may sit above a gap) and never the max emitted seq. Resuming from the prefix re-delivers anything that was in-flight above a gap, trading boundary duplicates for zero loss.
- **The replay checkpoint is the pre-replay point, never the head.** When `--since-seq n` triggers replay, the replayed rows `n+1..` are emitted *after* `watch.hello`, so `watch.hello.resume.auditHeadSeq` carries **`min(n, contiguous prefix)`** — in every normal resume (`n` came from an earlier prefix, and prefixes only advance) that is **`n` itself**, the caller's already-safe cursor; only after a restore rewound the head below `n` is it the (smaller) rewound prefix, which is both the §8.2 detection signal and the true safe checkpoint. It is **never** the post-replay head. Otherwise a consumer that persisted the hello cursor and crashed mid-replay would restart above the un-processed rows and skip them. Once every announced replay row has been written, `watch` emits an **immediate `watch.heartbeat`** whose `resume.auditHeadSeq` is the new contiguous prefix — the first checkpoint that is safe to persist past the replay window. (Without `--since-seq` there is no replay, so `watch.hello.resume.auditHeadSeq` is already the contiguous prefix and is immediately safe.)

### 7.5 The observation boundary (stated honestly)

`watch` reports the **ledger's** view. The §2.8 cross-store write protocol means a crash window can exist where the broker has appended to `refs/audit/runs` but the ledger commit is still a `pending` intent — `watch` will not surface that event until the next writer's reconcile lands it. Chain-level truth (gapless seq, anchor position, ref/ledger agreement) belongs to `git verify` / `doctor` / `db verify`, which the Console invokes on demand. `watch` never claims chain health beyond relaying the snapshot's `audit` verdict.

### 7.6 SSOT rule (binding on implementation)

The snapshot derivations (`openRuns`, `backup`, `audit`, `jobs`, `quarantineCount`) MUST be produced by the same functions the `status` handler uses today (extracted, not duplicated), and the daemon probe MUST be the same connect/close probe `doctor`/`assertReadAuditReady` use. Likewise the `job` event payload MUST be produced by the **same jobs-list item projection `jobs list` uses** (plus `updatedAt`, §7.3) — one owner for that shape, never a second hand-rolled copy. If `watch` and `status`/`jobs list` can ever disagree about the same row, that is a bug by definition. The stream adds one derivation of its own — table-diffing (§9) — and nothing else.

---

## 8. Resume & replay

### 8.1 What resumes

Within the `run.*` space, `audit_events.seq` is a gapless monotonic allocation from 0 — a real cursor. **Replay is defined for the `audit` stream only, and within it for the `run.*` seq space only** (`seq < DB_EVENT_SEQ_BASE`, §7.3): with `--since-seq <n>`, durable `run.*` rows with `seq > n` (exclusive; `n = -1` replays from row 0) are re-sent **as ordinary `audit` event lines immediately after `watch.hello`, in strict `seq` order**; `watch.hello.replay = {sinceSeq: n, events: <count re-sent>}` announces the window (the rows are never embedded in the hello line itself — a 10⁴-row replay must not become a megabyte line). During this window `watch.hello.resume.auditHeadSeq` stays at `min(n, prefix)` — `n` itself in every normal resume (§7.4); the moment the last announced replay row is written, `watch` emits an **immediate `watch.heartbeat`** advancing `resume.auditHeadSeq` to the new contiguous prefix — the first cursor a consumer may persist past the replay window. The live stream then continues from the head.

**`db.*`-space audit rows are live-only** — they stream when observed but join neither the cursor nor replay: their seqs live in the disjoint 10¹² range, so any single cursor spanning both spaces would re-deliver the entire accumulated `db.*` history on every resume (every `db.backup` ever, each reconnect). A backup/restore that happened while detached is visible in the snapshot's `backup`/`audit` objects anyway. Likewise `job`, `model_call`, `backup`, and `daemon` events have no replay: jobs are *current-state* rows (their transition history is not durably journaled per-transition), and the snapshot already carries current state. This is the kubectl **list+watch** contract: snapshot for state, cursor replay for the one stream that is genuinely append-only. Pretending jobs had a replayable cursor would be a lie about the data model.

`model_calls` rows are durable and could support replay by `(created_at, call_id)`; v1 deliberately omits it — and SP-1 ships **no** `model_calls` read command either (R2, §14). Cost: model calls produced while unattached surface only in the live stream once a watcher is attached; SP-1 provides no detached-window model-call history. Accepted.

### 8.2 Stale cursors (the 410-Gone analog)

V1 can never prune the low end of the ledger: backup bundles are complete-from-origin snapshots and `db restore` atomically replaces the whole file with one (`ledger-backup-contract` §10 — a **head rewind**, never a floor cut); `audit_events` rows are keep-forever (`retention-matrix` rows 15/16 — under `purge` they are tombstoned in place, seq occupancy preserved); no `DELETE FROM audit_events` path exists anywhere. A `--since-seq` cursor therefore cannot point below retained history — the k8s 410-Gone case is **unreachable in V1**, and this spec deliberately ships **no `earliestAvailableSeq` field and no too-old branch** (dormant machinery for an impossible state). **Flagged as deferred, not forgotten:** if a retention policy ever lands, the field returns additively, with that policy — not committed-seq arithmetic — defining the floor's SSOT.

The one real stale-cursor case runs the **other** direction — **cursor above head**: a `db restore` rewound the head below the consumer's persisted cursor. `watch` neither fails nor infers: replay of `seq > n` finds nothing (`replay.events: 0`), the always-sent snapshot is the re-list, and the consumer detects the rewind by `resume.auditHeadSeq < n` and re-baselines — losslessly, since current state comes from the snapshot and the live stream continues from the rewound head. (A restore under an *attached* watcher is caught mid-stream by the §9.1 inode/schema check and §8.3's fresh hello instead.) A gap in committed `run.*` seqs is **never** interpreted as pruning: a hole below the committed maximum is a pending intent §7.4 still delivers (cursor 10, row 12 committed, row 11 pending ⇒ replay opens at 12; row 11 streams live when it lands), and even a permanent gap (a #65-class allocator defect) merely parks the contiguous prefix — duplicates on resume, never loss.

### 8.3 Mid-stream re-attach

If the ledger file vanishes, is atomically replaced at the same path (device/inode change, detected per §9.1), or its schema head changes mid-stream (a `db restore` happened under us), `watch` emits `watch.error (source: "ledger")`, drops its connection, re-probes, and on success emits a **fresh `watch.hello`** (new snapshot, new `resume` cursor — the restore may have rewound `seq`). A consumer treats any `watch.hello` as a full re-baseline. This is also the crash-consistency story: `watch` holds no durable state of its own, so there is nothing to recover — restart and re-baseline.

---

## 9. Change detection

### 9.1 Mechanism

Poll-based, over one **dedicated, transaction-free, read-only** SQLite connection:

**Atomic attach (initial and every re-attach, §8.3).** From one brief read transaction on **the connection that then becomes the steady-state poller** — never a throwaway — `watch` captures a single consistent point: the `watch.hello` snapshot, the four source baselines, the `--since-seq` replay upper bound, and the initial `data_version`. **Every piece of dedup state — the contiguous prefix, the sparse set, the `db.*` and `model_call` emitted-sets, the jobs map — is scoped to one ledger incarnation (one attach epoch): reset and re-seeded here, never carried across a re-attach** (a restore rewind can re-issue seqs an older incarnation already observed; a stale set would suppress the new rows forever, and `db.*` rows are live-only — replay could not recover them). The audit contiguous-prefix is seeded by scanning the existing **`run.*`-space** `seq` set (`db.*`-space rows seed their emitted-set the same way) — rows already present above a gap are marked baseline-seen, so the pre-attach backlog is not replayed but a later gap-fill still emits. It emits `watch.hello` (and any replay bounded by that captured seq), then **closes only the transaction — never the connection**; the poll loop below reuses that same handle transaction-free, so the captured `data_version` stays comparable across the attach→poll handoff. If `data_version` differs on the first tick, a diff runs immediately — no commit landing during attach is lost.

1. Every `pollMs`, read **`PRAGMA data_version`** — its value changes when *any other connection, including connections in separate processes,* commits a change to the database file, and never for our own connection (sqlite.org pragma docs, verbatim scope; see appendix §16.7). In WAL mode the check rides the wal-index in the `-shm` shared memory — no table I/O, no write lock, safe at 2 Hz forever. Two rules make it correct: the polling connection **never holds an open transaction** (inside a read transaction the value is pinned to the snapshot), and values are only compared within one connection's lifetime (they are connection-local; a reconnect re-baselines). Because `data_version` only reflects the inode the connection already holds — an atomic `db restore` that replaces the path leaves the old, possibly-unlinked inode behind it — each tick also `stat()`s the configured ledger path and compares `(device, inode)` and the schema head against the attached handle; any mismatch, or a vanished path, triggers the §8.3 re-attach rather than silently serving the stale ledger.
2. On `data_version` change (or a `ledger.attached` transition), diff the four sources — with cursors built for the fact that **commit order ≠ key order** (§7.4): `audit_events` splits on the two seq spaces (§7.3): the **`run.*` space** (`seq < DB_EVENT_SEQ_BASE`) reads `seq > contiguousPrefix` minus an in-memory sparse emitted-set (so a late-committing lower seq — the reconciler's deferred-intent path guarantees these exist — is emitted on the tick it commits, and nothing is emitted twice), while the **`db.*` space** is diffed against an **incarnation-scoped** emitted-`seq` set (same posture as `model_calls` — a handful of rows, never in the prefix cursor; a restore rewind can legitimately re-issue a `db.*` seq, so this set MUST NOT outlive the attach); `model_calls` is diffed by `call_id` against an **incarnation-scoped emitted-`call_id` set** (same full-scan posture as `jobs` below — correct at the §4 10²–10⁴ scale, immune to a row that commits with an old `created_at` after the cursor moved, which a `created_at` window would silently drop, and free of the eviction-duplicate risk a bounded set carries); `jobs` is a **full-table diff** against the in-memory `jobId → (state, attempts, nextRunAt, updatedAt)` map (no timestamp cursor at all — trivially correct at the §4 scale of 10²–10³ rows, and immune to late commits carrying early `updated_at`); `backup_watermark` is a single-row compare.
3. Emit events per §7.4 ordering; advance the contiguous-prefix cursor + sparse set; update the heartbeat's `resume` (contiguous prefix only, §7.4).

An `fs.watch` on the ledger's `-wal` file MAY be added as a wake-up hint to cut worst-case latency below `pollMs` — it is an optimization, not a correctness mechanism (WAL checkpoints truncate the file; rename/atomic-replace changes the watched inode; macOS FSEvents coalesces). The poll loop is the contract; the watcher only makes it fire early. **v1 recommendation: ship poll-only, add the hint only if 500 ms feels sluggish in the Console** (it will not — human-facing dashboards refresh slower than that).

### 9.2 Why not the alternatives

- **`sqlite3_update_hook`** fires only for changes made through *the same connection* — useless cross-process (the writers are other `brain` processes). Rejected on semantics, not taste.
- **Watching git refs** (`refs/audit/*`, `packed-refs`) would let `watch` see audit appends before the ledger commit — but §7.5's boundary is deliberate: `watch` reports the ledger, and reading the vault repo would add a second source of truth for the same events plus a git dependency the command otherwise doesn't have. Rejected (SSOT).
- **A push channel from writers** (socket/fifo the CLI notifies) is a daemon-shaped coordination surface between every `brain` process and every watcher. Rejected by §3 ("not a daemon") and playground scope.

### 9.3 WAL-mode correctness (documented + locally verified, and still pinned by a test)

The historical worry — WAL does not maintain the page-1 header change counter — is real but irrelevant: `data_version` is not the header counter; in WAL the staleness check rides the wal-index, which is inherently cross-process, and the poller observes a change only after the writer **commits** and the poller's next (implicit) transaction begins — never a dirty read. Both properties are documented and were verified live on this machine (SQLite 3.51, WAL, two separate processes; appendix §16.7). The acceptance test (§13.3) still pins the end-to-end property we actually need (*commit in process A ⇒ event emitted by `watch` in process B within 2×`pollMs`*) so a platform/SQLite regression is caught by CI, not by the Console going quiet. If that ever fires, the fallback is diffing `MAX(seq)`/`MAX(created_at)` per tick — same poll loop, marginally more read I/O, no contract change. The ledger already runs WAL (`sqlite-store` §2.8 requires concurrent readers).

---

## 10. Registry & harness integration

The command surface is data-driven; `watch` lands the same way every phase landed:

1. **Contracts-gate PR** (docs + registry only, no handler):
   - `commands.json`: the §5 row, `implemented: false`, name-sorted (after `validate`).
   - `cli-surface.fixture.txt`: a new phase heading `# Console enablement (Phase 6)` + the line `` `watch` — long-lived NDJSON stream of jobs, model calls, ledger appends, backup watermark, daemon health. ``
   - `watch.schema.json`: the §6/§7 line-union schema with `x-atlas-contract` (`phase: 6`, `privilege: "shared"`, `idempotency: "none"`, `executionClass: "read"`, `exitCodes: [0, 2, 4, 5]`, `prohibitedEffects` per §5.2) and one example per event type.
   - **Harness widening:** `tools/cli-contract.ts` `PHASES = [0..5]` → `[0..6]` — a deliberate one-line change to the never-reverted harness, in the same PR as the first phase-6 row so the widening can never land speculatively. `commands-overview.md` regenerates (`pnpm contract:write`).
   - This spec (the document you are reading).
2. **Implementation PR(s):** handler + `registerCommand` barrel import, flip `implemented: true`. `command-registration.test.ts` (the #145 guard) enforces the flip-with-handler pairing; `checkImplementedSchemas` enforces schema existence; the registry↔fixture↔schema bijection gates (`checkFixtureConsistency` + `validateRegistry`) enforce the fixture row.

`watch` is `privilege: "shared"`, so `checkAuthzContractCompleteness` (privileged ⇔ authzContract bijection) is untouched — no security-broker-contract edit exists in SP-1.

### 10.1 Exit codes for a long-lived stream

The EXIT set caps at 6 and `watch` uses a strict subset — with one deliberate semantic addition for stream termination, following the systemd-258 `journalctl --follow` contract:

| Exit | When |
|---|---|
| `0` | `--once` completed; **or** the stream was ended by `SIGINT`/`SIGTERM`; **or** the consumer closed the pipe (`EPIPE`). Detaching a watcher is success, not failure. |
| `2` | config/vault error at startup (`config-invalid`, `vault-error`) |
| `4` | internal fault (unexpected exception; also a broker *protocol* error during the snapshot probe — never mere unreachability, which is data) |
| `5` | usage (missing `--json`, unknown flag, out-of-range value) |

No exit 7 (nominal provider-retryable — `watch` never talks to a provider), no exit 1/3/6 paths exist. Signal handling is explicit: `SIGINT`/`SIGTERM` flush the current line and exit 0; `EPIPE` on stdout exits 0 quietly (never 141); any other signal keeps default 128+n semantics.

---

## 11. `--json` read-surface conformance audit

SP-2 will consume read commands as an API. Today, schema conformance of live output is asserted piecemeal (some `*.cli.test.ts` files validate against schemas; many don't). SP-1 makes it a bar:

- **Inventory (acceptance artifact):** the audit enumerates every registry row whose schema declares `executionClass` `"read"`, `"audited-read"`, or `"pure"` — the three classes with no mutation surface — **24 commands at spec time**: 16 read (`evidence review`, `git review`, `git status`, `git verify`†, `graduation scan`†, `index eval`†, `index status`, `index verify`, `jobs list`, `note history`, `note related`, `note show`, `quarantine inspect`‡, `source list`, `source show`, `source trust show`), 4 audited-read (`graduation audit`, `inspect`, `query`†, `status`), 4 pure (`db status`, `db verify`, `doctor`, `validate`) — plus `watch` itself (via its per-line union). The sweep test **derives the inventory from the schemas at runtime** (by `executionClass`), so this prose is a snapshot, never a second registry. († = capable of repair/egress side effects per its own schema; the audit validates output shape only. ‡ = privileged; exercised with the test-mode authorization fixtures.)
- **The gate:** one new `apps/cli/test/json-conformance.sweep.test.ts` that, per inventoried command, **arranges the preconditions for a successful run**, drives it `--json`, and validates stdout against the command's `schemaRef` with a draft-2020-12 validator (the dependency already exists for `cli-schemas.test.ts`). **Streaming commands terminate via a per-command invocation adapter:** `watch` — the sole long-lived command — is driven `--json --once` (its bounded snapshot mode, §5) and its single `watch.hello` line validated against the union schema; every non-streaming command runs to natural exit. This keeps the sweep from hanging once `watch`'s row is `implemented`, and its full taxonomy stays covered by the dedicated stream tests (§13.2–§13.5) plus the `watch.schema.json` examples gate (§6). Most commands need only the fixture vault + in-process broker harness; the precondition-heavy ones are enumerated with their arrangements: `index eval` (seeded index + eval-set fixture + the in-process egress harness), `query` (in-process egress harness), `graduation audit` (a prior `graduation scan`'s persisted scan-state), `graduation scan` (the source-copy arrangement the existing graduation tests already build), `quarantine inspect` (a seeded quarantine item + test-mode authorization). A command whose live success output violates its schema fails CI from then on.
- **Fix-forward rule:** any nonconformance the sweep finds is fixed in the SP-1 chain — *output* bugs are fixed in the handler; *schema* bugs (schema stricter/looser than the shipped truth) are fixed in the schema with the diff called out in the PR. Known divergence candidates go in as expected findings rather than surprises: the `jobs list` bare-`Number()` pagination parse (`apps/cli` CLAUDE.md, unresolved divergence) is in scope to route through `commands/pagination.ts`.
- **Non-goals:** mutating commands' `--json` (they have per-command tests and are not SP-2 attach surfaces), human-mode output, and `--plain` rendering are out of scope.

## 12. Security posture

- **No new privilege, no new key, no new socket.** `watch` runs as the same unprivileged identity as every read command (`atlas-agent` under the provisioned layout; the operator's user in a dev checkout), holds no credential, and cannot reach the network (D17 confines the UID regardless of what this command wants).
- **Read-only by construction** (§5.2): `readonly: true` connection, no locks, no git handle, no broker mutation methods. The one broker call (`getAuditChainStatus`) is the existing read-only IPC method `status` already uses.
- **Allowlisted metadata only, with two named free-text exceptions.** Event payloads are ids/states/counts/hashes/timestamps. No `jobs.payload`, no note content, no model text, no file paths beyond the ledger/socket paths the operator already configured (which appear in `watch.hello` and in `daemon` transition events — both operator-owned). The **only** free-text fields in v1 are `job.lastError` (a stored job/provider error string) and `watch.error.message` (a probe exception string); everything else is enum-constrained or a writer-controlled identifier.
- **Terminal-injection stance:** `--json` output is exempt from `render/safe.ts` sanitization by existing convention (`emitJson` writes raw JSON), so the two free-text fields cannot ride that exemption unchecked. JSON string escaping is **not** sufficient on its own — `JSON.stringify` escapes C0 controls but passes C1 controls (e.g. U+009B single-byte CSI) through raw. Therefore `job.lastError` and `watch.error.message` MUST be **escaped over both the C0 *and* C1 control ranges before serialization** (pinned by a test feeding U+009B, §13); any future free-text field inherits the same requirement. **Secret redaction is out of scope for SP-1** (§4: single operator, own vault, one machine — the error text is the operator's own, shown back to the operator's own Console); if a shared/remote consumer ever appears, centralized redaction over these two fields is the additive follow-up.
- **DoS-by-watcher is bounded:** the poll is a header read; a pathological 100 ms `--poll-ms` floor keeps even a misconfigured watcher at 10 header reads/sec against a local file. No backup, no audit append, no broker traffic per tick (daemon probes ride the slower heartbeat cadence).

## 13. Test plan & acceptance (Done when)

Vitest, standard fixture-vault harness (`withFixtureVault` + in-process `BrokerService`), no OS provisioning required; the suite runs on both CI legs (ubuntu + macos) unchanged. `watch` is spawned as a real child process (`dist/bin.js`) for the stream tests — the stream contract *is* the process boundary.

1. **Contract gates (land with the contracts-gate PR):** registry/fixture/schema bijection green with the phase-6 row; `watch.schema.json` examples validate (existing `cli-schemas.test.ts`); overview regenerates deterministically; and a **drift assertion pins `watch.schema.json`'s `eventType` enum equal to the `audit_events` DDL CHECK allowlist** (§7.3 SSOT) so a new audit kind cannot make `watch` emit a value its own schema rejects.
2. **Hello & once:** `--once` emits exactly one `watch.hello` conforming to the schema and exits 0; snapshot equals `status --json`'s summary for the same fixture state on the shared keys — the §7.6 SSOT assertion — with two order-sensitivity guards baked into the test: run `watch --once` **before** `status`, and exclude `audit.headSeq`/`audit.head` from the field-for-field compare (`status` is an audited read whose own `run.readonly` append moves exactly those fields).
3. **Liveness:** with `watch` attached, enqueue a job / finalize an attempt / append an audit event / insert a `model_calls` row / flip the watermark via the harness; assert the corresponding event arrives within 2×`pollMs`, correctly shaped, in per-source order. This is the §9.3 cross-process `data_version` pin (writer = the test process, watcher = the spawned child). A companion case drives the non-ledger emitters: toggle a daemon socket reachable→unreachable→reachable and assert the `daemon` transition events, and induce a recoverable ledger fault (§8.3) to assert a `watch.error` (`source: "ledger"`) followed by continued streaming. **Control-character escaping (§12):** finalize a job whose `lastError` and induce a `watch.error` whose `message` each contain U+009B (single-byte CSI) and a representative C0 control (U+0000); assert the serialized NDJSON escapes both the C0 **and** C1 ranges (never raw terminal controls) while still conforming to the schema.
4. **Replay & its checkpoint:** seed audit rows through terminal seq **N** (rows `0..N` — seqs are zero-based), run `--since-seq k`, assert exactly rows `k+1..N` replay in strict `seq` order and that `watch.hello.replay.events` equals the replayed line count. Assert the **pre-replay checkpoint rule** (§7.4/§8.1): `watch.hello.resume.auditHeadSeq = k` (not N) during replay, followed by an immediate `watch.heartbeat` carrying `resume.auditHeadSeq = N`. **Crash-mid-replay:** kill the consumer after `watch.hello` but before the post-replay heartbeat, restart from the last *persisted* cursor, and assert no row `k+1..N` is skipped (the persisted cursor was still `k`). **Seq-0 pin:** `--since-seq -1` replays from row **0** (run.\* seqs start at 0 — the off-by-one a `≥ 0` floor would hide). **Cursor above head (§8.2):** after simulating a restore rewind, `--since-seq` above the head yields `replay.events: 0` and a hello whose `resume.auditHeadSeq` is below the cursor. **Seq-space split (§8.1):** a seeded `db.*`-space row (`seq ≥ 10¹²`) streams live but never enters `resume.auditHeadSeq` and is never re-sent by any `--since-seq`. **Pending-hole:** with row 12 committed and row 11 a pending intent (§7.4), assert `--since-seq 10` opens replay at 12 with no pruning inference, and that row 11 is emitted live once it commits.
5. **Coalescing & idempotency:** two rapid job transitions inside one poll tick produce one event with the final state; killing and resuming with the last heartbeat's cursor re-delivers no gaps (and only boundary duplicates); a **late-committing audit row** — a higher `seq` committed first, then a lower `pending` seq materialized via `reconcileInterruptedRuns` — is emitted exactly once on the tick it commits, and `resume.auditHeadSeq` stays at the contiguous prefix (never advancing past the gap) until the lower seq lands (§7.4).
6. **Termination:** SIGINT/SIGTERM → exit 0 with a flushed final line; closing the read end (`head -1`-style consumer) → exit 0, no SIGPIPE kill; broken config → exit 2 envelope.
6a. **Flag validation (table-driven):** every §5 constraint has a valid-boundary and invalid-neighbor case — `--poll-ms` {100, 10000 ok; 99, 10001, 0, `1.5`, negative, missing-value → exit 5}, `--heartbeat-seconds` {5, 300 ok; 4, 301, non-integer → exit 5}, `--since-seq` {−1, 0 ok; −2, `2.5`, non-integer → exit 5}, missing `--json` → exit 5, unknown flag → exit 5, and the **mutually-exclusive `--once --since-seq` combination → exit 5** (§5). Each invalid invocation emits **exactly one** conforming error envelope and no event line.
7. **Degradation & restore:** broker socket absent → hello `daemons.broker.reachable: false`, `anchorSource: "sqlite-only"`, stream stays up; **egress** socket absent → `daemon` (`egress`) event only, `anchorSource` unchanged (§5.2); ledger absent → hello `ledger.attached: false`, then attach mid-stream and assert the fresh-hello re-baseline (§8.3). **Atomic restore/rewind:** while attached, replace the ledger at the same path with an older cut whose `seq` is *lower* (a `db restore`); assert the device/inode check (§9.1) fires `watch.error (source: "ledger")` then a fresh `watch.hello` carrying the rewound `resume` cursor, and that the consumer re-baselines cleanly. **Incarnation reset (§9.1):** after that re-attach, commit a new `db.*` row (and a new `run.*` row) whose `seq` the *previous* incarnation already emitted — assert both are emitted again (the dedup state did not survive the re-attach; a stale set would suppress the live-only `db.*` row forever).
8. **Conformance sweep (§11):** the new sweep test passes for all runtime-inventoried commands, each under its §11 arrangement, with any handler/schema fixes landed in-chain.
9. **Live drive (test-live posture):** on this Mac, against the real provisioned install (broker + egress up, real vault): `brain watch --json | head` shows hello + real events while a `brain enrich --apply` run executes in another terminal; kill/re-attach with the printed cursor. Documented as a runbook step in the PR, not automated.
10. **Read-only / prohibited-effects (behavioral, not just schema metadata):** snapshot the ledger's `audit_events` head, `backup_watermark` row, and any lock state *before* attach; run `watch` across attach → ≥1 heartbeat → ≥1 domain event → SIGTERM; assert **none of them changed** — no new `run.readonly` (or any) audit row, no watermark/backup-cadence movement, no lock acquired. Instrument the in-process broker + lock harness to assert the **only** broker call observed is the read-only `getAuditChainStatus` (plus reachability probes) and **no** mutation method or lock acquisition occurred. This is the guard against an implementation that reuses the audited `status` path (which item 2's field-exclusion would otherwise mask).
11. **Fatal-error framing (exit 4):** inject (a) a malformed broker response during the snapshot probe and (b) an unexpected exception after ≥1 event has streamed; assert each yields exit **4**, **exactly one** final `error-envelope.schema.json` line on stdout, **no** success/event line after the fault, and **no** raw stack/exception text — never Node's default exit code.

**Done when** all eleven hold, the contracts-gate + implementation PRs are merged green, and the SP-2 consumer checklist (§14, R1) has no open blocker.

## 14. Open questions — each with a recommendation

| # | Question | Recommendation |
|---|---|---|
| R1 | Should `watch` also emit vault-file-change events (the `git status` working-tree view) so the Console's file browser is live? | **No for SP-1.** It drags a git/FS dependency into a ledger observer (§9.2) and SP-2's file views poll `git status --json`/`note show --json` on focus. Revisit only if SP-2 usability demands it; if it does, it lands as a *new* event type under the same envelope (additive, non-breaking). |
| R2 | Should `model_call` replay exist (`--since-seq` is audit-only)? | **No.** Add a paginated `model_calls` read surface later if the Console's history view needs it (a natural `jobs list`-shaped command); replay-on-attach is redundant transport for SP-1's scope, and the snapshot deliberately carries no model-call summary (§7.2). |
| R3 | Per-event `seq`-like global cursor across ALL streams (opaque composite cursor, journalctl-style)? | **No.** Only `audit` has a real durable cursor; a composite cursor would encode fake exactness for sampled sources (§8.1). Revisit if a source gains a durable per-transition journal. |
| R4 | Should the heartbeat carry the full snapshot (self-healing consumers)? | **No** — heartbeats stay cheap (cursor only). A consumer wanting a re-baseline sends SIGTERM and restarts, or runs `--once`; both are one line of Swift. |
| R5 | `--state`/`--source` server-side filters (`watch --only jobs,audit`)? | **Defer.** At this event volume filtering is a consumer-side `if`; flags multiply the contract surface (and the schema's example matrix) for zero measured need. Additive later. |

## 15. Consequences

- **The never-reverted harness changes shape once:** `PHASES` widens to `[0..6]` and the fixture gains a sixth phase heading. Every future SP-1..SP-3 command rides the same heading; a seventh phase would repeat the pattern. The widening PR is the precedent for "the phase set is append-only."
- **A 51st command class is born:** `watch` introduces the *streaming* execution shape to a registry whose schemas so far describe single-payload outputs. `watch.schema.json` describing a *line* (not a process output) is a contract-vocabulary extension reviewers of future streaming commands will reuse — worth the one-time conceptual cost, contained in one schema.
- **SP-2's coupling surface is now fixed:** the Console attaches to `watch` + the audited read surface; anything it cannot render from those is a gap SP-2 must raise as an atlas-side PR (new event type or new read command), never by importing atlas internals. This is the seam doing its job — but it also means SP-1 findings discovered during SP-2 development will reopen this spec's taxonomy (expected; the envelope is versioned and additive-friendly).
- **The Tier-0 audit taxonomy gains a precedent:** a long-lived read that deliberately emits no `run.readonly` (§5.1). If a future auditor wants observation runs recorded, that is a *policy reversal* with a cost (observer effect + broker coupling) this spec has already argued against — the argument is on the record here.
- **`status`/`doctor` internals get extracted** into shared derivation functions (§7.6) — a small refactor of `apps/cli/src/commands/status.ts`/`doctor.ts` with no behavior change, but it touches audited-read code paths and needs the same review care.
- **The conformance sweep will find real bugs** (that is its point) — expect the `jobs list` pagination divergence and possibly schema/output drift on rarely-exercised read commands to land as fixes in this chain, slightly widening SP-1's diff beyond "one new command."
- **Foreclosed:** nothing architectural. The stream is versioned (`v: 1`), and adding an event type is **backward-compatible by construction**: the `watch.schema.json` line-union gains a member (a superset — every previously-valid line still validates), consumers are required to **ignore unknown `event` values** (pinned in the schema description), and `v` stays `1` — only a *breaking* envelope/taxonomy change (removing or repurposing a field or event) bumps it. A future push-based transport could likewise replace the poll loop behind the same envelope.
- **Deliberately weakened:** cross-source ordering and per-transition job fidelity (§7.4) are sampled, not exact — accepted for a cockpit; anyone needing forensic transition history reads the ledger tables, which remain the system of record.

## 16. Research appendix

Current-source research behind the §6–§10 decisions (retrieved 2026-07-18):

1. **Kubernetes watch protocol** — envelope `{type: ADDED|MODIFIED|DELETED|BOOKMARK|ERROR, object}`; `resourceVersion` resume; BOOKMARK as interval-free checkpoint; `410 Gone` ⇒ re-list + re-watch; bounded watch sessions (`--min-request-timeout` default 1800 s, randomized) with client reconnect-as-normal. *Kubernetes API Concepts* (kubernetes.io/docs/reference/using-api/api-concepts/), *kubectl get* reference (`--output-watch-events`; no CLI `--resource-version` — resume is API-level), *kube-apiserver* reference. → §7.1 heartbeat-as-bookmark, §8.2 snapshot-as-re-list, §7.4 coalescing semantics.
2. **docker/podman events** — `--format json` = JSON Lines; two-axis `Type × Action` taxonomy with `Actor{ID, Attributes}`; `--since/--until` time replay bounded by a 256-event ring (docker) vs journald-persisted (podman `--stream` toggle). *docker system events* (docs.docker.com/reference/cli/docker/system/events/), *podman-events(1)* (docs.podman.io), moby/moby #43694 (retention undocumented). → §8.1's refusal to fake time-based replay for non-journaled sources; `--once` as the `--stream=false` analog.
3. **journalctl cursors** — `__CURSOR` opaque per-entry token; `--after-cursor` exclusive resume; `--cursor-file` stateful loop; `-o json` NDJSON and `-o json-seq` RFC 7464. *journalctl(1)* (man7.org), *systemd Journal Export Formats* (systemd.io/JOURNAL_EXPORT_FORMATS/). → §5 `--since-seq` exclusive semantics (our cursor is transparent because `seq` is already contractual in the DDL).
4. **NDJSON/JSON Lines conventions** — UTF-8 no BOM; one value per `\n` line; terminate the last line; blank lines invalid (jsonlines) / MAY be ignored if documented (ndjson); media type `application/x-ndjson` de facto, `application/jsonl` unregistered as of 2026-07; RFC 7464 `application/json-seq` is the RS-framed IETF alternative for corruption resync. *jsonlines.org*, *github.com/ndjson/ndjson-spec*, *RFC 7464*. → §6 framing.
5. **Heartbeat & backpressure** — SSE keep-alive comment "every 15 seconds or so" (WHATWG HTML spec, server-sent events); gRPC keepalive guidance ≥1 min, server floor 5 min (grpc.io/docs/guides/keepalive/); pipe writes block when full, 64 KiB capacity, ≤`PIPE_BUF` (4 KiB) writes atomic (*pipe(7)*, man7.org); follow-mode CLIs block rather than drop (systemd #9374). → §5 30 s default inside the 15–60 s sanctioned bracket; §6 blocking-write policy; single-line events comfortably under `PIPE_BUF`.
6. **Exit-code precedent for streams** — systemd 258 (2025): "journalctl --follow now exits with success on SIGTERM/SIGINT and when the pipe it is writing to is disconnected" (systemd v258 NEWS; issues #30995, #38114); POSIX 128+n signal reporting (POSIX.1-2017 XCU §2.8.2); systemd.service(5) counts SIGHUP/SIGINT/SIGTERM/SIGPIPE as clean for long-running services; ping exits 0 on Ctrl-C with replies (*ping(8)*). → §10.1.
7. **Cross-process SQLite change detection** — `PRAGMA data_version`: "different if changes were committed to the database by any other connection in the interim … The behavior … is the same for all database connections, **including database connections in separate processes**" (sqlite.org/pragma.html#pragma_data_version, verbatim); the 3.8.8 release log introduces it as detecting modification "by another **process**" (sqlite.org/releaselog/3_8_8.html); WAL does not use the header change counter — the check rides the wal-index in shared memory (sqlite.org/fileformat2.html §1.3.7; D. R. Hipp, sqlite forum ca055f9bd345bdd3), so the pragma works in WAL and reflects only *committed* writes at the poller's next transaction (sqlite.org/wal.html snapshot isolation). Verified empirically on this machine 2026-07-18 (SQLite 3.51.0, WAL, two processes: 3 → external commit → 4; own writes: unchanged; open read txn pins the value until COMMIT). `sqlite3_update_hook` is same-connection only (sqlite.org/c3ref/update_hook.html; sqlite forum b77046785208132f) — rejected on semantics. Poll-cadence prior art: Litestream polls the WAL at a 1 s `DefaultMonitorInterval` (github.com/benbjohnson/litestream `db.go`), chokidar polls at 100 ms — the 500 ms default sits inside the precedent band. FS-watch caveats (checkpoint overwrites the WAL from offset 0 and may truncate it, sqlite.org/wal.html + pragma `wal_checkpoint`; `fs.watch` follows the inode so rename-replaced files go silent — watch directories, nodejs.org fs "Inodes" caveat; macOS FSEvents delivery is deliberately latency-coalesced, Apple FSEvents.h) → hint-only role, §9.1.
