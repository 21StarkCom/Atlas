/**
 * `brain ingest <path>` (D11) — capture + extraction PREVIEW by default; `--apply`
 * performs the capture through the SAME {@link captureSource} path as `source add`.
 * `--dry-run` + `--apply` together ⇒ exit 5. Scan-before-persist applies in BOTH
 * modes; preview persists NOTHING to any sink (no store/projection/ledger/git/temp,
 * no audit-ref event).
 */
import { CliError, EXIT, emitJson } from "../errors/envelope.js";
import { registerCommand, type RunContext } from "../handlers.js";
import { serializeContentId, serializeRenditionId } from "@atlas/contracts";
import { captureSource, previewCapture, CaptureRejectedError } from "../ingest/capture.js";
import { buildCaptureDeps, probeStore } from "../ingest/wiring.js";
import { resolvePath } from "./backup-config.js";
import { withVaultMutation } from "../locks/mutation-guard.js";

interface ParsedArgs {
  readonly path: string;
  readonly apply: boolean;
  readonly dryRun: boolean;
  readonly idempotencyKey?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  let path: string | undefined;
  let apply = false;
  let dryRun = false;
  let idempotencyKey: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--apply") apply = true;
    else if (a === "--dry-run") dryRun = true;
    else if (a === "--idempotency-key") {
      idempotencyKey = argv[++i];
      if (idempotencyKey === undefined) throw CliError.usage("`--idempotency-key` requires a value");
    } else if (a.startsWith("--idempotency-key=")) idempotencyKey = a.slice("--idempotency-key=".length);
    else if (a.startsWith("-")) throw CliError.usage(`unknown flag for \`ingest\`: ${a}`);
    else if (path === undefined) path = a;
    else throw CliError.usage(`unexpected extra argument for \`ingest\`: ${a}`);
  }
  if (path === undefined) throw CliError.usage("`ingest` requires a <path> argument");
  if (apply && dryRun) throw CliError.usage("`--dry-run` and `--apply` are mutually exclusive");
  return idempotencyKey !== undefined ? { path, apply, dryRun, idempotencyKey } : { path, apply, dryRun };
}

async function ingest(ctx: RunContext): Promise<number> {
  const args = parseArgs(ctx.argv);

  if (!args.apply) {
    // PREVIEW (default): scan-before-persist still runs; nothing is persisted.
    const preview = await previewCapture(args.path, probeStore(ctx));
    if ("rejection" in preview) {
      throw new CliError({
        code: "validation-error",
        message: `source cannot be normalized (${preview.rejection.code}) for format ${preview.rejection.format}`,
        exitCode: EXIT.VALIDATION,
      });
    }
    const out = {
      command: "ingest" as const,
      path: args.path,
      mode: "preview" as const,
      applied: false,
      preview: {
        contentId: serializeContentId(preview.contentId),
        canonicalMediaType: preview.canonicalMediaType,
        sizeBytes: preview.sizeBytes,
        wouldReuseBlob: preview.wouldReuseBlob,
        extraction: preview.extraction,
      },
    };
    if (ctx.output.mode === "json") emitJson(out);
    else
      ctx.render(
        `ingest preview — ${out.preview.contentId} (${out.preview.sizeBytes} bytes${out.preview.wouldReuseBlob ? ", blob exists" : ""}); pass --apply to capture. Nothing was persisted.`,
      );
    return EXIT.OK;
  }

  // APPLY: same captureSource path as `source add`.
  const deps = buildCaptureDeps(ctx, "ingest", args.idempotencyKey);
  const vaultPath = resolvePath(ctx, ctx.config.config.vault.path);
  let result;
  try {
    // Hold the vault lock across the whole capture. `preApply` is threaded INTO
    // captureSource so the pre-apply index.lock re-check fires at the true
    // post-grounding boundary (after the sandboxed normalize, before the first
    // durable mutation), not before grounding.
    result = await withVaultMutation(ctx, vaultPath, (preApply) =>
      captureSource({ path: args.path, deps, preApply }),
    );
  } catch (e) {
    if (e instanceof CaptureRejectedError) {
      throw new CliError({ code: "validation-error", message: e.message, exitCode: EXIT.VALIDATION, cause: e });
    }
    throw e;
  }
  const out = {
    command: "ingest" as const,
    path: args.path,
    mode: "apply" as const,
    applied: true,
    capture: {
      contentId: serializeContentId(result.contentId),
      captureId: result.captureId,
      renditionId: serializeRenditionId(result.renditionId),
      noteId: result.noteId,
      runId: result.runId,
      reused: result.reused,
    },
  };
  if (ctx.output.mode === "json") emitJson(out);
  else ctx.render(`ingested ${out.capture.noteId} — content ${out.capture.contentId}; run ${out.capture.runId}`);
  return EXIT.OK;
}

registerCommand("ingest", ingest);

export { ingest };
