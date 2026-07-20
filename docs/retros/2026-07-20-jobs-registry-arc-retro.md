# Jobs Handler Registry Arc — Retro

**Date:** 2026-07-20 · **Issues:** #216 (production registry), #217 (reverify `recoverAnchor`), #218 (trust read surface) · **PRs:** #278 (cherry-pick of `54b9d5b`), #288 (`6ed6b85`), #291 (`6012a87`)

## Outcome

Three defects closed. Every enqueued workflow now executes, `reverify` re-anchoring auto-integrates, and a promoted source reads back as trusted. The arc's real payoff was an **E2E-only catch invisible to every seam test**: a ledger sequence-space partition bug, live since #216, where one `brain evidence retry` could brick every later broker-anchored run. That bug is fixed and the fix **self-heals** a poisoned vault on first reconcile — no manual cleanup.

## The three defects

- **#216 — empty production registry.** `apps/cli/src/commands/jobs.ts` shipped `JOB_HANDLERS = {}`; only the env-gated test handler was registered. Every enqueued job failed `internal` on drain. Worse: the runner's "no handler" path is classified **transient** (`runner.ts` → `classifyError`), so a permanent misconfig burned its whole attempt budget with backoff before exit 4. The one user-reachable instance was `brain evidence retry` → `reverify`. Fixed with a ctx-parameterized registry (`apps/cli/src/commands/job-handlers.ts`) built **per-drain** — handlers close over `{ctx, store}` and resolve deps lazily, so the completeness gate can build the whole registry with a stub. New gate `test/jobs.registry-completeness.test.ts` binds the enqueue-side constants to the registry. Superseded into #278 as prerequisite for the #60 Phase-3 `index:reconcile` handler; single commit `54b9d5b` cherry-picked unmodified.
- **#217 — `reverify` re-anchor stubbed to null.** The #216 slice fixed the budget-burn but stubbed `recoverAnchor` to `null`, so every re-anchor failed closed to pending/human-resolve. Now wired (`apps/cli/src/workflows/reverify-recover.ts`): re-normalize the canonical-ref blob bytes through the **real sandbox**, prove output == requested rendition, hash-verify the old `char:` locator range against `quote_hash` in the NEW text. Old rendition text is unregenerable (versions are code constants; quote text is persisted nowhere) — every doubt ⇒ null ⇒ pending Tier-3. Multi-head applies read notes **at canonical** with a fresh resolver per read; surrogate-boundary guard against lossy UTF-8 hash collisions; `char:`-only (byte: has UTF-16 divergence).
- **#218 — trust read surface hardcoded untrusted.** `source.ts` returned `untrusted` regardless of the projection, so successful promotions were invisible on read. Wired to `readTrustState`/`readTrustRecord`. History = the latest transition ONLY — the Phase-1 trust ledger is authorize-only, no commit ever lands on `refs/trust/ledger`, so the projection row is everything persisted.

## The big catch — ledger seq-space partition (E2E-only)

`evidence.retry_enqueued` allocates in the **DB-internal** range (`seq >= DB_EVENT_SEQ_BASE`, `1_000_000_000_000`), but run-space seq readers were partitioned by a **type-prefix** predicate (`NOT LIKE 'db.%'`) instead of the numeric range. So one `brain evidence retry` poisoned `nextRunSeq`: every later broker-anchored run was refused `broker.audit_seq_nonmonotonic`, and `anchor-check` raised false truncation alarms.

**Why no seam test caught it:** the poison only manifests across a *sequence of runs* through the real ledger — a fresh in-process store never crosses the DB-internal allocation with a subsequent broker-anchored run. Only the full E2E harness (`Phase2Harness` + `runCli`) reproduced it.

**Fix:** partition by the numeric range `seq < DB_EVENT_SEQ_BASE` everywhere — `intents.ts` (the `nextRunSeq` allocator's UNION arms), `anchor-check.ts` (truncation count), `reconcile.ts` (the self-heal path). A pre-fix-poisoned vault now **self-heals on first reconcile**: stranded intents at `>= DB_EVENT_SEQ_BASE` are deleted, the poisoned watermark is reset and re-covered, and the reconciler's allocation probe is range-partitioned. No operator step required.

## Design calls (verified sound)

- **`reverify` emits a ChangePlan, not a `commit`-closure.** A bare projection write is lost on `db rebuild`; the SSOT wins over the generic runner doc note.
- **`trust-remediation` structurally cannot auto-apply.** `JobHandlerDeps` is `{ctx, store}` — no broker, no repo. It parks a Tier-3 proposal; it can never mutate trust on its own.
- **Test handler spread FIRST, never last.** The env-gated `jobs-test-handler.ts` keeps a separate import-time seam and is merged ahead of the production map so it can never shadow a production workflow.

## E2E harness gotchas (for the next drive)

- Quarantine dir must live **outside** `h.root` — `repositoryRoot` falls back to cwd.
- Custody `agent/` needs `0700`; the key file needs `0600`.
- Sandbox suites need the #29 loud-skip gate — hosted Linux has no cgroup delegation; **macOS CI is the strict platform**.

## Verification

Verified by the lead, not agents: full `@atlas/cli` suite **903 pass / 1 skip**; `pnpm -r build` clean; `gen-cli-contract --check` clean. #218 review: 1 ultracode round, 0 confirmed findings. #217 review: 2 rounds, 11 findings, all fixed and posted on the PR.

## Lesson

**Seam tests can't see cross-run ledger state.** A permanent misconfig hiding behind a transient error classification (#216) and a seq-space partition that only poisons *the next* run (the big catch) both slipped every in-process test and surfaced only under the real E2E harness. When a bug lives in the durable ledger's accumulated state, the seam is blind — drive it E2E.
