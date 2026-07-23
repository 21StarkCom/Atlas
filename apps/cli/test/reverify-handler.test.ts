/**
 * `reverify-handler` (Task 4.7) — the EXECUTE side of the reverify workflow.
 *
 * `brain evidence retry` enqueues a `reverify` job; before this handler the production
 * registry had no executor, so a drain hit the runner's "no handler" path → classified
 * TRANSIENT → burned the whole attempt budget with backoff → exit 4. This suite pins the
 * handler that makes the path work.
 *
 * Properties covered (mirrors the retention/remediation sibling handlers' contract):
 *   1. **Laziness** — `buildReverifyHandler` dereferences nothing at build time (the
 *      registry-completeness gate builds it with a stub `deps`).
 *   2. **Payload validation** — a malformed payload is a PERMANENT `validation` failure,
 *      never a transient one that retries forever.
 *   3. **Deterministic classification** — each `ReanchorMatch` verdict drives a distinct,
 *      fail-closed outcome (v2 #335: exact ⇒ auto-integrate; moved/ambiguous/
 *      not-found ⇒ terminal, no auto-commit).
 *   4. **Cooperative cancel** — a pre-aborted signal throws `AbortError` before any work.
 *   5. **No self-apply** — the durable verification change flows through the emitted
 *      `UpdateEvidenceVerification` ChangePlan (the injected apply seam), NEVER a direct
 *      `claim_evidence` write from the handler (Markdown is the SSOT; a bare projection
 *      write would be lost on `db rebuild`).
 */
import { describe, expect, it } from "vitest";
import type { ChangePlan, ParsedNote, VaultSnapshot } from "@atlas/contracts";
import { ChangePlanSchema } from "@atlas/contracts";
import { openStore, rebuildProjections, type Store } from "@atlas/sqlite-store";
import { classifyError, type JobHandlerContext, type JobHandlerResult } from "@atlas/jobs";
import { buildSectionTree } from "../src/markdown/sections.js";
import { splitFrontmatter } from "../src/markdown/parse.js";
import {
  buildReverifyHandler,
  type ReverifySeams,
  type ReanchorApplyRequest,
} from "../src/workflows/reverify-handler.js";
import { REVERIFY_WORKFLOW, type ReverifyJobPayload } from "../src/workflows/reverify.js";
import type { JobHandlerDeps } from "../src/commands/job-handlers.js";
import type { ReanchorInput } from "../src/workflows/reverify-match.js";

const HEX_A = "a".repeat(64);
const HEX_B = "b".repeat(64);
const CONTENT_A = `sha256:${HEX_A}:text/plain`;
const REND_A_21 = `sha256:${HEX_A}:text/plain:2:1`;

function makeNote(raw: string, over: Partial<ParsedNote> = {}): ParsedNote {
  const { body } = splitFrontmatter(raw);
  const id = /id:\s*(\S+)/.exec(raw)?.[1] ?? "n";
  return {
    id, path: `${id}.md`, type: "concept", schemaVersion: 1, title: id, status: "active",
    created: "2026-07-11", updated: "2026-07-11", aliases: [], sources: [], declaredSensitivity: "internal",
    links: [], sections: buildSectionTree(body), contentHash: "sha256:0", raw, ...over,
  };
}

function sourceNote(): ParsedNote {
  const raw = [
    "---", "id: s-a", "type: source", "schema_version: 1", "title: s-a",
    "created: 2026-07-11", "updated: 2026-07-11",
    `contentId: "${CONTENT_A}"`, "origin: notes/a.txt", "provenance:",
    "  vault_path: sources/a.txt", "  size_bytes: 12", "  renditions:",
    `    - { extractor_version: 1, normalizer_version: 1, normalized_content_hash: "${HEX_B}", size_bytes: 10, locator_scheme: char }`,
    `    - { extractor_version: 2, normalizer_version: 1, normalized_content_hash: "${HEX_B}", size_bytes: 10, locator_scheme: char }`,
    "---", "", "# s-a", "",
  ].join("\n");
  return makeNote(raw, { type: "source", id: "s-a", path: "sources/s-a.md" });
}

/** A note owning one claim with a VALID evidence head pinned to rendition 1:1. */
function claimNote(noteId: string, claimId: string): ParsedNote {
  const raw = [
    "---", `id: ${noteId}`, "type: concept", "schema_version: 1", `title: ${noteId}`,
    "created: 2026-07-11", "updated: 2026-07-11", "claims:",
    `  - claim_id: ${claimId}`, `    text: "Claim ${claimId}."`, "    evidence:",
    `      - rendition: "${CONTENT_A}:1:1"`, "        locator: \"char:0-5\"", `        quote_hash: "${HEX_B}"`, "        verification: valid",
    "---", "", `# ${noteId}`, "",
  ].join("\n");
  return makeNote(raw, { id: noteId, path: `${noteId}.md` });
}

