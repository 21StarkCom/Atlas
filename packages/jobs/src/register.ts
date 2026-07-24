/**
 * `@atlas/jobs` migration registration — the composition-root seam (plan §2.7,
 * Review-Hint "registerJobsMigration must run at the composition root before
 * store.migrate() (no undiscoverable migration)").
 *
 * `@atlas/sqlite-store` OWNS `0001_core`/`0003`/`0004` and pre-registers them in
 * `openStore`; it deliberately does NOT know about `0002_jobs`. The CLI
 * composition root (`apps/cli/src/main.ts`, which imports `@atlas/jobs`) instead
 * registers `0002` on the `Store` BEFORE `Store.migrate()`, so `db migrate`
 * discovers it through the normal checksum-guarded, gap-tolerant runner. This is
 * the identical pattern the workflows layer uses for `0006_workflow_idempotency`
 * (`registerWorkflowMigrations`/`openWorkflowStore`).
 */
import { randomUUID } from "node:crypto";
import { openStore, type SqliteConfig, type Store } from "@atlas/sqlite-store";
import { migration0002Jobs } from "../migrations/0002_jobs.js";
import { migration0007JobCancellations } from "../migrations/0007_job_cancellations.js";
import { bindEnqueueContext, type EnqueueContext } from "./repo.js";

/**
 * The jobs-contract §2 default attempt budget (mirrors the CLI config default
 * `jobs.max_attempts` = 5). Used by {@link productionEnqueueContext} when a caller
 * does not inject a config-driven budget.
 */
export const DEFAULT_MAX_ATTEMPTS = 5;

/**
 * Build the PRODUCTION {@link EnqueueContext} — the real, non-deterministic seams
 * ({@link enqueue}'s clock + id generator + default attempt budget) that back the
 * plan's 2-arg public `enqueue(tx, job): JobId` signature. {@link openJobsStore} binds
 * this on every store it opens so a downstream enqueuer (Task 2.6 capture, #32) calling
 * the plan's 2-arg form JUST WORKS in production — it never has to know about the seam.
 *
 * `overrides` lets the CLI composition root inject a config-driven `defaultMaxAttempts`
 * (or a controlled clock/id in a test) while keeping the wall-clock UTC `now` + a random
 * UUID id generator as the production defaults.
 */
export function productionEnqueueContext(overrides: Partial<EnqueueContext> = {}): EnqueueContext {
  return {
    now: overrides.now ?? (() => new Date().toISOString()),
    nextJobId: overrides.nextJobId ?? (() => randomUUID()),
    defaultMaxAttempts: overrides.defaultMaxAttempts ?? DEFAULT_MAX_ATTEMPTS,
  };
}

/**
 * Register the jobs-owned `0002_jobs` migration on a `Store`. Call at STORE-OPEN,
 * BEFORE {@link Store.migrate}, so the queue tables are applied through the normal
 * checksum-guarded runner — never ad-hoc during a command.
 */
export function registerJobsMigration(store: Store): void {
  store.registerMigration(migration0002Jobs);
  store.registerMigration(migration0007JobCancellations);
  // v2 (#338): the AEAD backup/verify subsystem is retired, so the schema-head
  // self-recognition (`registerKnownSchemaHead`) it needed is gone with it.
}

/**
 * The PRODUCTION store-open lifecycle for the jobs layer. A jobs command opens the
 * ledger through THIS path — open the store, register `0002_jobs` (+ `0007`), apply
 * migrations, and BIND the production {@link EnqueueContext} on the connection — so the
 * `jobs`/`job_attempts` tables are GUARANTEED present at store-open AND the plan's 2-arg
 * `enqueue(tx, job)` works in production, not merely when a test harness registers the
 * tables and binds a context by hand (wing finding 1). The returned store is fully
 * migrated (the default retained set + `0002`/`0007`) with an enqueue context bound; the
 * caller owns closing it. `opts.enqueueContext` lets the composition root inject a
 * config-driven `defaultMaxAttempts` (or a deterministic clock/id in a test); a later
 * {@link bindEnqueueContext} on the same connection replaces the binding.
 */
export function openJobsStore(cfg: SqliteConfig, opts: { enqueueContext?: Partial<EnqueueContext> } = {}): Store {
  const store = openStore(cfg);
  registerJobsMigration(store);
  store.migrate();
  bindEnqueueContext(store.db, productionEnqueueContext(opts.enqueueContext));
  return store;
}
