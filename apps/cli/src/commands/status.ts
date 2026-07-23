/**
 * `brain status` (v2, #332) — the ONE merged read surface, absorbing the retired
 * `doctor`, `db status`, `index status`, and `sync status` commands (ADR-0003;
 * they leave the registry in the #333 survivor-set shrink).
 *
 * The `--json` payload (owned by `status.schema.json`) is four named sub-objects
 * + the retained health probes:
 *   - `vault`  — path, HEAD sha, working-tree dirtiness, parsed note count;
 *   - `db`     — schema version + projection counts, read from the EXISTING
 *                schema (absent tables read as zero — status never migrates);
 *   - `index`  — LanceDB chunk count, stale count, embedding model;
 *   - `sync`   — the four pending reconciliation counts (changed / new /
 *                dropped / moved), from the SAME `readReconcile` routine `sync`
 *                acts on (§ssot) — informational, never a health signal (pending
 *                sync work is the normal state of a dirty tree);
 *   - `checks` — exactly `vault-reachable`, `git-healthy`,
 *                `provider-key-present` (the NON-throwing `hasGeminiApiKey`
 *                probe — never the throwing resolver), `index-not-stale`, and
 *                `migrations-current` (a read-only schema-version read that
 *                NEVER auto-applies).
 *
 * Exit contract (binding): **0 whenever the payload was produced — including
 * `ok:false`** (a failed probe is data, not a process failure); **2 only when
 * the vault/config is unresolvable** and no payload is possible. A missing or
 * unmigrated ledger store is NOT exit 2: the db counts read as zero and
 * `migrations-current` fails, at exit 0. A vault with STRUCTURAL note errors
 * (invalid frontmatter, duplicate stable id) is NOT exit 2 either — the
 * diagnostic surface must not die exactly when the vault is unhealthy — it
 * degrades: `vault-reachable` fails with the structural reason and the pending
 * counts read zero (review finding, #332). `status` opens the store read-only,
 * never creates the DB file, and never applies DDL.
 */
import { existsSync, statSync } from "node:fs";
import type { SectionTree } from "@atlas/contracts";
import { openRepo } from "@atlas/git";
import { openStore, type Store } from "@atlas/sqlite-store";
import { hasGeminiApiKey } from "@atlas/models";
import { computeStaleness, type NoteFenceInput } from "@atlas/lancedb-index";
import { CliError, EXIT, emitJson } from "../errors/envelope.js";
import { registerCommand, type RunContext } from "../handlers.js";
import { ledgerDbPath, resolvePath } from "./backup-config.js";
import { indexingConfig, noteFences, openTableOrNull } from "./index-ops.js";
import { registerFeatureMigrations } from "./store-open.js";
import { classifySnapshot, readVaultForReconcile, structuralVaultErrors, type ReconcileRead } from "./sync.js";

/** One retained health probe result. */
export interface StatusCheck {
  readonly name: "vault-reachable" | "git-healthy" | "provider-key-present" | "index-not-stale" | "migrations-current";
  readonly ok: boolean;
  readonly detail: string | null;
}

/** The v2 merged `status --json` envelope (mirrors status.schema.json). */
export interface StatusV2Envelope {
  readonly command: "status";
  readonly ok: boolean;
  readonly vault: { readonly path: string; readonly headSha: string; readonly dirty: boolean; readonly noteCount: number };
  readonly db: { readonly schemaVersion: number; readonly noteCount: number; readonly sectionCount: number; readonly linkCount: number };
  readonly index: { readonly chunkCount: number; readonly staleCount: number; readonly embeddingModel: string };
  readonly sync: {
    readonly pendingChangedCount: number;
    readonly pendingNewCount: number;
    readonly pendingDroppedCount: number;
    readonly pendingMovedCount: number;
  };
  readonly checks: readonly StatusCheck[];
}

function parseArgs(argv: readonly string[]): void {
  for (const a of argv) throw CliError.usage(`unknown flag/argument for \`status\`: ${a}`);
}

/** Open the ledger store READ-ONLY-in-spirit: never create the file, never
 * migrate. Every feature migration is REGISTERED (registration is a pure
 * in-memory act — no DDL runs without `store.migrate()`), so `migrations-current`
 * can derive its required set from `listMigrations()` — the SAME composition
 * root a real `brain db migrate` applies (core + jobs + workflows + generation +
 * sync-cursors), never a hand-pinned list that drifts as Phase-4 reshapes the
 * migration inventory. */
