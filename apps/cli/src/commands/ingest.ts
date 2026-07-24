/**
 * `brain ingest <id>` (v2, #340) — normalize a registered source + commit it as a
 * note. PREVIEW by default (D11): resolve the `source` registry row by id, read its
 * bytes at the `locator`, normalize via `@atlas/sources`, and print what a capture
 * WOULD produce — persisting NOTHING. `--apply` grounds a deterministic note and
 * commits it DIRECTLY onto `refs/heads/main` through the common mutation order
 * ({@link ingestSource}), then stamps `source.lastIngestedAt`. `--dry-run` + `--apply`
 * together ⇒ exit 5. Idempotent: a re-ingest of identical input is a NOOP (no
 * duplicate note, no second commit) that still re-stamps.
 */
import { CliError, EXIT, emitJson } from "../errors/envelope.js";
import { registerCommand, type RunContext } from "../handlers.js";
import { SourceRepo } from "@atlas/sqlite-store";
import {
  ingestSource,
  previewIngest,
  IngestRejectedError,
  IngestUsageError,
} from "../ingest/ingest.js";
import { openWorkflowStore } from "../workflows/index.js";
import { openMigratedStore } from "./store-open.js";
import { ledgerDbPath } from "./paths.js";

interface ParsedArgs {
  readonly id: string;
  readonly apply: boolean;
  readonly dryRun: boolean;
}

// v2 (#340): `ingest` is INTRINSICALLY idempotent — the produced note id is derived
// deterministically from `(source.id, mediaType)`, so a re-ingest of identical input
// is a NOOP (no duplicate note, no second commit) with no caller-supplied key. The v1
// `--idempotency-key` (a run-ledger replay-dedup knob) is dropped: it no longer maps to
// any layer, so accepting it would be a silent no-op callers might rely on.
function parseArgs(argv: string[]): ParsedArgs {
  let id: string | undefined;
  let apply = false;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--apply") apply = true;
    else if (a === "--dry-run") dryRun = true;
    else if (a.startsWith("-")) throw CliError.usage(`unknown flag for \`ingest\`: ${a}`);
    else if (id === undefined) id = a;
    else throw CliError.usage(`unexpected extra argument for \`ingest\`: ${a}`);
  }
  if (id === undefined) throw CliError.usage("`ingest` requires a <id> argument (a source registry id)");
  if (apply && dryRun) throw CliError.usage("`--dry-run` and `--apply` are mutually exclusive");
  return { id, apply, dryRun };
}

/** Map an ingest engine throw to the right CLI error envelope. */
function liftIngestError(e: unknown): never {
  if (e instanceof IngestUsageError) throw CliError.usage(e.message);
  if (e instanceof IngestRejectedError) {
    throw new CliError({ code: "validation-error", message: e.message, exitCode: EXIT.VALIDATION, cause: e });
  }
  throw e;
}

async function ingest(ctx: RunContext): Promise<number> {
  const args = parseArgs(ctx.argv);

  if (!args.apply) {
    // PREVIEW (default): resolve + normalize, persist nothing. Reads the registry
    // through the non-migrating store (no DB creation, no DDL, lock-free).
    const store = openMigratedStore(ctx);
    let preview;
    try {
      const source = new SourceRepo(store.db).byId(args.id);
      if (source === undefined) {
        throw new CliError({
          code: "validation-error",
          message: `no source with id "${args.id}" in the registry (add it with \`source add\`)`,
          exitCode: EXIT.VALIDATION,
        });
      }
      preview = await previewIngest(source);
    } catch (e) {
      if (e instanceof CliError) throw e;
      liftIngestError(e);
    } finally {
      store.close();
    }
    const out = {
      command: "ingest" as const,
      id: args.id,
      mode: "preview" as const,
      applied: false,
      preview: {
        sourceId: preview.sourceId,
        noteId: preview.noteId,
        canonicalMediaType: preview.canonicalMediaType,
        sizeBytes: preview.sizeBytes,
        extraction: preview.extraction,
      },
    };
    if (ctx.output.mode === "json") emitJson(out);
    else
      ctx.render(
        `ingest preview — source ${out.id} -> note ${out.preview.noteId} (${out.preview.sizeBytes} bytes, ${out.preview.canonicalMediaType}); pass --apply to commit. Nothing was persisted.`,
      );
    return EXIT.OK;
  }

  // APPLY: resolve the source, ground the note, commit through the mutation order,
  // stamp lastIngestedAt. The mutation order (inside ingestSource) owns the vault lock.
  const store = openWorkflowStore({ path: ledgerDbPath(ctx) });
  let result;
  try {
    const source = new SourceRepo(store.db).byId(args.id);
    if (source === undefined) {
      throw new CliError({
        code: "validation-error",
        message: `no source with id "${args.id}" in the registry (add it with \`source add\`)`,
        exitCode: EXIT.VALIDATION,
      });
    }
    result = await ingestSource(ctx, { source, store });
  } catch (e) {
    if (e instanceof CliError) throw e;
    liftIngestError(e);
  } finally {
    store.close();
  }

  const out = {
    command: "ingest" as const,
    id: args.id,
    mode: "apply" as const,
    applied: true,
    capture: {
      sourceId: result.sourceId,
      noteId: result.noteId,
      path: result.path,
      contentHash: result.contentHash,
      committed: result.committed,
      canonicalSha: result.canonicalSha,
      lastIngestedAt: result.lastIngestedAt,
    },
  };
  if (ctx.output.mode === "json") emitJson(out);
  else
    ctx.render(
      result.committed
        ? `ingested ${out.capture.noteId} at ${out.capture.path} — canonical ${(out.capture.canonicalSha ?? "").slice(0, 12)}`
        : `ingest ${out.id}: already up to date (${out.capture.noteId}) — re-stamped lastIngestedAt, nothing committed`,
    );
  return EXIT.OK;
}

registerCommand("ingest", ingest);

export { ingest };