function snap(notes: ParsedNote[]): VaultSnapshot {
  return { notes, errors: [] };
}

/** A migrated store seeded with a source + one claim/evidence note. */
function seededStore(): { store: Store; evidenceId: string } {
  const store = openStore({ path: ":memory:" });
  store.migrate();
  rebuildProjections(store.db, snap([sourceNote(), claimNote("note-a", "claim-a")]));
  const row = store.db
    .prepare(`SELECT evidence_id FROM claim_evidence WHERE claim_id = 'claim-a' AND current = 1`)
    .get() as { evidence_id: string };
  return { store, evidenceId: row.evidence_id };
}

/** A well-formed reverify payload for the seeded note. */
function payloadFor(evidenceId: string): ReverifyJobPayload {
  return {
    owningNoteId: "note-a",
    contentId: { rawContentHash: HEX_A, canonicalMediaType: "text/plain" },
    newRenditionId: REND_A_21,
    evidenceIds: [evidenceId],
  };
}

/** Recorded apply-seam invocations, for asserting the emitted ChangePlan. */
interface ApplyCall {
  readonly req: ReanchorApplyRequest;
}

/** Build seams: `recoverAnchor` forces a chosen verdict; `applyReanchor` records + returns. */
function seams(
  anchor: ReanchorInput | null,
  applyCalls: ApplyCall[],
  applyResult: { mode: "integrated"; runId: string } = { mode: "integrated", runId: "run-applied" },
): ReverifySeams {
  return {
    recoverAnchor: async () => anchor,
    applyReanchor: async (_deps, req) => {
      // Emitted plans MUST already be valid contract objects (byte-identity gate).
      ChangePlanSchema.parse(req.plan);
      applyCalls.push({ req });
      return applyResult;
    },
  };
}

async function runHandler(
  deps: JobHandlerDeps,
  s: ReverifySeams,
  payload: unknown,
  signal: AbortSignal = new AbortController().signal,
): Promise<JobHandlerResult> {
  const handler = buildReverifyHandler(deps, s);
  const jctx: JobHandlerContext = { jobId: "job-reverify", workflow: REVERIFY_WORKFLOW, attempt: 1, payload, signal, now: "2026-07-16T00:00:00.000Z" };
  return handler(jctx);
}

async function classifyThrown(p: Promise<unknown>): Promise<{ cls: string; code: string }> {
  try {
    await p;
  } catch (e) {
    const c = classifyError(e);
    return { cls: c.cls, code: c.code };
  }
  throw new Error("expected the handler to throw");
}

/** The verification of the (still-current) evidence head — proves no self-apply. */
function verificationOf(store: Store, evidenceId: string): string | undefined {
  const r = store.db.prepare(`SELECT verification FROM claim_evidence WHERE evidence_id = ? AND current = 1`).get(evidenceId) as { verification: string } | undefined;
  return r?.verification;
}

describe("buildReverifyHandler — shape + laziness", () => {
  it("builds without dereferencing deps (the completeness gate uses a stub)", () => {
    expect(() => buildReverifyHandler({} as JobHandlerDeps)).not.toThrow();
    expect(typeof buildReverifyHandler({} as JobHandlerDeps)).toBe("function");
  });
});

