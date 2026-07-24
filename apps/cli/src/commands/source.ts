/**
 * `brain source list | show` — the read-only surface over the v2 operational
 * `source` registry (`0015_source_registry`). Both are Tier-0 reads: no
 * vault/projection/git mutation.
 *
 * v2 (#339) retired the v1 content-addressed provenance read model
 * (`content_blobs`/`source_captures`/`source_renditions` + the `trust_state`
 * projection): these now read the flat `source` registry `source add` writes.
 *
 *  - `source list` — paginated list of registered sources (the pagination contract:
 *    `--limit`/`--offset`, `total`/`hasMore`, out-of-range ⇒ exit 5). Ordering is
 *    `(addedAt DESC, id ASC)`; `id` (the primary key) is unique, so the total order
 *    is fully resolved and offset pagination is deterministic.
 *  - `source show <handle>` — one source row, resolved by `id` then (fallback) by
 *    its UNIQUE `locator`; `source-not-found` (exit 1) if neither matches.
 */
import { CliError, EXIT, emitJson } from "../errors/envelope.js";
import { registerCommand, type RunContext } from "../handlers.js";
import { SourceRepo, type SourceRow } from "@atlas/sqlite-store";
import { openMigratedStore } from "./store-open.js";
import {
  DEFAULT_LIMIT,
  assertOffsetInRange,
  buildPagination,
  parseLimit,
  parseOffset,
  type PageRequest,
} from "./pagination.js";

/** The `--json` entry for one source row (NULL columns omitted, never emitted as null). */
function sourceEntry(r: SourceRow): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: r.id,
    kind: r.kind,
    locator: r.locator,
    addedAt: r.addedAt,
  };
  if (r.title !== null) out.title = r.title;
  if (r.lastIngestedAt !== null) out.lastIngestedAt = r.lastIngestedAt;
  return out;
}

// ---------------------------------------------------------------------------
// source list
// ---------------------------------------------------------------------------

/** Parse `source list` argv: only `--limit`/`--offset` (out-of-range ⇒ exit 5). */
function parseListArgs(argv: string[]): PageRequest {
  let limit = DEFAULT_LIMIT;
  let offset = 0;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const need = (): string => {
      const v = argv[++i];
      if (v === undefined) throw CliError.usage(`\`source list\`: ${a} requires a value`);
      return v;
    };
    if (a === "--limit") limit = parseLimit("source list", need());
    else if (a.startsWith("--limit=")) limit = parseLimit("source list", a.slice("--limit=".length));
    else if (a === "--offset") offset = parseOffset("source list", need());
    else if (a.startsWith("--offset=")) offset = parseOffset("source list", a.slice("--offset=".length));
    else throw CliError.usage(`\`source list\`: unknown flag/argument ${a}`);
  }
  return { limit, offset };
}

function sourceList(ctx: RunContext): number {
  const req = parseListArgs(ctx.argv);
  const store = openMigratedStore(ctx, ["source"]);
  try {
    const repo = new SourceRepo(store.db);
    const total = repo.count();
    assertOffsetInRange("source list", req.offset, total);
    const rows = repo.list(req);
    const out = {
      command: "source list",
      sources: rows.map(sourceEntry),
      pagination: buildPagination(req, total, rows.length),
    };
    if (ctx.output.mode === "json") emitJson(out);
    else ctx.render(`sources: ${rows.length} of ${total}`);
    return EXIT.OK;
  } finally {
    store.close();
  }
}

// ---------------------------------------------------------------------------
// source show
// ---------------------------------------------------------------------------

/** Parse + validate the single `<source>` positional (missing ⇒ usage exit 5). */
function parseHandleArg(argv: string[]): string {
  let raw: string | undefined;
  for (const a of argv) {
    if (a.startsWith("-")) throw CliError.usage(`\`source show\`: unknown flag ${a}`);
    if (raw !== undefined) throw CliError.usage(`\`source show\`: unexpected extra argument ${a}`);
    raw = a;
  }
  if (raw === undefined) throw CliError.usage("`source show` requires a <source> argument");
  return raw;
}

function sourceShow(ctx: RunContext): number {
  const handle = parseHandleArg(ctx.argv);
  const store = openMigratedStore(ctx, ["source"]);
  try {
    const repo = new SourceRepo(store.db);
    // Resolve by id first, then by the UNIQUE locator (so either identifier works).
    const row = repo.byId(handle) ?? repo.byLocator(handle);
    if (row === undefined) {
      throw new CliError({
        code: "source-not-found",
        message: `\`source show\`: no source resolves for ${handle}`,
        hint: "Run `brain source list` to see registered sources (match by id or locator).",
        exitCode: EXIT.VALIDATION,
      });
    }
    const out = { command: "source show", source: sourceEntry(row) };
    if (ctx.output.mode === "json") emitJson(out);
    else ctx.render(`${row.id} (${row.kind}) — ${row.locator}`);
    return EXIT.OK;
  } finally {
    store.close();
  }
}

registerCommand("source list", sourceList);
registerCommand("source show", sourceShow);

export { sourceList, sourceShow };
