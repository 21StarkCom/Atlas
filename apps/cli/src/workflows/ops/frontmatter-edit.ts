/**
 * Shared frontmatter editing for the claim/evidence/relationship executors. Uses the
 * `yaml` Document API so an edit mutates ONLY the targeted block (`claims:` /
 * `relationships:`) and re-emits the rest of the frontmatter with its formatting
 * preserved — the note body is spliced back byte-for-byte. The emitted YAML is exactly
 * what the sqlite-store folds parse, so the round-trip (write → commit → rebuild) is
 * projection-identical.
 */
import { Document, parseDocument, YAMLSeq, YAMLMap, isSeq, isMap } from "yaml";
import { splitFrontmatter } from "../../markdown/parse.js";

/** A note split into its editable frontmatter Document + verbatim body. */
export interface NoteEdit {
  readonly doc: Document.Parsed | Document;
  readonly body: string;
  readonly hadFrontmatter: boolean;
}

/** Parse a note into an editable frontmatter {@link Document} + its verbatim body. */
export function openNote(raw: string): NoteEdit {
  const { frontmatter, body } = splitFrontmatter(raw);
  if (frontmatter === null) {
    return { doc: new Document({}), body: raw.replace(/\r\n/g, "\n"), hadFrontmatter: false };
  }
  return { doc: parseDocument(frontmatter), body, hadFrontmatter: true };
}

/** Reassemble a note from an edited frontmatter Document + its body. */
export function reassemble(edit: NoteEdit): string {
  const fm = edit.doc.toString().replace(/\n+$/, "\n");
  return `---\n${fm}---\n${edit.body}`;
}

/** Get (creating if absent) the top-level sequence node under `key`. */
export function getOrCreateSeq(doc: Document.Parsed | Document, key: string): YAMLSeq {
  const existing = doc.get(key);
  if (existing !== undefined && isSeq(existing)) return existing as YAMLSeq;
  if (existing !== undefined) {
    // The key exists but is not a list — a malformed note; the executor rejects it.
    throw new Error(`frontmatter \`${key}:\` is present but is not a list`);
  }
  const seq = new YAMLSeq();
  doc.set(key, seq);
  return seq;
}

/** Read the top-level sequence under `key` as an array of plain maps (or empty). */
export function readMapSeq(doc: Document.Parsed | Document, key: string): Record<string, unknown>[] {
  const node = doc.get(key);
  if (node === undefined) return [];
  if (!isSeq(node)) throw new Error(`frontmatter \`${key}:\` is present but is not a list`);
  return (node as YAMLSeq).items.map((it) => (isMap(it) ? ((it as YAMLMap).toJSON() as Record<string, unknown>) : {}));
}

/** Append a plain object as a new map entry to the sequence under `key`. */
export function appendMap(doc: Document.Parsed | Document, key: string, entry: Record<string, unknown>): void {
  const seq = getOrCreateSeq(doc, key);
  seq.add(doc.createNode(entry));
}

/** The `claims:` sequence node, or null if absent. */
export function claimsSeq(doc: Document.Parsed | Document): YAMLSeq | null {
  const node = doc.get("claims");
  return node !== undefined && isSeq(node) ? (node as YAMLSeq) : null;
}

/** Find the `claims:` entry map whose `claim_id` equals `claimKey`, or null. */
export function findClaimNode(doc: Document.Parsed | Document, claimKey: string): YAMLMap | null {
  const seq = claimsSeq(doc);
  if (!seq) return null;
  for (const item of seq.items) {
    if (isMap(item) && (item as YAMLMap).get("claim_id") === claimKey) return item as YAMLMap;
  }
  return null;
}

/** The `evidence:` sequence under a claim map (creating it if absent). */
export function claimEvidenceSeq(doc: Document.Parsed | Document, claim: YAMLMap): YAMLSeq {
  const existing = claim.get("evidence");
  if (existing !== undefined && isSeq(existing)) return existing as YAMLSeq;
  if (existing !== undefined) throw new Error("claim `evidence:` is present but is not a list");
  claim.set("evidence", doc.createNode([]) as YAMLSeq);
  // `set` above stores an empty seq node; fetch it back to append onto the live node.
  return claim.get("evidence") as YAMLSeq;
}
