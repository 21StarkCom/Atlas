/**
 * `brain evidence retry <evidenceId>` (Task 4.7 / #59) — re-enqueue a failed evidence
 * re-verification job. Reconstructs the reverify bump from the evidence head (its pinned rendition
 * as `previous`, the blob's CURRENT active rendition as `newRenditionId`) and its owning note, keyed
 * idempotently by `(contentId, newRenditionId, owningNoteId)`: no job yet ⇒ enqueue; a terminal job
 * ⇒ reset to a fresh `pending` attempt; an already-queued/in-flight job ⇒ the existing jobId
 * unchanged. Records one ledger-internal `evidence.retry_enqueued` event. Output ⇒ `evidence-retry.schema.json`.
 */
import { createHash } from "node:crypto";
import { serializeRenditionId } from "@atlas/contracts";
import { ProvenanceRepo, nextDbEventSeq } from "@atlas/sqlite-store";
import { enqueue, resetForRetry, openJobsStore } from "@atlas/jobs";
import { CliError, EXIT, emitJson } from "../errors/envelope.js";
import { registerCommand, type RunContext } from "../handlers.js";
import { REVERIFY_WORKFLOW, reverifyKey } from "../workflows/reverify.js";
import { ledgerDbPath } from "./backup-config.js";

interface Parsed { evidenceId: string }
function parseArgs(argv: string[]): Parsed {
  let evidenceId: string | undefined;
  for (const a of argv) {
    if (a.startsWith("-")) throw CliError.usage(`\`evidence retry\`: unknown flag ${a}`);
    else if (evidenceId === undefined) evidenceId = a;
    else throw CliError.usage(`\`evidence retry\`: unexpected argument ${a}`);
  }
  if (evidenceId === undefined) throw CliError.usage(`\`evidence retry\`: expected an <evidenceId> argument`);
  return { evidenceId };
}

interface EvidenceRow {
  claim_id: string;
  raw_content_hash: string;
  canonical_media_type: string;
  extractor_version: number;
  normalizer_version: number;
}

async function evidenceRetry(ctx: RunContext): Promise<number> {
  const p = parseArgs(ctx.argv);
  const store = openJobsStore({ path: ledgerDbPath(ctx) });
  try {
    const ev = store.db
      .prepare(`SELECT claim_id, raw_content_hash, canonical_media_type, extractor_version, normalizer_version FROM claim_evidence WHERE evidence_id = ? AND current = 1`)
      .get(p.evidenceId) as EvidenceRow | undefined;
    if (ev === undefined) {
      throw new CliError({ code: "not-found", message: `evidence ${p.evidenceId} does not exist`, hint: "Check the id from `brain evidence review`.", exitCode: EXIT.VALIDATION });
    }
    const owningNoteId = (store.db.prepare(`SELECT owning_note_id AS n FROM claims WHERE claim_id = ?`).get(ev.claim_id) as { n: string }).n;

    // newRenditionId = the blob's CURRENT active rendition (retry re-verifies against it); fall back
    // to the evidence's pinned rendition when the blob has no active pointer.
    const contentId = { rawContentHash: ev.raw_content_hash, canonicalMediaType: ev.canonical_media_type } as const;
    const active = new ProvenanceRepo(store.db).resolveSourceHandle({ kind: "content", ...contentId });
    const newRenditionId = serializeRenditionId({
      kind: "rendition",
      rawContentHash: ev.raw_content_hash,
      canonicalMediaType: ev.canonical_media_type,
      extractorVersion: active?.extractor_version ?? ev.extractor_version,
      normalizerVersion: active?.normalizer_version ?? ev.normalizer_version,
    });
    const bump = { contentId, previous: { extractorVersion: ev.extractor_version, normalizerVersion: ev.normalizer_version }, newRenditionId };
    const key = reverifyKey(bump, owningNoteId);
    const now = new Date().toISOString();

    // Enqueue (no prior job) OR reset a terminal job to pending; each primitive is self-atomic
    // (enqueue = single INSERT, resetForRetry = its own IMMEDIATE tx) — never nest them in an
    // outer transaction (better-sqlite3 forbids nested transactions).
    const existing = store.db.prepare(`SELECT job_id AS id, state FROM jobs WHERE workflow = ? AND idempotency_key = ?`).get(REVERIFY_WORKFLOW, key) as { id: string; state: string } | undefined;
    let jobId: string;
    let requeued: boolean;
    if (existing === undefined) {
      jobId = enqueue(store.db, { workflow: REVERIFY_WORKFLOW, idempotencyKey: key, payload: { owningNoteId, contentId, newRenditionId, evidenceIds: [p.evidenceId] } });
      requeued = true;
    } else {
      jobId = existing.id;
      requeued = resetForRetry(store.db, jobId, now) === "requeued";
    }
    // Ledger-internal audit trail (D6): NOT chained into refs/audit/runs.
    store.ledger.insertAuditEvent({
      seq: nextDbEventSeq(store.db),
      run_id: `evidence.retry:${p.evidenceId}`,
      event_type: "evidence.retry_enqueued",
      payload_hash: createHash("sha256").update(`${key}:${jobId}`).digest("hex"),
      git_head: null,
      created_at: now,
    });

    const out = { command: "evidence retry", evidenceId: p.evidenceId, jobId, requeued };
    if (ctx.output.mode === "json") emitJson(out);
    else ctx.render(`evidence retry ${p.evidenceId}: ${requeued ? "requeued" : "already queued"} (${jobId})`);
    return EXIT.OK;
  } finally {
    store.close();
  }
}

registerCommand("evidence retry", evidenceRetry);

export { evidenceRetry, parseArgs };
