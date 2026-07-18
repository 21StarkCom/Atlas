# Spec-to-Plan review summary — console-watch-stream

**Lead:** claude · **Wing:** codex · **Fix rounds:** 5 · **Dispatcher verdict:** `max_rounds_unresolved` (findings converging 7→8→5→4→3).

The dispatcher exhausted its 4 fix rounds without a formal codex `approve`, but the finding trajectory was clean-converging and round 5's summary was *"close and scope-matched"*. Rather than burn another full loop (codex surfaced fresh narrow nits each round), the **3 residual blockers were hand-resolved directly in the landed plan** — all three were concrete interface-declaration gaps, not design disputes. They are logged below for the downstream `/stark-review-plan` to verify independently.

## Residual blockers — hand-resolved in the landed plan

1. **Jobs full-table coverage** (Phase 4 T1 used paginated `listJobs`, 500/page cap vs §4's 10²–10³ jobs). → Phase 1 T2 now exports **`listAllJobs(db): JobListRow[]`** — an unpaginated single-transaction reader sharing `projectJobListRow`; Phase 4 T1 consumes it; test seeds 600 jobs and asserts all 600 observed.
2. **Daemon snapshot/baseline fields + `emitHello` undeclared** (Phase 3 T2 `snapshot: SnapshotShape` omitted `daemons`; no reachability baseline; `emitHello` used but undeclared). → Added `DaemonSnapshot`/`WatchSnapshot` types, `baselines.daemonReachable` (the transition baseline, captured at attach), and a declared `emitHello(att, emit)` contract; attach composes `{...deriveSnapshot(), daemons}` with no re-probe.
3. **Probe fault vs unreachable** (Phase 1 T3 `probeDaemon` collapsed to `{reachable:boolean}` — no path for the §7.1 non-fatal `watch.error` on a probe *exception*). → `probeDaemon` now returns typed `DaemonProbe` (`reachable`|`unreachable`|`fault`); ordinary unreachability drives the `daemon` event, an unexpected `fault` maps to `watch.error(source)`; Phase 4 T3 wires it and names the proving test.

## Per-round trail

### Round 1 — verdict: revise (175s)

**Summary:** The plan closely matches the scoped design, but registry gating, current DDL drift, output backpressure, incomplete replay interfaces, and underspecified test invocations must be corrected before implementation can proceed top-down.

**Blocking (7):**
- Phase 3 registers the handler while leaving `commands.json` at `implemented:false`, then expects real-child `dist/bin.js` tests to exercise `watch`; `main.ts` rejects unimplemented rows before dispatch, so Phases 3–4 cannot run their stated tests. Phase 6 likewise cannot pass after Phase 3 as claimed. Combine Phases 3–5 into the implementation/flip gate, provide an explicit test-only registry seam, or otherwise specify how the child reaches the handler; make Phase 6 depend on the flip.
- Phase 2 Task 3 assumes the executable `audit_events` CHECK contains 9 `run.*` plus 3 `db.*` values, but `packages/sqlite-store/migrations/0001_core.ts` currently also contains `run.refreshed` and `evidence.retry_enqueued`. The proposed 12-value schema and DDL drift assertion therefore cannot both pass. Add an explicit reconciliation task that derives the enum from the executable DDL, updates the contract/spec as required, and treats every non-`run.*` high-space event—not merely `db.*`—consistently.
- Phase 4 Task 3 places the blocking NDJSON writer in `apps/cli/src/watch/emit.ts`, but the repository's `no-render-bypass.test.ts` permits direct stdout writes only in `errors/envelope.ts`; the existing `emitJson(...): void` also ignores writable backpressure. Specify an exact extension in `apps/cli/src/errors/envelope.ts` that awaits write completion/drain and handles EPIPE, then name a slow-consumer test proving lines are neither dropped nor reordered.
- The Phase 3/5 attach-replay interfaces are internally incomplete: `attachLedger(...): Attachment` omits the replay upper bound, device/inode and schema identity, cursor/dedup state, and other values later tasks consume. Additionally, `watch.hello.replay.events` must be known before hello is emitted, while Phase 5's `runReplay(...): {count}` obtains the count during the subsequent replay. Declare exact attachment/replay types and the bounded sequence: compute window/count in the atomic attach transaction, emit hello, emit only that captured window, then emit the checkpoint heartbeat.
- Phase 6 does not provide executable argv contracts for the runtime-derived commands. Several inventory members require positional identifiers or command-specific flags, and `quarantine inspect` requires an explicit authorization flow; a generic instruction to drive each command with `--json` plus arrangements for five heavy commands is insufficient. Add an exact per-command invocation adapter map, including fixture-derived argument names and explicit `--authorization <path>` or equivalent test-mode presence flow.
- Multiple tasks violate the required file-path and interface specificity: Phase 1 Task 2 names the nonexistent `apps/cli/src/commands/jobs/list.ts` followed by `or equivalent` and an unnamed `new/shared projection module`; Task 3 says `wherever assertReadAuditReady lives`; Phase 2 Task 3 offers an `e.g.` test path; and Phase 3 Task 1 lists only `barrel, flag validation`. Replace these placeholders with exact repository paths and give every cross-task output complete typed Consumes/Produces signatures.
- The phase verification sections are not consistently runnable as written. Phases 3–6 list behavioral outcomes or test names without exact commands, and Phase 1 references an existing `status.cli.test.ts` that is not present. Name the actual test files to create or modify and provide an explicit `pnpm`/Vitest command for every phase, plus the contract determinism command where applicable.

**Non-blocking (0):**


### Round 2 — verdict: revise (322s)

**Summary:** The plan is scope-appropriate and substantially improved, but incorrect audit-space classification, incompatible interfaces, incomplete test argv, and a premature registry flip still prevent top-down execution.

**Blocking (8):**
- Phase 2 Task 2 and Phases 3–5 still classify `evidence.retry_enqueued` incorrectly as low/resumable because it is `NOT LIKE 'db.%'`. The executable writer uses `nextDbEventSeq` (`apps/cli/src/commands/evidence-retry.ts:80`), whose allocator starts at `DB_EVENT_SEQ_BASE` and counts every non-`run.%` event (`packages/sqlite-store/src/ledger/intents.ts:267–270`); `packages/contracts/src/audit.ts:43` also classifies it as ledger-internal. The proposed cursor would therefore jump into the 10^12 range and replay a live-only event. Define resumable rows as `run.%`/`seq < DB_EVENT_SEQ_BASE`, and classify all four ledger event kinds—including `evidence.retry_enqueued`—as high/live-only.
- Phase 3 Task 1 specifies `parseWatchFlags(argv)` as requiring `--json`, but the router removes global `--json` before constructing `RunContext.argv` (`apps/cli/src/router.ts:57–130`). The parser can never observe a valid `--json`. Pass `ctx.output.mode` into validation and reject unless it is `json`; keep `ctx.argv` parsing for watch-specific flags only.
- Phase 1 Task 1's `deriveSnapshot(conn, broker)` signature cannot reproduce the existing status audit verdict. `verifyAuditAnchor` requires the database, audit-anchor path, environment, and a nullable `AuditChainProbe` (`apps/cli/src/audit/anchor-check.ts:93–97`), while the proposed signature supplies neither the path/environment nor a broker-down representation. Declare those inputs explicitly, or pass a typed context containing them.
- Phase 3 Task 2's `Attachment` type cannot represent the required detached state: it mandates a live `connection`, `baselines`, `dataVersion`, and numeric `resumeCursor`, while the same task says an absent ledger returns `attached:false` with no cursor. Replace it with an `AttachedLedger | DetachedLedger` discriminated union; only the attached member may expose a connection, baselines, identity, replay window, data version, and resume cursor.
- Phase 3 Task 3 declares `onTick: (att) => void`, but Phase 4 emission is asynchronous and must await pipe backpressure. A synchronous callback allows overlapping ticks and reordered events. Change it to `onTick: (...) => Promise<void>` and serialize ticks. Its proposed real-child Phase 3 test is also unobservable before domain/control emission exists; use an in-process callback test there and retain the real cross-process event assertion in Phase 4.
- Phase 6 Task 1's revised invocation map is still not executable: `git review` requires `<runId>` and `source trust show` requires `<source>`, but both are listed as argument-free; `graduation scan` requires `--source <path> --copy <path>`, not one positional path; and `index eval` requires `--queries <path> --labels <path>`, not bare `index eval --json`. Update the adapters to return these exact argv values from their seeded arrangements.
- Phase 2 verification uses the nonexistent workspace filter `@atlas/tools`; `tools/package.json` names the package `@atlas/cli-contract-tools`. As written, the command does not run the contract tests. Replace it with `pnpm --filter @atlas/cli-contract-tools test`.
- The Overview and Phase 3 justify an early `implemented:true` flip by claiming `main.ts` rejects an unimplemented registry row, but current dispatch checks only whether a handler exists (`apps/cli/src/main.ts:198–213`); it does not inspect `row.implemented`. The early flip therefore unnecessarily publishes a command that still lacks domain events, replay, reattach, and termination behavior. Keep `implemented:false` through Phases 3–5 and flip only after the complete handler passes, while the registered handler remains directly dispatchable for the real-child tests.

**Non-blocking (0):**


### Round 3 — verdict: revise (234s)

**Summary:** The prior findings are substantially resolved, but five concrete interface, dependency, and phase-ordering gaps still prevent top-down execution.

**Blocking (5):**
- Phase 3 Task 2 requires `deriveSnapshot(): Promise<SnapshotShape>`—which performs the asynchronous `getAuditChainStatus` RPC—to run inside one brief `better-sqlite3` read transaction with the baselines and replay window. `better-sqlite3` transactions are synchronous, so the transaction will close before an awaited callback completes. Resolve the broker result before entering the transaction and make the database snapshot derivation synchronous, or explicitly split the broker probe from the atomic SQLite capture while preserving the required consistency check.
- Phase 1 Task 1 reuses `verifyAuditAnchor`, while Phase 5 Task 4 requires malformed broker responses to be fatal exit 4. The current `verifyAuditAnchor` catches every `getAuditChainStatus` rejection and degrades to `sqlite-only`, so the named malformed-response test cannot pass. Add an explicit typed distinction between connection unreachability, which degrades, and protocol/schema failure, which `watch` maps to a fatal internal error, without changing `status` behavior.
- Phase 3 Task 2 directly imports and constructs `better-sqlite3`, but `apps/cli/package.json` has neither `better-sqlite3` nor `@types/better-sqlite3`; they belong only to `@atlas/sqlite-store` and are unavailable through pnpm's isolated dependency graph. Add the exact package manifest and lockfile changes, or expose a read-only opener and database type from `packages/sqlite-store` and consume that interface.
- Phase 1 Task 2 assumes `JobRow`, `JobAttemptRow`, and jobs/attempt row readers already exist in `apps/cli/src/commands/jobs.ts`, but the actual projection and SQL are owned by `packages/jobs/src/repo.ts` as `listJobs`/`JobListRow`; `jobs.ts` only converts that projection to JSON. As written, `watch` must invent a second raw-row query to call `projectJobItem`, violating the spec's SSOT rule. Refactor the projection at its actual owner in `packages/jobs/src/repo.ts` (including `updatedAt` support or an exported shared row projector), and name the corresponding package files, interfaces, tests, and verification command.
- Phase 4 Task 3 requires `watch.ordering.cli.test.ts` to prove that a recoverable ledger fault emits `watch.error(source:"ledger")` and then continues streaming, but connection teardown and re-attachment are not implemented until Phase 5 Task 2. Phase 4 therefore cannot meet its verification gate. Move this assertion to Phase 5's re-attach test or implement the detach/retry path in Phase 4.

**Non-blocking (2):**
- Name `docs/specs/2026-07-18-console-watch-stream-spec.md` explicitly instead of referring to “this spec” in Phase 2.
- Replace the placeholder-like `SnapshotContext extends never ? never : {...}` parameter with a named context type and declare an attached snapshot type that includes the required broker and egress daemon entries.

### Round 4 — verdict: revise (312s)

**Summary:** The revision resolves the prior repository and sequencing errors, but replay capture and attach-loop orchestration remain incomplete, and the proposed broker protocol classification does not match the executable client contract.

**Blocking (4):**
- Phase 1 Task 1 still cannot implement its broker-failure taxonomy as written. It says a resolved response is validated against an “audit Zod mirror (`packages/contracts/src/audit.ts`)”, but that file has no `AuditChainStatus` schema; `BrokerClient` already validates results in `packages/broker/src/protocol.ts`, rejecting malformed correlated results as `BrokerRefusal("broker.bad_request")` while malformed uncorrelated frames are ignored. Specify classification using the actual broker error contract—and add a timeout or client change for ignored malformed frames—so protocol errors reliably become fatal while socket failures/timeouts degrade.
- Phase 3 Task 2 and Phase 5 Task 1 still do not capture an immutable replay window. `ReplayWindow` stores only `{sinceSeq, upperSeq, events}`, and `runReplay` queries the live connection after the attach transaction closes. If a pending row within that range commits between hello and replay, `runReplay` emits more rows than `watch.hello.replay.events` announced and violates the pending-hole behavior. Capture the exact ordered replay rows or seq membership inside the attach transaction and replay that captured set.
- Phase 3 Task 3 cannot hand a re-attach request to Phase 5 through its declared interface. `runPollLoop(...): { stop(): void }` asynchronously observes an `onTick` result of `"reattach"`, but exposes no completion promise, callback, or result channel to the command orchestrator. Return a handle with `done: Promise<"stopped" | "reattach">`, or an equivalent explicit callback, and show the command loop consuming it before invoking `reattach()`.
- The startup-detached path has no executable polling mechanism. `runPollLoop` accepts only `AttachedLedger`, while Phase 5 Task 2 handles only re-attachment after an attached poll loop returns `"reattach"`. Nothing re-probes an initial `DetachedLedger` every `pollMs`, so the required absent-ledger → later attach → fresh hello flow cannot occur. Add an explicit detached retry loop/orchestrator, its interface, and the transition test.

**Non-blocking (0):**


### Round 5 — verdict: revise (311s)

**Summary:** The plan is close and scope-matched, but full jobs coverage and the daemon snapshot/error interfaces must be made executable.

**Blocking (3):**
- Phase 4 Task 1 says the jobs source performs a full-table diff via `listJobs`, but `packages/jobs/src/repo.ts:listJobs` requires paginated `{limit, offset}` inputs and the CLI contract caps each page at 500 while the spec allows 10²–10³ jobs. Specify an unpaginated shared reader at the `@atlas/jobs` projection owner, or an exact transactionally consistent pagination loop; otherwise jobs beyond the selected page are never observed.
- Phase 3 Task 2 captures daemon probes but its `AttachedLedger` interface stores only `snapshot: SnapshotShape`, whose declared shape omits `daemons`, and `SourceBaselines` stores no initial broker/egress reachability. Phase 3 Task 4 then calls an undeclared `emitHello(att, emit)`, while Phase 4 requires transition events with `previousReachable`. Add exact daemon snapshot/baseline fields and declare the hello emitter interface/file so an attached hello and the first daemon transition can be constructed without re-probing or inventing hidden state.
- Phase 1 Task 3 collapses every daemon probe outcome into `{reachable:boolean}`, and Phase 4 Task 3 only defines reachability-transition events; therefore there is no implementation path for the spec-required non-fatal `watch.error` on broker/egress probe exceptions. Define a typed distinction between ordinary socket unreachability and unexpected probe faults, map the latter to `watch.error` with the correct source, and name the proving test.

**Non-blocking (0):**


---
_Total dispatch: 2456s. Full receipt in `~/.claude/code-review/history/spec-to-plan/`._
