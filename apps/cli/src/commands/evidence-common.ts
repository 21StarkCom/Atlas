/**
 * `commands/evidence-common` — the shared v2 evidence machinery (task 4-4).
 *
 * v2 evidence is a flat, vault-derived projection with NO renditions, NO run
 * ledger, and NO audit signature — so `evidence resolve`/`retry` are DETERMINISTIC
 * reverifications, not model or rendition re-anchors. Each writes the new
 * status/verdict/attempts into the note's frontmatter `evidence:` entry through the
 * canonical mutation order (`runMutation` → `commitPaths` → fold), so the value
 * lives in canonical Markdown (a `git revert` + `brain sync` re-folds it) and the
 * projection row is regenerated from the committed note — never written directly.
 *
 * Reverification is target resolution: the evidence's soft `noteId` (and its own
 * frontmatter entry) either still resolves — the citation stands, `resolved` — or
 * it does not — `target-missing`, eligible for `needs-review`, never a crash. A
 * dirty (uncommitted-edit) target note is refused by the mutation order's
 * dirty-vault gate; `evidence review` is where an edited-but-unsynced note surfaces
 * as stale/`needs-review` (via the `sourceNoteHash` guard).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { openRepo } from "@atlas/git";
import { foldNotesV2, EvidenceRepo, noteEvidenceInputs, type EvidenceRow } from "@atlas/sqlite-store";
import type { ParsedNote, SectionTree, VaultSnapshot } from "@atlas/contracts";
import { CliError, EXIT } from "../errors/envelope.js";
import type { RunContext } from "../handlers.js";
import { openWorkflowStore } from "../workflows/index.js";
import { runMutation, CANONICAL_BRANCH, type Grounded } from "../workflows/mutation-order.js";
import { resolveAtRef } from "../sync/resolve-at-ref.js";
import { splitFrontmatter } from "../markdown/parse.js";
import { readVault } from "../vault/reader.js";
import { ledgerDbPath, resolvePath } from "./paths.js";

/**
 * The read-time EFFECTIVE state of an evidence row against the CURRENT working-tree
 * vault (`evidence review`, task 4-4 / #337-F1). The stored `status` is only the
 * last-folded value; the effective state also accounts for the two ways the soft
 * target can drift SINCE that fold — which is what makes `sourceNoteHash` load-bearing
 * rather than write-only:
 *   - the note (soft `noteId`) no longer resolves ⇒ `target: missing` ⇒ needs-review;
 *   - a set `sectionPath` no longer resolves in the note ⇒ `target: missing`;
 *   - the note's on-disk `contentHash` != the fold-stamped `sourceNoteHash` (edited
 *     on disk without a `sync`) ⇒ stale ⇒ needs-review (`target: present`);
 *   - otherwise the row's own status (NULL ⇒ pending).
 */
export interface EffectiveEvidence {
  readonly state: "pending" | "failed" | "needs-review" | "resolved";
  readonly target: "present" | "missing";
  readonly detail: string | null;
}

/** Collect every descendant section path of a note's section tree (the root "" excluded). */
function sectionPathsOf(root: SectionTree): Set<string> {
  const acc = new Set<string>();
  const walk = (node: SectionTree): void => {
    for (const c of node.children) {
      if (c.path !== "") acc.add(c.path);
      walk(c);
    }
  };
  walk(root);
  return acc;
}

/** Compute an evidence row's effective read-time state against the vault snapshot. */
export function effectiveEvidenceState(row: EvidenceRow, noteById: Map<string, ParsedNote>): EffectiveEvidence {
  const note = row.noteId !== null ? noteById.get(row.noteId) : undefined;
  if (note === undefined) {
    return { state: "needs-review", target: "missing", detail: "target note no longer resolves" };
  }
  if (row.sectionPath !== null && row.sectionPath !== "" && !sectionPathsOf(note.sections).has(row.sectionPath)) {
    return { state: "needs-review", target: "missing", detail: `section "${row.sectionPath}" no longer resolves` };
  }
  if (row.sourceNoteHash !== null && note.contentHash !== row.sourceNoteHash) {
    return { state: "needs-review", target: "present", detail: "source note edited since last fold (stale)" };
  }
  return { state: row.status ?? "pending", target: "present", detail: null };
}

/** The outcome of an `evidence resolve`/`retry` reverification. */
export interface EvidenceMutateResult {
  readonly outcome: "resolved" | "target-missing";
  readonly evidenceId: string;
  readonly noteId: string;
  readonly status: "resolved" | "needs-review";
  /** The (possibly incremented) attempts counter now recorded in the note. */
  readonly attempts: number;
  /** The canonical commit the resolution landed as — present ONLY on `resolved`. */
  readonly commit?: string;
}

