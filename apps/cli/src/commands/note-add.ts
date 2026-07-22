/**
 * `brain note add <path> --dest <folder>` (#262) — deterministic Tier-1 ingest
 * of a PRE-AUTHORED vault note that APPLIES immediately (no preview mode).
 * Funnels through {@link addNote}: scan-before-persist (a secret ⇒ exit 3,
 * quarantined, nothing persisted), vault-reader frontmatter validation,
 * id/alias/path collision refusal, and broker Tier-1 CAS integration under the
 * additions-only `"note"` scope. Unlike `source add` (immutable blob + manifest
 * stub), the file itself lands at `<dest>/<basename>` and is projected/indexed
 * as first-class vault content.
 */
import { CliError, EXIT, emitJson } from "../errors/envelope.js";
import { registerCommand, type RunContext } from "../handlers.js";
import { addNote, NoteAddRejectedError } from "../ingest/note-add.js";
import { buildCaptureDeps, buildGuard } from "../ingest/wiring.js";
import { resolvePath } from "./backup-config.js";
import { withVaultMutation } from "../locks/mutation-guard.js";

interface ParsedArgs {
  readonly path: string;
  readonly dest: string;
  readonly idempotencyKey?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  let path: string | undefined;
  let dest: string | undefined;
  let idempotencyKey: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--dest") {
      dest = argv[++i];
      if (dest === undefined) throw CliError.usage("`--dest` requires a value");
    } else if (a.startsWith("--dest=")) {
      dest = a.slice("--dest=".length);
    } else if (a === "--idempotency-key") {
      idempotencyKey = argv[++i];
      if (idempotencyKey === undefined) throw CliError.usage("`--idempotency-key` requires a value");
    } else if (a.startsWith("--idempotency-key=")) {
      idempotencyKey = a.slice("--idempotency-key=".length);
    } else if (a.startsWith("-")) {
      throw CliError.usage(`unknown flag for \`note add\`: ${a}`);
    } else if (path === undefined) {
      path = a;
    } else {
      throw CliError.usage(`unexpected extra argument for \`note add\`: ${a}`);
    }
  }
  if (path === undefined) throw CliError.usage("`note add` requires a <path> argument");
  if (dest === undefined) {
    throw CliError.usage("`note add` requires --dest <folder> (the vault-relative folder the note lands in)");
  }
  return idempotencyKey !== undefined ? { path, dest, idempotencyKey } : { path, dest };
}

async function noteAdd(ctx: RunContext): Promise<number> {
  const args = parseArgs(ctx.argv);
  // PREFLIGHT guard is built here; addNote runs the scan-before-persist BEFORE
  // assembling any mutating dep (DEFECT #1 ordering, same as source add).
  const guard = buildGuard(ctx);
  const deps = buildCaptureDeps(ctx, "note add", args.idempotencyKey, "note");
  const vaultPath = resolvePath(ctx, ctx.config.config.vault.path);

  let result;
  try {
    // Hold the vault lock across the whole note-add (grounding → apply → commit →
    // refresh). `preApply` is threaded INTO addNote so the pre-apply index.lock
    // re-check fires at the true post-grounding boundary (after scan + frontmatter
    // validation, before the first durable mutation), not before grounding.
    result = await withVaultMutation(ctx, vaultPath, (preApply) =>
      addNote({ path: args.path, dest: args.dest, guard, deps, preApply }),
    );
  } catch (e) {
    if (e instanceof NoteAddRejectedError) {
      throw new CliError({
        code: "validation-error",
        message: e.message,
        hint: "The note must be schema-valid vault markdown with a fresh id/alias set and a new dest path.",
        exitCode: EXIT.VALIDATION,
        cause: e,
      });
    }
    throw e;
  }

  const out = {
    command: "note add" as const,
    noteId: result.noteId,
    path: result.path,
    contentHash: result.contentHash,
    runId: result.runId,
    canonicalSha: result.canonicalSha,
  };
  if (ctx.output.mode === "json") emitJson(out);
  else
    ctx.render(
      `added ${out.noteId} at ${out.path} — canonical ${out.canonicalSha.slice(0, 12)}; run ${out.runId}`,
    );
  return EXIT.OK;
}

registerCommand("note add", noteAdd);

export { noteAdd };