function openStatusStore(ctx: RunContext): Store | null {
  const dbPath = ledgerDbPath(ctx);
  if (!existsSync(dbPath)) return null; // opening would CREATE it — a write a read surface must not make
  const store = openStore({ path: dbPath });
  registerFeatureMigrations(store);
  return store;
}

function tableExists(store: Store, name: string): boolean {
  return store.db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !== undefined;
}

/** COUNT(*) of a projection table, or 0 when the table is absent (never migrates). */
function countRows(store: Store | null, table: string): number {
  if (store === null || !tableExists(store, table)) return 0;
  const row = store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}

/** The ids recorded in `db_schema_migrations`, or [] when absent/unmigrated. */
function appliedMigrationIds(store: Store | null): string[] {
  if (store === null || !tableExists(store, "db_schema_migrations")) return [];
  return (store.db.prepare(`SELECT id FROM db_schema_migrations ORDER BY id`).all() as { id: string }[]).map((r) => r.id);
}

/** The numeric prefix of the LATEST applied migration id (`"0013_links_v2"` → 13), or 0. */
function schemaVersionOf(applied: readonly string[]): number {
  const last = applied[applied.length - 1];
  if (last === undefined) return 0;
  const n = Number.parseInt(last.slice(0, 4), 10);
  return Number.isNaN(n) ? 0 : n;
}

/** Count every section across the parsed vault (the projection carries no section
 * table — sections live only in canonical Markdown, so the vault snapshot is the
 * section count's source of truth). */
function countSections(read: ReconcileRead): number {
  let n = 0;
  const visit = (node: SectionTree): void => {
    for (const child of node.children) {
      n++;
      visit(child);
    }
  };
  for (const note of read.notes) visit(note.sections);
  return n;
}

