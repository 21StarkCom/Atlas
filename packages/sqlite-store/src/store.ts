/**
 * `store` — `openStore(cfg): Store`, the package's public handle.
 *
 * `Store` bundles the connection with the migration runner, the projection
 * rebuild pipeline, `verify`, and the repositories. The `0001_core` and the
 * retained-PR-A `0003_provenance` migrations are registered on open (so the
 * public `migrate()`/`rebuildProjections()` path creates the provenance tables
 * and the fold is never a silent no-op, §2.7); `@atlas/jobs` registers `0002`
 * via {@link Store.registerMigration} before calling {@link Store.migrate}. The
 * gap-tolerant runner (Task 1.4) applies `0003` even though `0002` is absent —
 * do NOT assume contiguous numbering.
 */
import type { VaultSnapshot } from "@atlas/contracts";
import { openConnection, type SqliteConfig, type SqliteDatabase } from "./connection.js";
import { runMigrations, type Migration, type MigrationReport } from "./migrate.js";
import { rebuildProjections, type RebuildOptions, type RebuildReport } from "./rebuild.js";
import { verify, type VerifyReport } from "./verify.js";
import { LedgerRepo } from "./repos/ledger.js";
import { ProjectionRepo } from "./repos/projections.js";
import { ProvenanceRepo } from "./repos/provenance.js";
import { migration0001Core } from "../migrations/0001_core.js";
import { migration0003Provenance } from "../migrations/0003_provenance.js";
// Side-effect import: registers `foldProvenanceManifests` into the rebuild
// pipeline (retained PR-A §2.7) so `rebuildProjections`/`db rebuild` reproduce
// the provenance projections from canonical Markdown manifests.
import "./provenance/fold.js";

/** A wall-clock supplier for `applied_at` timestamps (injectable for tests). */
export type Clock = () => string;

/** The persistence core handle. */
export interface Store {
  /** The underlying `better-sqlite3` connection (for repos + higher tasks). */
  readonly db: SqliteDatabase;
  /** Projection-table repository. */
  readonly projections: ProjectionRepo;
  /** Ledger-table repository. */
  readonly ledger: LedgerRepo;
  /** Provenance-projection repository (`0003_provenance`). */
  readonly provenance: ProvenanceRepo;
  /** Register a migration (jobs registers `0002` here). */
  registerMigration(m: Migration): void;
  /** Apply all registered-but-unapplied migrations (gap-tolerant). */
  migrate(): MigrationReport;
  /** Transactionally rebuild the vault projections from a snapshot. */
  rebuildProjections(snapshot: VaultSnapshot, options?: RebuildOptions): RebuildReport;
  /** Run the invariant + query-plan checks. */
  verify(): VerifyReport;
  /** Close the connection. */
  close(): void;
}

function rfc3339Now(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Open a store. `0001_core` + `0003_provenance` are pre-registered; call
 * {@link Store.migrate} to apply them (and any later-registered migrations).
 */
export function openStore(cfg: SqliteConfig, clock: Clock = rfc3339Now): Store {
  const db = openConnection(cfg);
  const migrations = new Map<string, Migration>();
  migrations.set(migration0001Core.id, migration0001Core);
  migrations.set(migration0003Provenance.id, migration0003Provenance);

  return {
    db,
    projections: new ProjectionRepo(db),
    ledger: new LedgerRepo(db),
    provenance: new ProvenanceRepo(db),
    registerMigration(m: Migration): void {
      const existing = migrations.get(m.id);
      if (existing && existing.checksum !== m.checksum) {
        throw new Error(
          `migration ${m.id} already registered with a different checksum ` +
            `(${existing.checksum} != ${m.checksum})`,
        );
      }
      migrations.set(m.id, m);
    },
    migrate(): MigrationReport {
      return runMigrations(db, [...migrations.values()], clock);
    },
    rebuildProjections(snapshot: VaultSnapshot, options?: RebuildOptions): RebuildReport {
      return rebuildProjections(db, snapshot, options);
    },
    verify(): VerifyReport {
      return verify(db);
    },
    close(): void {
      db.close();
    },
  };
}
