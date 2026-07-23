/**
 * `store` — `openStore(cfg): Store`, the package's public handle.
 *
 * `Store` bundles the connection with the migration runner, the projection
 * rebuild pipeline, `verify`, and the repositories. The `0001_core`, the
 * retained-PR-A `0003_provenance` + `0004_claims`, the `0005_ledger_finalize`,
 * the core `0013_links_v2` (v2 `note_links` reshape), and the core
 * `0014_evidence_v2` (v2 vault-derived `evidence` projection) migrations are
 * registered on open (so the public `migrate()`/`rebuildProjections()` path
 * creates the provenance + claims tables and neither fold is ever a silent no-op, §2.7 /
 * §4.1); `@atlas/jobs` registers `0002` via {@link Store.registerMigration}
 * before calling {@link Store.migrate}. The gap-tolerant runner (Task 1.4)
 * applies `0003`/`0004` even though `0002` is absent — do NOT assume contiguous
 * numbering.
 */
import type { VaultSnapshot } from "@atlas/contracts";
import { openConnection, type SqliteConfig, type SqliteDatabase } from "./connection.js";
import { runMigrations, type Migration, type MigrationReport } from "./migrate.js";
import { rebuildProjections, type RebuildOptions, type RebuildReport } from "./rebuild.js";
import { verify, type VerifyReport } from "./verify.js";
import { LedgerRepo } from "./repos/ledger.js";
import { ProjectionRepo } from "./repos/projections.js";
import { ProvenanceRepo } from "./repos/provenance.js";
import { ClaimsRepo } from "./repos/claims.js";
import { GenerationRepo } from "./repos/generation.js";
import { migration0001Core } from "../migrations/0001_core.js";
import { migration0003Provenance } from "../migrations/0003_provenance.js";
import { migration0004Claims } from "../migrations/0004_claims.js";
import { migration0005LedgerFinalize } from "../migrations/0005_ledger_finalize.js";
import { migration0008IndexConfigRevision } from "../migrations/0008_index_config_revision.js";
import { migration0012SyncCursors } from "../migrations/0012_sync_cursors.js";
import { migration0013LinksV2 } from "../migrations/0013_links_v2.js";
import { migration0014EvidenceV2 } from "../migrations/0014_evidence_v2.js";
// Side-effect imports: register the retained-PR-A projection folds into the
// rebuild pipeline (§2.7 / §4.1) so `rebuildProjections`/`db rebuild` reproduce
// the provenance + claims projections from canonical Markdown. Provenance is
// imported first so its fold runs before the claims fold, which pins existing
// renditions its evidence references.
import "./provenance/fold.js";
import "./claims/fold.js";

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
  /** Claims-projection repository (`0004_claims`). */
  readonly claims: ClaimsRepo;
  /** Retrieval-index generation fence repository — the sole activation authority (Task 3.2). */
  readonly generation: GenerationRepo;
  /**
   * Activate a retrieval index generation via the SQLite CAS (Task 3.2) — SQLite
   * is the sole activation authority (not LanceDB). Delegates to
   * {@link GenerationRepo.activateGeneration}: sets `active_generation_id = gen` +
   * `active_generation = <config epoch>` iff the note's `content_hash` still equals
   * `expectedContentHash` AND the config's live epoch `>= active_generation`. The
   * epoch is resolved server-side from `configKey` (never a caller-supplied
   * integer), so it cannot be inflated. Returns `true` iff the generation is now
   * live. See {@link GenerationRepo} for the fence.
   */
  activateGeneration(
    noteId: string,
    gen: string,
    expectedContentHash: string,
    configKey: string,
  ): boolean;
  /**
   * Fenced tombstone: clear a note's active generation under the activation fence
   * (Task 3.2, round-3 finding 2). Delegates to
   * {@link GenerationRepo.tombstoneGeneration}. Returns `true` iff cleared.
   */
  tombstoneGeneration(noteId: string, expectedContentHash: string, configKey: string): boolean;
  /**
   * Record a durable indexing-config **adoption event** and return its monotonic
   * epoch (Task 3.2 — the generation/config fence's durable owner). Delegates to
   * {@link GenerationRepo.adoptConfig}. Requires the `0008_index_config_revision`
   * migration (see {@link registerGenerationMigration}).
   */
  adoptConfig(configKey: string): number;
  /** Register a migration (jobs registers `0002` here). */
  registerMigration(m: Migration): void;
  /**
   * The migrations registered on this store, in id order. Exposed so `db restore`
   * can bring a restored (possibly older-schema) backup DB up to THIS store's
   * migration frontier — through `0013_links_v2` — BEFORE running the post-restore
   * projection rebuild, whose fold now emits the v2 `note_links` shape (an `alias`
   * column + partial-index conflict targets a pre-0013 table cannot satisfy).
   */
  listMigrations(): Migration[];
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
  migrations.set(migration0004Claims.id, migration0004Claims);
  migrations.set(migration0005LedgerFinalize.id, migration0005LedgerFinalize);
  // `0013_links_v2` is a CORE table-rebuild (it reshapes the `0001_core`
  // `note_links` projection into the v2 link shape), NOT a feature migration —
  // so it belongs in the default retained set, applied by every `db migrate`.
  migrations.set(migration0013LinksV2.id, migration0013LinksV2);
  // `0014_evidence_v2` is a CORE projection migration (it replaces the v1
  // `claims`/`claim_evidence` evidence model with the flat vault-derived
  // `evidence` table); like `0013` it belongs in the default retained set,
  // applied by every `db migrate`. Store-open only REGISTERS it — the explicit
  // `db migrate` under the vault lock is the sole apply path (no reader auto-migrates).
  migrations.set(migration0014EvidenceV2.id, migration0014EvidenceV2);

  const generation = new GenerationRepo(db, clock);

  return {
    db,
    projections: new ProjectionRepo(db),
    ledger: new LedgerRepo(db),
    provenance: new ProvenanceRepo(db),
    claims: new ClaimsRepo(db),
    generation,
    activateGeneration(
      noteId: string,
      gen: string,
      expectedContentHash: string,
      configKey: string,
    ): boolean {
      return generation.activateGeneration(noteId, gen, expectedContentHash, configKey);
    },
    tombstoneGeneration(noteId: string, expectedContentHash: string, configKey: string): boolean {
      return generation.tombstoneGeneration(noteId, expectedContentHash, configKey);
    },
    adoptConfig(configKey: string): number {
      return generation.adoptConfig(configKey);
    },
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
    listMigrations(): Migration[] {
      return [...migrations.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
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

/**
 * Register the generation/activation-owned `0008_index_config_revision` migration
 * on a `Store`. Call at STORE-OPEN, BEFORE {@link Store.migrate}, so the durable
 * config-revision allocator table is applied through the normal checksum-guarded
 * runner — never ad-hoc during a command. Mirrors `@atlas/jobs`'s
 * `registerJobsMigration` and the workflows layer's idempotency registration: the
 * table is a FEATURE migration (NOT in `openStore`'s default retained set), so the
 * `db.migrate-ownership` fresh-DB diff stays exactly the §2.7 core set. The schema
 * head is already declared in the backup compatibility set (same-package import),
 * so no `registerKnownSchemaHead` call is needed here.
 */
export function registerGenerationMigration(store: Store): void {
  store.registerMigration(migration0008IndexConfigRevision);
}

/**
 * Register the vault-sync-owned `0012_sync_cursors` migration on a `Store`
 * (60-A adoption). Call at STORE-OPEN, BEFORE {@link Store.migrate}, so the
 * per-source sync cursor table is applied through the checksum-guarded runner —
 * never ad-hoc during a command. Like `registerGenerationMigration`, this is a
 * FEATURE migration (NOT in `openStore`'s default retained set), so the
 * `db.migrate-ownership` fresh-DB diff stays exactly the §2.7 core set. Its schema
 * head is already declared in the backup compatibility set (same-package import),
 * so no `registerKnownSchemaHead` call is needed here.
 */
export function registerSyncCursorsMigration(store: Store): void {
  store.registerMigration(migration0012SyncCursors);
}