async function status(ctx: RunContext): Promise<number> {
  parseArgs(ctx.argv);
  const cfg = ctx.config.config;
  const vaultPath = resolvePath(ctx, cfg.vault.path);

  // Vault/config resolution is the ONE exit-2 boundary: no vault ⇒ no payload.
  if (!existsSync(vaultPath) || !statSync(vaultPath).isDirectory()) {
    throw new CliError({
      code: "vault-error",
      message: `vault path ${vaultPath} does not exist or is not a directory`,
      hint: "Check vault.path in brain.config.yaml.",
      exitCode: EXIT.CONFIG,
    });
  }

  const store = openStatusStore(ctx);
  try {
    // The ONE reconciliation routine (§ssot): the same read + classification
    // `sync` acts on, so `status.sync` can never disagree with the next `sync`.
    // A missing/unmigrated store degrades to an empty projection — still the
    // same routine. An UNREADABLE vault is the other exit-2 path; a vault with
    // STRUCTURAL note errors (invalid frontmatter, duplicate id) is where the
    // reader/writer policies split: `sync` (a writer) fail-closes at exit 2,
    // `status` (the diagnostic surface) DEGRADES — payload at exit 0, the
    // vault-reachable check failing with the structural reason, and the pending
    // counts zeroed (a classification over an unreliable id→note map would
    // report false drops).
    const snapshot = await readVaultForReconcile(ctx);
    const fatal = structuralVaultErrors(snapshot);
    const reconcilable = fatal.length === 0;
    const projected = store !== null && tableExists(store, "notes");
    const projRows = projected
      ? store!.projections.allNotes().map((r) => ({ noteId: r.note_id, path: r.file_path, contentHash: r.content_hash }))
      : [];
    const read: ReconcileRead = classifySnapshot(snapshot, projRows);

    // vault — HEAD + dirtiness are best-effort git reads: a non-repo vault fails
    // the git-healthy CHECK (data), never the command.
    const repo = openRepo(vaultPath);
    let headSha = "";
    let dirty = false;
    let gitHealthy = false;
    try {
      headSha = (await repo.readRef("HEAD")) ?? "";
      dirty = (await repo.worktreeStatus([])).length > 0;
      gitHealthy = headSha !== "";
    } catch {
      gitHealthy = false;
    }

    // db — read from the EXISTING schema only (absent tables ⇒ 0; never migrates).
    const applied = appliedMigrationIds(store);
    const db = {
      schemaVersion: schemaVersionOf(applied),
      noteCount: countRows(store, "notes"),
      sectionCount: countSections(read),
      linkCount: countRows(store, "note_links"),
    };

    // index — fold of the retired `index status` read: LanceDB table (or null),
    // staleness against the projected note fences.
    const idxCfg = indexingConfig(ctx);
    const table = await openTableOrNull(ctx, idxCfg);
    const fences: NoteFenceInput[] = projected ? noteFences(store!) : [];
    const staleness = await computeStaleness(fences, table, idxCfg);
    const staleCount = staleness.filter((s) => s.status === "stale").length;
    const index = {
      chunkCount: table === null ? 0 : await table.countRows(),
      staleCount,
      embeddingModel: idxCfg.embedding_model,
    };

    // sync — the four pending counts, informational (never drives checks[]).
    // Zeroed when the vault is structurally unreconcilable: the id→note map is
    // unreliable, so any classification over it would report false drops.
    const sync = reconcilable
      ? {
          pendingChangedCount: read.rec.changed.length,
          pendingNewCount: read.rec.new.length,
          pendingDroppedCount: read.rec.dropped.length,
          pendingMovedCount: read.rec.moved.length,
        }
      : { pendingChangedCount: 0, pendingNewCount: 0, pendingDroppedCount: 0, pendingMovedCount: 0 };

    // The required set is what a real `brain db migrate` would apply — derived
    // from the SAME composition root (openStore defaults + registerFeatureMigrations),
    // never a hand-pinned list that drifts as Phase 4 reshapes the inventory.
    const missing = store === null ? null : store.listMigrations().map((m) => m.id).filter((id) => !applied.includes(id));
    const firstFatal = fatal[0];
    const hasKey = hasGeminiApiKey(ctx.env);
    const checks: StatusCheck[] = [
      {
        name: "vault-reachable",
        ok: reconcilable,
        detail:
          firstFatal === undefined
            ? null
            : `vault note is not reconcilable (${firstFatal.kind}): ${firstFatal.path} — ${firstFatal.message}`,
      },
      {
        name: "git-healthy",
        ok: gitHealthy,
        detail: gitHealthy ? null : "the vault is not a git repository (or HEAD is unborn)",
      },
      {
        name: "provider-key-present",
        ok: hasKey,
        detail: hasKey ? null : "no ATLAS_GEMINI_API_KEY env var and no Keychain item `atlas-gemini-api-key`",
      },
      {
        name: "index-not-stale",
        ok: staleCount === 0,
        detail: staleCount === 0 ? null : `${staleCount} note(s) re-authored since their chunks were embedded — run \`brain sync\``,
      },
      {
        name: "migrations-current",
        ok: missing !== null && missing.length === 0,
        detail:
          missing === null
            ? "ledger store missing — run `brain db migrate` (status never creates or migrates it)"
            : missing.length === 0
              ? null
              : `pending migration(s): ${missing.join(", ")} — run \`brain db migrate\` (status never auto-applies)`,
      },
    ];

    const out: StatusV2Envelope = {
      command: "status",
      ok: checks.every((c) => c.ok),
      vault: { path: vaultPath, headSha, dirty, noteCount: read.scannedCount },
      db,
      index,
      sync,
      checks,
    };

    if (ctx.output.mode === "json") {
      emitJson(out);
    } else {
      const pending = sync.pendingChangedCount + sync.pendingNewCount + sync.pendingDroppedCount + sync.pendingMovedCount;
      const failed = checks.filter((c) => !c.ok);
      ctx.render(
        [
          `status — ${out.ok ? "ok" : "UNHEALTHY"}`,
          `vault: ${read.scannedCount} note(s)${dirty ? " · dirty tree" : ""} @ ${headSha === "" ? "no-git" : headSha.slice(0, 12)}`,
          `db: schema v${db.schemaVersion} · ${db.noteCount} notes · ${db.linkCount} links | index: ${index.chunkCount} chunks · ${index.staleCount} stale`,
          `sync pending: ${pending === 0 ? "none" : `changed ${sync.pendingChangedCount} · new ${sync.pendingNewCount} · dropped ${sync.pendingDroppedCount} · moved ${sync.pendingMovedCount}`}`,
          ...failed.map((c) => `FAILED ${c.name}: ${c.detail ?? ""}`),
        ].join("\n"),
      );
    }
    return EXIT.OK;
  } finally {
    store?.close();
  }
}

registerCommand("status", status);

export { status };