/**
 * Frontmatter surgery: set `fields` on the note's `evidence:` entry with id
 * `evidenceId`. Uses the `yaml` Document API so untouched frontmatter survives
 * byte-faithfully (the `link` pattern). Returns the new full note text, or `null`
 * when the note's current frontmatter has no matching entry (drift — the fold-
 * derived row no longer has a source entry).
 */
export function setEvidenceFields(
  noteText: string,
  evidenceId: string,
  fields: Record<string, string | number>,
): string | null {
  const { frontmatter, body } = splitFrontmatter(noteText);
  if (frontmatter === null) return null;
  const doc = parseDocument(frontmatter);
  const js = doc.toJS() as { evidence?: unknown } | null;
  const list = Array.isArray(js?.evidence) ? (js!.evidence as { id?: unknown }[]) : [];
  const idx = list.findIndex((e) => e?.id === evidenceId);
  if (idx === -1) return null;
  for (const [k, v] of Object.entries(fields)) doc.setIn(["evidence", idx, k], v);
  return `---\n${doc.toString()}---\n${body}`;
}

/** Does the note's frontmatter currently carry an `evidence:` entry with this id? */
function frontmatterHasEntry(note: ParsedNote, evidenceId: string): boolean {
  try {
    return noteEvidenceInputs(note).some((e) => e.id === evidenceId);
  } catch {
    return false; // a malformed block ⇒ treat as unresolved (target-missing)
  }
}

/**
 * The shared reverification runner for `evidence resolve` (bumpAttempts=false) and
 * `evidence retry` (bumpAttempts=true). Reads the flat evidence row, resolves its
 * target note from the vault, and either records `resolved` into the note
 * frontmatter through the mutation order or reports `target-missing` (no mutation).
 * Throws `not-found` (exit 1) when the evidence id does not exist.
 */
export async function mutateEvidence(
  ctx: RunContext,
  evidenceId: string,
  opts: { bumpAttempts: boolean },
): Promise<EvidenceMutateResult> {
  const cfg = ctx.config.config;
  const vaultPath = resolvePath(ctx, cfg.vault.path);
  const repo = openRepo(vaultPath);
  const store = openWorkflowStore({ path: ledgerDbPath(ctx) });
  try {
    const row = new EvidenceRepo(store.db).byId(evidenceId);
    if (row === undefined) {
      throw new CliError({
        code: "not-found",
        message: `evidence ${evidenceId} does not exist`,
        hint: "Pass an evidenceId from `brain evidence review`.",
        exitCode: EXIT.VALIDATION,
      });
    }
    const noteId = row.noteId;

    const snapshot: VaultSnapshot = await readVault(cfg);
    const note = noteId !== null ? snapshot.notes.find((n) => n.id === noteId) : undefined;

    // target-missing: the note (or its own frontmatter entry) no longer resolves —
    // cannot mutate a gone target; surface needs-review, no commit, exit 0.
    if (note === undefined || !frontmatterHasEntry(note, evidenceId)) {
      return {
        outcome: "target-missing",
        evidenceId,
        noteId: noteId ?? "(unknown)",
        status: "needs-review",
        attempts: row.attempts,
      };
    }

    const notePath = note.path;
    const now = new Date().toISOString();
    const attempts = opts.bumpAttempts ? row.attempts + 1 : row.attempts;
    const fields: Record<string, string | number> = {
      status: "resolved",
      verdict: "re-anchored to the current note",
      lastCheckedAt: now,
      ...(opts.bumpAttempts ? { attempts } : {}),
    };

    const result = await runMutation<EvidenceMutateResult>({
      ctx,
      repo,
      vaultPath,
      store,
      ground(preApply): Grounded {
        const abs = join(vaultPath, notePath);
        const next = setEvidenceFields(readFileSync(abs, "utf8"), evidenceId, fields);
        if (next === null) {
          // The clean note's frontmatter disagrees with the projected row — a fold
          // drift, not user error (the same class `link`'s surgery guards).
          throw new CliError({
            code: "internal",
            message: `\`evidence\`: the projection has evidence ${evidenceId} but note ${noteId} carries no matching frontmatter entry`,
            hint: "Run `brain db rebuild` and retry.",
            exitCode: EXIT.INTERNAL,
          });
        }
        preApply();
        return {
          touchedPaths: [notePath],
          commitMessage: `evidence ${opts.bumpAttempts ? "retry" : "resolve"} ${evidenceId}`,
          affectedNoteIds: [noteId!],
          dirtyCheckPaths: [notePath],
          apply(): void {
            writeFileSync(abs, next, "utf8");
          },
        };
      },
      async refreshProjection(): Promise<void> {
        foldNotesV2(store, [noteId!], resolveAtRef(repo, CANONICAL_BRANCH, cfg.vault.note_globs));
        await Promise.resolve();
      },
      buildResult(commitSha): EvidenceMutateResult {
        return { outcome: "resolved", evidenceId, noteId: noteId!, status: "resolved", attempts, commit: commitSha };
      },
    });
    return result;
  } finally {
    store.close();
  }
}
