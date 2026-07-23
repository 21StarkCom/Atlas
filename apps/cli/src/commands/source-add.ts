/**
 * `brain source add <path>` (D11) — deterministic Tier-1 source capture that
 * APPLIES immediately (no preview mode). Funnels through {@link captureSource}:
 * scan-before-persist (a secret ⇒ exit 3, quarantined, nothing persisted), dedup by
 * `(rawContentHash, canonicalMediaType)`, capture keyed `(contentId, origin)`, and
 * broker Tier-1 CAS integration. Emits the minted ids + what was reused.
 */
import { CliError, EXIT, emitJson } from "../errors/envelope.js";
import { registerCommand, type RunContext } from "../handlers.js";
import { serializeContentId, serializeRenditionId } from "@atlas/contracts";
import { captureSource, CaptureRejectedError } from "../ingest/capture.js";
import { buildCaptureDeps } from "../ingest/wiring.js";
import { resolvePath } from "./paths.js";
import { withVaultMutation } from "../locks/mutation-guard.js";

interface ParsedArgs {
  readonly path: string;
  readonly idempotencyKey?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  let path: string | undefined;
  let idempotencyKey: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--idempotency-key") {
      idempotencyKey = argv[++i];
      if (idempotencyKey === undefined) throw CliError.usage("`--idempotency-key` requires a value");
    } else if (a.startsWith("--idempotency-key=")) {
      idempotencyKey = a.slice("--idempotency-key=".length);
    } else if (a.startsWith("-")) {
      throw CliError.usage(`unknown flag for \`source add\`: ${a}`);
    } else if (path === undefined) {
      path = a;
    } else {
      throw CliError.usage(`unexpected extra argument for \`source add\`: ${a}`);
    }
  }
  if (path === undefined) throw CliError.usage("`source add` requires a <path> argument");
  return idempotencyKey !== undefined ? { path, idempotencyKey } : { path };
}

async function sourceAdd(ctx: RunContext): Promise<number> {
  const args = parseArgs(ctx.argv);
  // BEFORE assembling any mutating dep (DEFECT #1).
  const deps = buildCaptureDeps(ctx, "source add", args.idempotencyKey);
  const vaultPath = resolvePath(ctx, ctx.config.config.vault.path);

  let result;
  try {
    // Hold the vault lock across the whole capture (grounding → apply → commit →
    // refresh). `preApply` is threaded INTO captureSource so the pre-apply
    // index.lock re-check fires at the true post-grounding boundary (after the
    // sandboxed normalize, before the first durable mutation), not before grounding.
    result = await withVaultMutation(ctx, vaultPath, (preApply) =>
      captureSource({ path: args.path, deps, preApply }),
    );
  } catch (e) {
    if (e instanceof CaptureRejectedError) {
      throw new CliError({
        code: "validation-error",
        message: e.message,
        hint: "The source could not be normalized (see the typed rejection code).",
        exitCode: EXIT.VALIDATION,
        cause: e,
      });
    }
    throw e;
  }

  const out = {
    command: "source add" as const,
    contentId: serializeContentId(result.contentId),
    captureId: result.captureId,
    renditionId: serializeRenditionId(result.renditionId),
    noteId: result.noteId,
    runId: result.runId,
    reused: result.reused,
  };
  if (ctx.output.mode === "json") emitJson(out);
  else
    ctx.render(
      `captured ${out.noteId} — content ${out.contentId} (blob ${out.reused.blob ? "reused" : "new"}, capture ${out.reused.capture ? "reused" : "new"}); run ${out.runId}`,
    );
  return EXIT.OK;
}

registerCommand("source add", sourceAdd);

export { sourceAdd };