describe("buildReverifyHandler — classification paths", () => {
  it("exact ⇒ emits a `valid` UpdateEvidenceVerification ChangePlan and auto-integrates", async () => {
    const { store, evidenceId } = seededStore();
    const calls: ApplyCall[] = [];
    try {
      const s = seams({ quote: "Merid", previousStart: 0, newText: "Merid rises" }, calls);
      const res = await runHandler({ store } as JobHandlerDeps, s, payloadFor(evidenceId));
      expect(res.actionRequired).toBeFalsy();
      expect(res.runId).toBe("run-applied");
      expect(res.commit).toBeUndefined(); // durable change flows through the ChangePlan, not a commit closure
      expect(calls).toHaveLength(1);
      const op = calls[0]!.req.plan.operation as { op: string; toVerification: string; replacementRenditionId: string };
      expect(op.op).toBe("UpdateEvidenceVerification");
      expect(op.toVerification).toBe("valid");
      expect(op.replacementRenditionId).toBe(REND_A_21);
      // No self-apply: the handler never wrote the projection directly.
      expect(verificationOf(store, evidenceId)).toBe("valid"); // unchanged by the handler (fold owns it)
    } finally {
      store.close();
    }
  });

  it("moved ⇒ fail-closed (v2 #335: no Tier-3 review park), never an auto-commit", async () => {
    const { store, evidenceId } = seededStore();
    const calls: ApplyCall[] = [];
    try {
      const s = seams({ quote: "rises", previousStart: 0, newText: "Merid rises" }, calls); // found once, offset moved
      const res = await runHandler({ store } as JobHandlerDeps, s, payloadFor(evidenceId));
      expect(res.actionRequired).toBeFalsy();
      expect(res.commit).toBeUndefined();
      expect(calls).toHaveLength(0); // an uncertain re-anchor never integrates
    } finally {
      store.close();
    }
  });

  it("ambiguous ⇒ fail-closed (v2 #335), never an auto-commit", async () => {
    const { store, evidenceId } = seededStore();
    const calls: ApplyCall[] = [];
    try {
      const s = seams({ quote: "ab", previousStart: 0, newText: "ab cd ab" }, calls);
      const res = await runHandler({ store } as JobHandlerDeps, s, payloadFor(evidenceId));
      expect(res.actionRequired).toBeFalsy();
      expect(calls).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it("not-found ⇒ terminal failed verdict, no plan applied, no self-apply", async () => {
    const { store, evidenceId } = seededStore();
    const calls: ApplyCall[] = [];
    try {
      const s = seams({ quote: "zephyr", previousStart: 0, newText: "Merid rises" }, calls);
      const res = await runHandler({ store } as JobHandlerDeps, s, payloadFor(evidenceId));
      expect(res.actionRequired).toBeFalsy();
      expect(res.commit).toBeUndefined();
      expect(res.runId).toBeUndefined();
      expect(calls).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it("unrecoverable anchor ⇒ fail-closed (v2 #335: never a fabricated valid, no review park)", async () => {
    const { store, evidenceId } = seededStore();
    const calls: ApplyCall[] = [];
    try {
      const s = seams(null, calls); // no recoverable quote/text ⇒ failed, fail-closed
      const res = await runHandler({ store } as JobHandlerDeps, s, payloadFor(evidenceId));
      expect(res.actionRequired).toBeFalsy();
      expect(calls).toHaveLength(0);
    } finally {
      store.close();
    }
  });
});

describe("buildReverifyHandler — validation, cancel, idempotency", () => {
  it("rejects a malformed payload as a PERMANENT validation failure", async () => {
    const { store, evidenceId } = seededStore();
    const calls: ApplyCall[] = [];
    const s = seams({ quote: "x", previousStart: 0, newText: "x" }, calls);
    try {
      expect(await classifyThrown(runHandler({ store } as JobHandlerDeps, s, { owningNoteId: "note-a" }))).toMatchObject({ cls: "permanent", code: "validation" });
      expect(await classifyThrown(runHandler({ store } as JobHandlerDeps, s, "nope"))).toMatchObject({ cls: "permanent", code: "validation" });
      // empty evidenceIds is not a valid reverify unit of work
      expect(await classifyThrown(runHandler({ store } as JobHandlerDeps, s, { ...payloadFor(evidenceId), evidenceIds: [] }))).toMatchObject({ cls: "permanent", code: "validation" });
      expect(calls).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it("observes a pre-aborted signal and cancels before touching any seam", async () => {
    const { store, evidenceId } = seededStore();
    const calls: ApplyCall[] = [];
    const ac = new AbortController();
    ac.abort();
    let recovered = false;
    const s: ReverifySeams = {
      recoverAnchor: async () => { recovered = true; return { quote: "x", previousStart: 0, newText: "x" }; },
      applyReanchor: async (_d, req) => { calls.push({ req }); return { mode: "integrated", runId: "r" }; },
    };
    try {
      expect(await classifyThrown(runHandler({ store } as JobHandlerDeps, s, payloadFor(evidenceId), ac.signal))).toMatchObject({ cls: "cancelled", code: "cancelled" });
      expect(recovered).toBe(false);
      expect(calls).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it("skips an evidence head that is no longer current (idempotent re-drive)", async () => {
    const { store } = seededStore();
    const calls: ApplyCall[] = [];
    try {
      // A payload naming an evidence id that has no current head ⇒ nothing to re-anchor.
      const s = seams({ quote: "x", previousStart: 0, newText: "x" }, calls);
      const res = await runHandler({ store } as JobHandlerDeps, s, payloadFor("ev-does-not-exist"));
      expect(res.actionRequired).toBeFalsy();
      expect(res.commit).toBeUndefined();
      expect(calls).toHaveLength(0);
    } finally {
      store.close();
    }
  });
});
