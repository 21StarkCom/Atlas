/**
 * `brain source add <locator>` — record a source in the v2 operational `source`
 * registry (`0015_source_registry`). v2 (#339) retires the v1 content-addressed
 * capture path (scan → normalize → immutable blob + manifest → broker Tier-1 CAS
 * commit): this is now a **plain operational SQLite write** — NO git commit, NO
 * capture/normalize (that is `ingest`), NO mutation order / vault lock.
 *
 * It derives `kind` (`file`|`url`) from the locator, generates a stable id
 * (deterministic from the locator), stamps `addedAt = now`, and inserts one `source`
 * row. Dedup is on the UNIQUE `locator`: a duplicate locator is a NOOP SUCCESS that
 * returns the EXISTING row's id (`added:false`) — so a repeated `source add
 * <same-locator>` is intrinsically idempotent (no `--idempotency-key`).
 */
import { createHash } from "node:crypto";
import { CliError, EXIT, emitJson } from "../errors/envelope.js";
import { registerCommand, type RunContext } from "../handlers.js";
import { SourceRepo, type SourceKind } from "@atlas/sqlite-store";
import { openMigratedStore } from "./store-open.js";

interface ParsedArgs {
  readonly locator: string;
  readonly title?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  let locator: string | undefined;
  let title: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--title") {
      title = argv[++i];
      if (title === undefined) throw CliError.usage("`--title` requires a value");
    } else if (a.startsWith("--title=")) {
      title = a.slice("--title=".length);
    } else if (a.startsWith("-")) {
      throw CliError.usage(`unknown flag for \`source add\`: ${a}`);
    } else if (locator === undefined) {
      locator = a;
    } else {
      throw CliError.usage(`unexpected extra argument for \`source add\`: ${a}`);
    }
  }
  if (locator === undefined) throw CliError.usage("`source add` requires a <locator> argument");
  return title !== undefined ? { locator, title } : { locator };
}

/** A URL locator carries a `<scheme>://` prefix; everything else is a file path. */
function deriveKind(locator: string): SourceKind {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(locator) ? "url" : "file";
}

/** A stable, deterministic source id derived from the locator (dedup-consistent). */
function deriveId(locator: string): string {
  return `src_${createHash("sha256").update(locator, "utf8").digest("hex").slice(0, 16)}`;
}

function sourceAdd(ctx: RunContext): number {
  const args = parseArgs(ctx.argv);
  const kind = deriveKind(args.locator);
  const id = deriveId(args.locator);
  const addedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  const store = openMigratedStore(ctx, ["source"]);
  try {
    const repo = new SourceRepo(store.db);
    const result = repo.insert({
      id,
      kind,
      locator: args.locator,
      ...(args.title !== undefined ? { title: args.title } : {}),
      addedAt,
    });

    const out: Record<string, unknown> = {
      command: "source add" as const,
      id: result.id,
      kind,
      locator: args.locator,
      added: result.inserted,
    };
    if (args.title !== undefined) out.title = args.title;

    if (ctx.output.mode === "json") emitJson(out);
    else
      ctx.render(
        result.inserted
          ? `added source ${result.id} (${kind}) — ${args.locator}`
          : `source already registered: ${result.id} (${kind}) — ${args.locator}`,
      );
    return EXIT.OK;
  } finally {
    store.close();
  }
}

registerCommand("source add", sourceAdd);

export { sourceAdd };
