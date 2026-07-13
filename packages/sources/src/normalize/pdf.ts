/**
 * The PDF normalizer (`application/pdf`) — a dependency-LIGHT, deterministic text
 * extractor (`normalization-contract.md`; `pdf-page-span` locator).
 *
 * WHY hand-rolled (not a library): the normalizer runs INSIDE the sandbox worker
 * (D15), whose read-closure is deliberately small — pulling a heavyweight PDF engine
 * (pdf.js) into that closure would widen the jail's read allowlist and its
 * non-determinism surface. This extractor uses ONLY `node:zlib` (a builtin) for
 * `FlateDecode`. `extractorVersion` (in `./index.ts`) PINS this extractor's generation:
 * any change to extraction behaviour bumps it, so an upgrade is a NEW rendition, never
 * silent drift on the same identity.
 *
 * FAITHFULNESS over coverage (wing round-2 finding 5). Core rule 2 of the contract is
 * that PARTIAL EXTRACTION IS A REJECTION — the extractor returns a complete faithful
 * rendition or a typed rejection, NEVER truncated / guessed text as success. So this
 * extractor conservatively REJECTS the constructs it cannot decode faithfully rather
 * than emitting corrupt text:
 *   - **font encodings / ToUnicode CMaps** — a page whose font is a CID/Type0 font, uses
 *     `Identity-H/V`, or declares a `/Differences` encoding or a `/ToUnicode` CMap cannot
 *     be reverse-mapped to Unicode without applying that CMap, so it is
 *     `partial-extraction`. `/Font` values are resolved through ONE level of indirection
 *     (an indirect font dictionary / indirect font object), so an indirect unsupported
 *     font is rejected too, never bypassed (finding 3). Simple fonts (Type1/TrueType) with
 *     a standard base encoding are extracted literally (ASCII bytes are faithful); a
 *     `/WinAnsiEncoding` font's non-ASCII bytes are decoded through the cp1252 map, not as
 *     Latin-1, so WinAnsi text is correct Unicode rather than corrupt text (finding 3).
 *   - **missing / malformed page-tree branches** — a `/Kids` entry or `/Contents` stream
 *     that resolves to no object body is `partial-extraction` (never silently dropped).
 *   - **incremental updates** — an object redefined by a later incremental section wins
 *     (LAST definition, appended), so a stale earlier revision is never selected.
 *   - **comments + operands outside `BT`/`ET`** — `%` comments are skipped and only string
 *     operands shown BETWEEN `BT`/`ET` text objects contribute text, so a comment body or
 *     a stray string never leaks as visible content.
 *   - **unsupported filters / malformed streams** — anything but uncompressed or
 *     `FlateDecode` content, or a stream that fails to inflate, is `partial-extraction`.
 * A well-formed PDF whose pages carry no text layer (scanned / image-only) is
 * `no-extractable-text`; an encrypted document is `encrypted-source`.
 */
import { inflateSync } from "node:zlib";
import type { NormalizeOutcome } from "./media.js";

/** A typed error used internally to unwind to a `partial-extraction` rejection. */
class PartialExtractionError extends Error {}

/** Decode raw PDF bytes as latin1 so every byte is a 1:1 char (offsets == byte offsets). */
function latin1(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("latin1");
}

/**
 * Read a balanced `<< … >>` dictionary starting at/after `from` (skipping leading
 * whitespace). Returns the dictionary text INCLUDING its delimiters, or `null` if `from`
 * does not begin a dictionary. Nested `<<…>>` are balanced so an inner dict never ends
 * the scan early — used to isolate the trailer / a `/Font` value dictionary exactly.
 */
function readDict(s: string, from: number): string | null {
  let i = from;
  while (i < s.length && /\s/.test(s[i]!)) i++;
  if (s[i] !== "<" || s[i + 1] !== "<") return null;
  const start = i;
  let depth = 0;
  // PDF-LEXICAL balance (wing round-3 finding): literal `(…)`, hex `<…>`, and `%` comment
  // bytes are SKIPPED, so a `>>` sitting inside a string value (e.g. `/Custom (a >> b)`) or a
  // hex string never prematurely closes the dictionary and drops the keys after it (a
  // truncated trailer could otherwise MISS a trailing `/Encrypt` and mis-report an encrypted
  // document as clean). The pre-fix code balanced raw `<<`/`>>` tokens with no string awareness.
  while (i < s.length) {
    const ch = s[i]!;
    if (ch === "%") {
      // Comment: skip to end-of-line (never dictionary structure).
      let j = i + 1;
      while (j < s.length && s[j] !== "\n" && s[j] !== "\r") j++;
      i = j;
      continue;
    }
    if (ch === "(") {
      i = skipLiteralString(s, i); // balanced literal string — its bytes are opaque
      continue;
    }
    if (ch === "<" && s[i + 1] === "<") {
      depth++;
      i += 2;
      continue;
    }
    if (ch === "<") {
      // Hex string `<…>` — skip to its close so a `>` inside it is not read as `>>` structure.
      const close = s.indexOf(">", i + 1);
      if (close === -1) return null;
      i = close + 1;
      continue;
    }
    if (ch === ">" && s[i + 1] === ">") {
      depth--;
      i += 2;
      if (depth === 0) return s.slice(start, i);
      continue;
    }
    i++;
  }
  return null;
}

/**
 * Skip a PDF literal string starting at `s[i] === '('`, returning the index just after its
 * balanced closing `)`. Escapes (`\(`, `\)`, `\\`, …) are honoured; a runaway string never
 * throws (returns end-of-input) so top-level trailer parsing — which runs BEFORE the main
 * extraction try/catch — can never abort `normalizePdf` with an uncaught error.
 */
function skipLiteralString(s: string, i: number): number {
  let depth = 1;
  let j = i + 1;
  while (j < s.length) {
    const ch = s[j]!;
    if (ch === "\\") {
      j += 2; // escape: skip the next char too
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return j + 1;
    }
    j++;
  }
  return s.length;
}

/**
 * Parse a `<< … >>` dictionary into its TOP-LEVEL `/Key → value-text` pairs (round-2 finding:
 * parse `/Encrypt`/`/Root` as top-level dictionary keys). Nested `<<…>>`/`[…]` and literal/hex
 * STRINGS are skipped, so a `/Encrypt` or `/Root` token that appears inside a string, a `%`
 * comment, or a nested value is NEVER mistaken for a top-level key (the pre-fix code matched
 * `/Encrypt` anywhere in the trailer text). The value is the raw substring from a key to the
 * next top-level key (or the dict end).
 */
/**
 * Decode a PDF name token's `#XX` hex escapes (wing round-3 finding): a name may write any
 * character of its literal form as `#` + two hex digits, so `/En#63rypt` (0x63 = 'c') is the
 * name `/Encrypt`. Decoding here means a structural key written with escapes is matched by its
 * true name (`isEncrypted`/`/Root` lookups can no longer be evaded by escaping a key). The
 * leading `/` is preserved; a malformed `#` (not followed by two hex digits) is left literal.
 */
function decodePdfName(name: string): string {
  if (!name.includes("#")) return name;
  return name.replace(/#([0-9A-Fa-f]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

function parseTopLevelDict(dict: string): Map<string, string> {
  const out = new Map<string, string>();
  let i = dict.indexOf("<<");
  if (i === -1) return out;
  i += 2;
  let arrDepth = 0;
  let dictDepth = 0;
  let key: string | null = null;
  let valStart = -1;
  const commit = (end: number): void => {
    if (key !== null && valStart !== -1) out.set(key, dict.slice(valStart, end).trim());
  };
  while (i < dict.length) {
    const ch = dict[i]!;
    if (ch === "%") {
      let j = i + 1;
      while (j < dict.length && dict[j] !== "\n" && dict[j] !== "\r") j++;
      i = j;
      continue;
    }
    if (ch === "(") {
      i = skipLiteralString(dict, i);
      continue;
    }
    if (ch === "<" && dict[i + 1] === "<") {
      dictDepth++;
      i += 2;
      continue;
    }
    if (ch === ">" && dict[i + 1] === ">") {
      if (dictDepth === 0) {
        commit(i); // end of the outer dict
        return out;
      }
      dictDepth--;
      i += 2;
      continue;
    }
    if (ch === "<") {
      const close = dict.indexOf(">", i); // hex string — skip to its close
      if (close === -1) break;
      i = close + 1;
      continue;
    }
    if (ch === "[") {
      arrDepth++;
      i++;
      continue;
    }
    if (ch === "]") {
      if (arrDepth > 0) arrDepth--;
      i++;
      continue;
    }
    if (ch === "/" && arrDepth === 0 && dictDepth === 0) {
      commit(i); // close the previous key's value at this key's start
      let j = i + 1;
      while (j < dict.length && /[^\s/[\]<>()%]/.test(dict[j]!)) j++;
      key = decodePdfName(dict.slice(i, j)); // includes the leading '/'; `#XX` escapes decoded
      valStart = j;
      i = j;
      continue;
    }
    i++;
  }
  commit(i);
  return out;
}

/**
 * The trailer dictionary (top-level keys) of the classic xref section at byte `offset`
 * (`xref … trailer << … >>`). `latin1` decoding makes string offsets == byte offsets, so a
 * `startxref` value indexes directly here. `null` when the offset leads to no classic
 * `trailer` (e.g. an xref STREAM — outside this extractor's V1 target).
 */
function trailerAtXref(s: string, offset: number): Map<string, string> | null {
  if (offset < 0 || offset >= s.length) return null;
  const tIdx = s.indexOf("trailer", offset);
  if (tIdx === -1) return null;
  const dict = readDict(s, tIdx + "trailer".length);
  return dict === null ? null : parseTopLevelDict(dict);
}

/**
 * The LAST textual `trailer << … >>` as top-level keys — the fallback used only when the file
 * carries no resolvable `startxref` chain (e.g. a synthetic fixture with no cross-reference
 * table). `null` when there is no `trailer` keyword at all.
 */
function lastTextualTrailer(s: string): Map<string, string> | null {
  let last: string | null = null;
  const re = /\btrailer\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const dict = readDict(s, m.index + m[0].length);
    if (dict !== null) last = dict;
  }
  return last === null ? null : parseTopLevelDict(last);
}

/**
 * Resolve the ACTIVE trailer (findings 1 + 2, round-2: resolve from the final startxref chain)
 * by following the LAST `startxref` → xref → trailer, walking `/Prev` to older sections and
 * merging their top-level keys with the NEWEST definition winning. On an incremental update the
 * final `startxref` names the most recent cross-reference section, whose trailer carries the
 * current `/Root`/`/Encrypt`; `/Prev` chains to prior sections for any key the newest omits.
 * Falls back to the last textual trailer when there is no resolvable `startxref` chain.
 */
function activeTrailerDict(s: string): Map<string, string> | null {
  const starts = [...s.matchAll(/\bstartxref\b\s+(\d+)/g)];
  if (starts.length === 0) return lastTextualTrailer(s);
  const merged = new Map<string, string>();
  const seen = new Set<number>();
  let offset: number | null = Number(starts[starts.length - 1]![1]);
  while (offset !== null && !seen.has(offset)) {
    seen.add(offset);
    const trailer = trailerAtXref(s, offset);
    if (trailer === null) break;
    for (const [k, v] of trailer) if (!merged.has(k)) merged.set(k, v); // newest section wins
    const prev = trailer.get("/Prev");
    offset = prev !== undefined && /^\d+$/.test(prev.trim()) ? Number(prev.trim()) : null;
  }
  return merged.size > 0 ? merged : lastTextualTrailer(s);
}

/**
 * True when the document declares encryption. Resolved ONLY from the ACTIVE trailer's
 * TOP-LEVEL `/Encrypt` key (finding 1 + round-2): `/Encrypt` inside a content stream, a
 * comment, a string, page metadata, or a nested trailer value is NOT an encryption
 * declaration and must not trigger a false `encrypted-source` rejection of a clean PDF.
 */
function isEncrypted(s: string): boolean {
  const trailer = activeTrailerDict(s);
  return trailer !== null && trailer.has("/Encrypt");
}

/**
 * Parse `N G obj … endobj` bodies into an object-number → body map. LAST definition
 * wins (wing round-2 finding 5): in an incrementally-updated PDF later sections APPEND
 * redefinitions of an object number, and the appended revision supersedes the earlier
 * one — so selecting the last occurrence yields the current object, never a stale
 * revision. (Generation numbers are not tracked; the common single-generation +
 * append-update shape is what V1 targets, and any construct that cannot be decoded
 * faithfully downstream becomes `partial-extraction`.)
 */
function parseObjects(s: string): Map<number, string> {
  const map = new Map<number, string>();
  const re = /(\d+)\s+\d+\s+obj\b([\s\S]*?)\bendobj/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    map.set(Number(m[1]), m[2]!); // overwrite: last (appended) revision wins
  }
  return map;
}

/** Find the catalog object body by scanning (`/Type /Catalog`) — the last-resort fallback. */
function findCatalog(map: Map<number, string>): string | null {
  for (const body of map.values()) {
    if (/\/Type\s*\/Catalog\b/.test(body)) return body;
  }
  return null;
}

/** One textual `N G obj … endobj` definition: its number, GENERATION, byte offset, and body. */
interface ObjectDef {
  readonly num: number;
  readonly gen: number;
  readonly offset: number;
  readonly body: string;
}

/**
 * Parse EVERY `N G obj … endobj` definition, retaining its generation AND byte offset (wing
 * round-3 finding). The number-only {@link parseObjects} map (last-wins) still drives page/
 * content/font resolution; this generation- and offset-aware list is what {@link resolveActiveObject}
 * uses to resolve the `/Root` catalog to its PROVEN active revision rather than "last textual
 * definition of the object NUMBER" (which a later unreferenced / higher-generation / freed
 * definition could hijack).
 */
function parseObjectDefs(s: string): ObjectDef[] {
  const defs: ObjectDef[] = [];
  const re = /(\d+)\s+(\d+)\s+obj\b([\s\S]*?)\bendobj/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    defs.push({ num: Number(m[1]), gen: Number(m[2]), offset: m.index, body: m[3]! });
  }
  return defs;
}

/** One classic cross-reference entry: the byte offset of an in-use object, or a free slot. */
interface XrefEntry {
  readonly offset: number;
  readonly gen: number;
  readonly free: boolean;
}

const XREF_HEADER_RE = /(\d+)\s+(\d+)/y;
const XREF_ENTRY_RE = /\s*(\d{1,10})\s+(\d{1,5})\s+([nf])\b/y;

/**
 * Parse the classic `xref` section at `offset` into `entries` (NEWEST section wins — the caller
 * walks the chain newest→oldest), and return the `/Prev` offset (or `null` at the chain end).
 * Returns `undefined` when `offset` does not lead to a classic `xref` table (e.g. an xref
 * STREAM, outside this extractor's V1 target) so the caller can stop trusting the chain.
 */
function parseXrefSectionAt(s: string, offset: number, entries: Map<number, XrefEntry>): number | null | undefined {
  let i = offset;
  while (i < s.length && /\s/.test(s[i]!)) i++;
  if (s.slice(i, i + 4) !== "xref") return undefined; // not a classic xref table
  i += 4;
  for (;;) {
    while (i < s.length && /\s/.test(s[i]!)) i++;
    if (s.slice(i, i + 7) === "trailer") break;
    XREF_HEADER_RE.lastIndex = i;
    const header = XREF_HEADER_RE.exec(s);
    if (header === null || header.index !== i) return undefined; // malformed subsection header
    const start = Number(header[1]);
    const count = Number(header[2]);
    i = XREF_HEADER_RE.lastIndex;
    for (let k = 0; k < count; k++) {
      XREF_ENTRY_RE.lastIndex = i;
      const ent = XREF_ENTRY_RE.exec(s);
      if (ent === null || ent.index !== i) return undefined; // malformed entry
      const num = start + k;
      if (!entries.has(num)) {
        entries.set(num, { offset: Number(ent[1]), gen: Number(ent[2]), free: ent[3] === "f" });
      }
      i = XREF_ENTRY_RE.lastIndex;
    }
  }
  const dict = readDict(s, i + "trailer".length);
  if (dict === null) return null;
  const prev = parseTopLevelDict(dict).get("/Prev");
  return prev !== undefined && /^\d+$/.test(prev.trim()) ? Number(prev.trim()) : null;
}

/**
 * The ACTIVE classic-xref chain (from the final `startxref`, following `/Prev`) as objNum →
 * active {@link XrefEntry}, or `null` when no classic chain is resolvable (no `startxref`, or
 * the offset leads to an xref stream). When present it is AUTHORITATIVE for which physical
 * definition (byte offset) of an object is current — the mechanism that proves the active
 * `/Root` revision instead of guessing "last textual definition" (wing round-3 finding).
 */
function activeXref(s: string): Map<number, XrefEntry> | null {
  const starts = [...s.matchAll(/\bstartxref\b\s+(\d+)/g)];
  if (starts.length === 0) return null;
  const entries = new Map<number, XrefEntry>();
  const seen = new Set<number>();
  let offset: number | null = Number(starts[starts.length - 1]![1]);
  let resolvedAny = false;
  while (offset !== null && !seen.has(offset)) {
    seen.add(offset);
    if (offset < 0 || offset >= s.length) break;
    const prev = parseXrefSectionAt(s, offset, entries);
    if (prev === undefined) break; // not a classic table — chain unresolvable from here
    resolvedAny = true;
    offset = prev;
  }
  return resolvedAny ? entries : null;
}

/**
 * Resolve the body of object `num` at generation `gen` to its PROVEN active revision (wing
 * round-3 finding). When a classic xref chain exists it is AUTHORITATIVE: a FREE entry, a
 * missing definition at the named offset, or a generation mismatch means the active revision
 * cannot be proven ⇒ `null` (the caller rejects). Only when the chain does NOT cover the object
 * (or there is no classic chain — synthetic fixtures) do we fall back to the LAST textual
 * definition matching BOTH number and generation (the incremental-append convention). A later
 * definition at a DIFFERENT generation never shadows the requested one.
 */
function resolveActiveObject(s: string, num: number, gen: number): string | null {
  const defs = parseObjectDefs(s);
  const xref = activeXref(s);
  const entry = xref?.get(num);
  if (entry !== undefined) {
    if (entry.free) return null; // a freed object cannot be the active catalog
    const at = defs.find((d) => d.num === num && d.offset === entry.offset);
    if (at === undefined) return null; // xref names an offset with no object body there
    return at.gen === gen ? at.body : null; // generation must match the reference + the xref
  }
  // No xref coverage: last textual definition at the requested (num, gen) — never a different gen.
  let body: string | null = null;
  for (const d of defs) if (d.num === num && d.gen === gen) body = d.body;
  return body;
}

/**
 * Resolve the CURRENT catalog via the ACTIVE trailer's `/Root` (finding 2 + round-2/3 findings).
 * Once an active `/Root` exists it is AUTHORITATIVE: its EXACT object AND GENERATION must resolve —
 * through the active xref chain when one exists, else the last same-generation definition — to a
 * `/Type /Catalog`, else the document is `partial-extraction`. The pre-fix code looked the `/Root`
 * object up in a number-only, last-textual-wins map, so an unreferenced trailing definition, a
 * higher-generation shadow, or a freed incremental object could silently replace the active
 * catalog. The `/Type /Catalog` scan is reached ONLY when there is no active trailer/`Root` at all.
 */
function resolveCatalog(s: string, map: Map<number, string>): string {
  const rootValue = activeTrailerDict(s)?.get("/Root");
  if (rootValue !== undefined) {
    const ref = /(\d+)\s+(\d+)\s+R/.exec(rootValue);
    if (ref === null) throw new PartialExtractionError("active trailer /Root is not an indirect reference");
    const num = Number(ref[1]);
    const gen = Number(ref[2]);
    const body = resolveActiveObject(s, num, gen);
    if (body === null) {
      throw new PartialExtractionError(`active trailer /Root object ${num} ${gen} R cannot be resolved to a proven active revision`);
    }
    if (!/\/Type\s*\/Catalog\b/.test(body)) throw new PartialExtractionError(`active trailer /Root object ${num} is not a catalog`);
    return body; // the active /Root is authoritative — never a stale/shadowed fallback
  }
  const fallback = findCatalog(map);
  if (fallback === null) throw new PartialExtractionError("no catalog object");
  return fallback;
}

/** A resolved leaf page + the resource dictionary text in EFFECT for it (own or inherited). */
interface ResolvedPage {
  readonly page: number;
  /** The own-else-inherited `/Resources` text (for font validation); "" if none in the chain. */
  readonly resources: string;
}

/**
 * Collect leaf pages in document order by walking the page tree, THREADING the inherited
 * `/Resources` dictionary down the `/Pages` chain (wing round-3 finding 4). PDF inherits
 * `/Resources` as a whole from the nearest ancestor `/Pages` node that declares it, so a
 * leaf that omits `/Resources` uses its ancestor's — and a leaf that DECLARES its own
 * (even one without `/Font`) fully overrides the inherited dictionary (per-attribute
 * inheritance is by whole dictionary, not a merge). We record the EFFECTIVE resource text
 * per leaf so font validation sees an inherited CID/Type0/ToUnicode font, instead of
 * mistaking the leaf for font-less and returning corrupt text. A `/Kids` reference (or the
 * root) that resolves to NO object body is a malformed branch ⇒ `partial-extraction`,
 * never silently dropped (wing round-2 finding 5).
 */
function collectPages(root: number, map: Map<number, string>, seen: Set<number>, inheritedResources: string): ResolvedPage[] {
  if (seen.has(root)) return []; // cycle guard
  seen.add(root);
  const body = map.get(root);
  if (body === undefined) throw new PartialExtractionError(`page-tree node ${root} has no object body`);
  // This node's own /Resources (if any) overrides what it inherits; else the chain value.
  const own = pageResourcesText(body, map);
  const effective = own !== "" ? own : inheritedResources;
  // A leaf page: `/Type /Page` (not `/Pages`).
  if (/\/Type\s*\/Page\b(?!s)/.test(body)) return [{ page: root, resources: effective }];
  const kids = /\/Kids\s*\[([^\]]*)\]/.exec(body);
  if (kids === null) throw new PartialExtractionError(`page-tree node ${root} is neither a page nor has /Kids`);
  const out: ResolvedPage[] = [];
  for (const ref of kids[1]!.matchAll(/(\d+)\s+\d+\s+R/g)) {
    out.push(...collectPages(Number(ref[1]), map, seen, effective));
  }
  return out;
}

/** The content-stream object numbers a page references (`/Contents` ref or array). */
function pageContentRefs(pageBody: string): number[] {
  const single = /\/Contents\s+(\d+)\s+\d+\s+R/.exec(pageBody);
  if (single !== null) return [Number(single[1])];
  const array = /\/Contents\s*\[([^\]]*)\]/.exec(pageBody);
  if (array !== null) return [...array[1]!.matchAll(/(\d+)\s+\d+\s+R/g)].map((m) => Number(m[1]));
  return [];
}

/** Resolve the resource dictionary text for a page (inline `<<…>>` or a `/Resources` ref). */
function pageResourcesText(pageBody: string, map: Map<number, string>): string {
  const ref = /\/Resources\s+(\d+)\s+\d+\s+R/.exec(pageBody);
  if (ref !== null) return map.get(Number(ref[1])) ?? "";
  // Inline: everything after `/Resources` is a reasonable window to scan for font refs.
  const inline = pageBody.indexOf("/Resources");
  return inline === -1 ? "" : pageBody.slice(inline);
}

/**
 * The `/Font` sub-dictionary text of a page's resource dictionary, resolving ONE level of
 * indirection (finding 3). `/Font` may be inline (`/Font << /F1 4 0 R >>`) OR an indirect
 * reference (`/Font 7 0 R`) whose object body is the font dictionary. The pre-fix code only
 * handled the inline form and, for the indirect form, scanned the raw resource text for
 * `N G R` tokens — so it validated the FONT-DICTIONARY object (not a font) and the real
 * font objects it referenced were never inspected: an indirect Type0 font bypassed
 * validation entirely and its bytes were decoded as corrupt Latin-1. Returns "" when the
 * resources declare no `/Font`.
 */
function fontDictText(resourcesText: string, map: Map<number, string>): string {
  const at = resourcesText.search(/\/Font\b/);
  if (at === -1) return ""; // no /Font declared — a genuinely font-less resource dictionary
  const after = at + "/Font".length;
  // Inline dictionary value.
  const inline = readDict(resourcesText, after);
  if (inline !== null) return inline;
  // Indirect reference value → resolve the font-dictionary object body. An UNRESOLVED
  // reference is a declared-but-missing font resource ⇒ partial-extraction (round-2 finding):
  // the pre-fix `?? ""` silently omitted it, after which text decoded as Latin-1 succeeded.
  const ref = /^\s*(\d+)\s+\d+\s+R/.exec(resourcesText.slice(after));
  if (ref !== null) {
    const body = map.get(Number(ref[1]));
    if (body === undefined) throw new PartialExtractionError(`/Font resource ${ref[1]} 0 R is unresolved`);
    return body;
  }
  return "";
}

/** One named font entry of a `/Font` dictionary + its (indirection-resolved) body. */
interface FontEntry {
  readonly name: string;
  readonly body: string;
}

/**
 * Parse the named entries of a `/Font` dictionary, resolving each value's indirection
 * (finding 3): a value is either an indirect reference `N G R` (resolved through `map`) or
 * an inline font dictionary `<< … >>`. So `/F1 4 0 R` yields the body of object 4 — the
 * actual font — rather than being skipped. An UNRESOLVED indirect entry is a declared-but-
 * missing font resource ⇒ partial-extraction (round-2 finding): the pre-fix code silently
 * omitted it, after which the page's text was decoded as Latin-1 and returned as success.
 */
function fontEntries(fontDict: string, map: Map<number, string>): FontEntry[] {
  const out: FontEntry[] = [];
  let i = 0;
  while (i < fontDict.length) {
    if (fontDict[i] !== "/") {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < fontDict.length && /[A-Za-z0-9.+\-_]/.test(fontDict[j]!)) j++;
    const name = fontDict.slice(i + 1, j);
    let k = j;
    while (k < fontDict.length && /\s/.test(fontDict[k]!)) k++;
    const ref = /^(\d+)\s+\d+\s+R/.exec(fontDict.slice(k));
    if (ref !== null) {
      const body = map.get(Number(ref[1]));
      if (body === undefined) throw new PartialExtractionError(`font /${name} references unresolved object ${ref[1]} 0 R`);
      out.push({ name, body });
      i = k + ref[0].length;
      continue;
    }
    const inline = readDict(fontDict, k);
    if (inline !== null) {
      out.push({ name, body: inline });
      i = k + inline.length;
      continue;
    }
    i = j;
  }
  return out;
}

/**
 * The ENCODING descriptor text to inspect for a font (wing round-3 finding 4): a font's
 * `/Encoding` may be an INDIRECT reference (`/Encoding N G R`) to a separate encoding object
 * — typically an encoding dictionary carrying a `/Differences` array. The pre-fix validator
 * only looked at the font body's own text, so an indirect `/Encoding` pointing at a
 * `/Differences` remap was NEVER seen: the font was mistaken for a plain base-encoding font
 * and its bytes were decoded as ASCII (corrupt text returned as success). Here we RESOLVE that
 * one level of indirection and return the encoding object's body so the `/Differences`/base-
 * encoding checks below run against the REAL encoding. An UNRESOLVED indirect `/Encoding` is a
 * declared-but-missing resource ⇒ partial-extraction (never silently treated as ASCII). When
 * `/Encoding` is a name or an inline dictionary it already lives in `fontBody`, returned as-is.
 */
function fontEncodingText(fontBody: string, map: Map<number, string>): string {
  const indirect = /\/Encoding\s+(\d+)\s+(\d+)\s+R/.exec(fontBody);
  if (indirect !== null) {
    const body = map.get(Number(indirect[1]));
    if (body === undefined) {
      throw new PartialExtractionError(`font /Encoding ${indirect[1]} ${indirect[2]} R is unresolved`);
    }
    return body;
  }
  return fontBody;
}

/**
 * True when a font cannot be faithfully reverse-mapped to Unicode without machinery this
 * extractor does not implement: a composite/CID font, an `Identity` CMap, a custom
 * `/Differences` encoding (in the font body OR its resolved indirect encoding object — wing
 * round-3 finding 4), or a declared `/ToUnicode` CMap. Such a page is `partial-extraction`
 * rather than corrupt text (wing round-2 finding 5). `encodingText` is {@link fontEncodingText}'s
 * result, so a `/Differences`/`Identity` living in an INDIRECT encoding object is now caught.
 */
function fontUnsupported(fontBody: string, encodingText: string): boolean {
  return (
    /\/Subtype\s*\/Type0\b/.test(fontBody) ||
    /\/Subtype\s*\/CIDFont/.test(fontBody) ||
    /\/ToUnicode\b/.test(fontBody) ||
    /\/Differences\s*\[/.test(encodingText) ||
    /\/(?:Encoding|BaseEncoding)\s*\/Identity-[HV]\b/.test(encodingText)
  );
}

/**
 * True when a simple font's effective encoding is WinAnsiEncoding (decoded via the PDF WinAnsi
 * map, finding 3) — named either directly (`/Encoding /WinAnsiEncoding`) or as the
 * `/BaseEncoding` of a resolved encoding object (wing round-3 finding 4).
 */
function isWinAnsi(encodingText: string): boolean {
  return /\/(?:Encoding|BaseEncoding)\s*\/WinAnsiEncoding\b/.test(encodingText);
}

/**
 * How a resource font's shown bytes map to Unicode:
 *   - `winansi` — decoded through the cp1252 map (0x80–0xFF are correct Unicode);
 *   - `ascii`   — StandardEncoding / MacRomanEncoding / an unresolved-or-default base
 *     encoding, whose 0x80–0xFF bytes are NOT Latin-1 and are not implemented here, so ASCII
 *     bytes are faithful but any non-ASCII byte in shown text is `partial-extraction`
 *     (round-2 finding: never emit non-ASCII bytes of an unsupported mapping as Latin-1).
 */
type FontDecode = "winansi" | "ascii";

/**
 * Resolve + validate the fonts of a page's EFFECTIVE (own-or-inherited) resource dictionary,
 * returning a resource-font NAME → {@link FontDecode} map (finding 3 + round-2 finding). Every
 * font value's indirection is resolved first (an unresolved one already threw upstream), so an
 * inherited (`/Pages`, finding 4) or INDIRECT font is inspected — not the referencing object.
 * A font needing an unsupported byte→Unicode mapping (CID/Type0/Identity/Differences/ToUnicode)
 * throws `partial-extraction`. WinAnsi fonts map via cp1252; every other simple font is
 * `ascii`-only (non-ASCII bytes rejected in {@link extractContentText}).
 */
function resolvePageFonts(resourcesText: string, map: Map<number, string>): Map<string, FontDecode> {
  const fonts = new Map<string, FontDecode>();
  for (const { name, body } of fontEntries(fontDictText(resourcesText, map), map)) {
    // Resolve an INDIRECT /Encoding object first (finding 4) so a /Differences remap it carries
    // is inspected — not mistaken for a plain base-encoding font and decoded as ASCII.
    const encoding = fontEncodingText(body, map);
    if (fontUnsupported(body, encoding)) {
      throw new PartialExtractionError(`font /${name} requires unsupported encoding/ToUnicode mapping`);
    }
    fonts.set(name, isWinAnsi(encoding) ? "winansi" : "ascii");
  }
  return fonts;
}

/** Extract + inflate (when `FlateDecode`) the decoded content-stream text of one object. */
function decodeStream(objBody: string): string {
  const start = /stream\r?\n/.exec(objBody);
  if (start === null) return "";
  const from = start.index + start[0].length;
  const endIdx = objBody.indexOf("endstream", from);
  if (endIdx === -1) throw new PartialExtractionError("stream missing endstream");
  // Trim the single EOL that precedes `endstream` (per the PDF stream syntax).
  let to = endIdx;
  if (objBody[to - 1] === "\n") to--;
  if (objBody[to - 1] === "\r") to--;
  const raw = objBody.slice(from, to);
  if (/\/Filter\s*(?:\/FlateDecode\b|\[\s*\/FlateDecode\s*\])/.test(objBody)) {
    try {
      return inflateSync(Buffer.from(raw, "latin1")).toString("latin1");
    } catch (e) {
      throw new PartialExtractionError(`FlateDecode failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  // An unsupported filter means we cannot faithfully decode — reject, never guess.
  if (/\/Filter\b/.test(objBody)) {
    throw new PartialExtractionError("unsupported content-stream filter");
  }
  return raw;
}

/** Read a PDF literal string starting at `s[i] === '('`; returns [text, indexAfter]. */
function readLiteralString(s: string, i: number): [string, number] {
  let depth = 1;
  let out = "";
  let j = i + 1;
  for (; j < s.length; j++) {
    const ch = s[j]!;
    if (ch === "\\") {
      const nx = s[j + 1];
      switch (nx) {
        case "n": out += "\n"; j++; continue;
        case "r": out += "\r"; j++; continue;
        case "t": out += "\t"; j++; continue;
        case "b": out += "\b"; j++; continue;
        case "f": out += "\f"; j++; continue;
        case "(": out += "("; j++; continue;
        case ")": out += ")"; j++; continue;
        case "\\": out += "\\"; j++; continue;
        case "\r": // line continuation (\ then EOL) — swallow the newline
          j++;
          if (s[j + 1] === "\n") j++;
          continue;
        case "\n": j++; continue;
        default:
          if (nx !== undefined && nx >= "0" && nx <= "7") {
            let oct = nx;
            let k = j + 2;
            while (k < s.length && k < j + 4 && s[k]! >= "0" && s[k]! <= "7") {
              oct += s[k];
              k++;
            }
            out += String.fromCharCode(parseInt(oct, 8) & 0xff);
            j = k - 1;
            continue;
          }
          if (nx !== undefined) out += nx;
          j++;
          continue;
      }
    }
    if (ch === "(") {
      depth++;
      out += ch;
      continue;
    }
    if (ch === ")") {
      depth--;
      if (depth === 0) return [out, j + 1];
      out += ch;
      continue;
    }
    out += ch;
  }
  // Ran off the end without a closing paren — the stream is malformed.
  throw new PartialExtractionError("unterminated string in content stream");
}

/** Decode a PDF hex string `<...>` body to text (odd trailing digit padded with 0). */
function readHexString(body: string): string {
  const hex = body.replace(/[^0-9A-Fa-f]/g, "");
  const padded = hex.length % 2 === 0 ? hex : hex + "0";
  let out = "";
  for (let i = 0; i < padded.length; i += 2) out += String.fromCharCode(parseInt(padded.slice(i, i + 2), 16));
  return out;
}

/**
 * The PDF `WinAnsiEncoding` map for the 0x80–0xFF byte range → Unicode (wing round-3 finding 5).
 * This is NOT identical to WHATWG `windows-1252` (what `TextDecoder("windows-1252")` implements),
 * so decoding WinAnsi bytes through `TextDecoder` yields WRONG characters for the divergent codes:
 *   - 0x81, 0x8D, 0x8F, 0x90, 0x9D — UNDEFINED in WinAnsiEncoding (no glyph). `TextDecoder` maps
 *     them to the C1 control characters U+0081/U+008D/U+008F/U+0090/U+009D. An undefined code has
 *     no faithful glyph, so a `null` entry ⇒ `partial-extraction` (never a guessed control char).
 *   - 0xA0 → SPACE (U+0020) and 0xAD → HYPHEN (U+002D) per PDF WinAnsiEncoding (Annex D); WHATWG
 *     `windows-1252` instead yields NO-BREAK SPACE (U+00A0) and SOFT HYPHEN (U+00AD).
 * Codes 0xA1–0xAC and 0xAE–0xFF are identical to Latin-1 (byte value == code point) and are
 * handled by the fall-through in {@link decodeWinAnsi}, so only the divergent range is tabulated.
 */
const WINANSI_HIGH: Readonly<Record<number, string | null>> = {
  0x80: "€", 0x81: null, 0x82: "‚", 0x83: "ƒ", 0x84: "„", 0x85: "…",
  0x86: "†", 0x87: "‡", 0x88: "ˆ", 0x89: "‰", 0x8a: "Š", 0x8b: "‹",
  0x8c: "Œ", 0x8d: null, 0x8e: "Ž", 0x8f: null, 0x90: null, 0x91: "‘",
  0x92: "’", 0x93: "“", 0x94: "”", 0x95: "•", 0x96: "–", 0x97: "—",
  0x98: "˜", 0x99: "™", 0x9a: "š", 0x9b: "›", 0x9c: "œ", 0x9d: null,
  0x9e: "ž", 0x9f: "Ÿ", 0xa0: " ", 0xad: "-",
};

/**
 * Decode a Latin-1-carried string (each char code == the original PDF byte) through the PDF
 * {@link WINANSI_HIGH} map, so a WinAnsi font's 0x80–0xFF bytes become the correct Unicode
 * (e.g. 0x92 → U+2019 '’', 0x80 → U+20AC '€', 0xA0 → U+0020 space). ASCII bytes (< 0x80) are
 * emitted unchanged. A byte UNDEFINED in WinAnsiEncoding (0x81/0x8D/0x8F/0x90/0x9D) has no
 * faithful glyph ⇒ `partial-extraction`, never a guessed control char (finding 3 + round-3
 * finding 5). Codes not in the table but ≥ 0xA1 map 1:1 to Latin-1 (byte == code point).
 */
function decodeWinAnsi(latin1Str: string): string {
  let out = "";
  for (let i = 0; i < latin1Str.length; i++) {
    const b = latin1Str.charCodeAt(i);
    if (b < 0x80) {
      out += latin1Str[i]!;
      continue;
    }
    if (b in WINANSI_HIGH) {
      const mapped = WINANSI_HIGH[b];
      if (mapped === null) {
        throw new PartialExtractionError(`byte 0x${b.toString(16)} is undefined in WinAnsiEncoding`);
      }
      out += mapped;
      continue;
    }
    // 0xA1–0xAC, 0xAE–0xFF: identical to Latin-1 (U+00A1–U+00FF).
    out += String.fromCharCode(b);
  }
  return out;
}

/**
 * Extract text from one decoded content stream. Deterministic left-to-right scan that
 * only emits text INSIDE a `BT`/`ET` text object (wing round-2 finding 5): string
 * operands seen outside a text object, and `%` comments anywhere, contribute NOTHING.
 * Inside a text object it accumulates string operands (literal `(...)`, hex `<...>`, and
 * those inside `[...] TJ` arrays), flushing them on a text-showing operator (`Tj`, `TJ`,
 * `'`, `"`); the line-starting operators (`Td`, `TD`, `T*`, `'`, `"`) insert a newline.
 *
 * ENCODING (finding 3 + round-2 finding): the ACTIVE font is tracked via the `/Name … Tf`
 * operator. A `Tf` selecting a font NAME absent from the page's resource dictionary
 * (`fonts`) is `partial-extraction` — text is never shown under an undefined resource font.
 * A WinAnsi font's show-operator bytes are decoded through the cp1252 map (correct Unicode,
 * not raw Latin-1); an `ascii`-only font's non-ASCII bytes are rejected rather than emitted
 * as corrupt Latin-1.
 */
function extractContentText(content: string, fonts: ReadonlyMap<string, FontDecode>): string {
  const lines: string[] = [];
  let current = "";
  let pending: string[] = [];
  let inText = false; // true only between BT … ET
  let activeFont: string | null = null; // resource-font name set by the last `Tf`
  let pendingName: string | null = null; // the most recent `/Name` token (Tf's operand)
  /** Decode the accumulated (Latin-1) operand run under the active font's encoding. */
  const decode = (latin1Str: string): string => {
    const mode: FontDecode = activeFont === null ? "ascii" : (fonts.get(activeFont) ?? "ascii");
    if (mode === "winansi") return decodeWinAnsi(latin1Str);
    // ascii-only mapping: a non-ASCII byte cannot be faithfully mapped (round-2 finding).
    for (let k = 0; k < latin1Str.length; k++) {
      if (latin1Str.charCodeAt(k) > 0x7f) {
        throw new PartialExtractionError("non-ASCII text under an unsupported (non-WinAnsi) font encoding");
      }
    }
    return latin1Str;
  };
  const flush = (): void => {
    if (!inText) {
      pending = [];
      return;
    }
    current += decode(pending.join(""));
    pending = [];
  };
  const newline = (): void => {
    if (!inText) return;
    flush();
    lines.push(current);
    current = "";
  };
  let i = 0;
  const n = content.length;
  while (i < n) {
    const ch = content[i]!;
    if (ch === "%") {
      // Comment: skip to the end of the line (never visible text).
      let j = i + 1;
      while (j < n && content[j] !== "\n" && content[j] !== "\r") j++;
      i = j;
      continue;
    }
    if (ch === "(") {
      const [str, next] = readLiteralString(content, i);
      if (inText) pending.push(str); // an operand outside a text object is not text
      i = next;
      continue;
    }
    if (ch === "<" && content[i + 1] !== "<") {
      const end = content.indexOf(">", i);
      if (end === -1) throw new PartialExtractionError("unterminated hex string");
      if (inText) pending.push(readHexString(content.slice(i + 1, end)));
      i = end + 1;
      continue;
    }
    // A name token (`/Name`) — remembered as a candidate `Tf` font operand (finding 3).
    if (ch === "/") {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9.+\-_]/.test(content[j]!)) j++;
      pendingName = content.slice(i + 1, j);
      i = j;
      continue;
    }
    // An operator/keyword token: a run of regular (non-delimiter, non-space) chars.
    if (/[A-Za-z'"*]/.test(ch)) {
      let j = i;
      while (j < n && /[A-Za-z0-9'"*]/.test(content[j]!)) j++;
      const op = content.slice(i, j);
      i = j;
      switch (op) {
        case "BT":
          inText = true;
          pending = [];
          break;
        case "ET":
          flush();
          if (current.length > 0) {
            lines.push(current);
            current = "";
          }
          inText = false;
          break;
        case "Tf":
          // Select the active font from the immediately-preceding `/Name` operand. A name not
          // present in the page's resource fonts is an undefined resource selection ⇒
          // partial-extraction (round-2 finding), never decoded text under an unknown font.
          if (pendingName !== null) {
            if (!fonts.has(pendingName)) {
              throw new PartialExtractionError(`content selects undefined resource font /${pendingName}`);
            }
            activeFont = pendingName;
          }
          pending = [];
          break;
        case "Tj":
        case "TJ":
          flush();
          break;
        case "'": // move to next line and show
        case '"':
          newline();
          break;
        case "Td":
        case "TD":
        case "T*":
          newline();
          break;
        default:
          // A non-text operator ends the current operand run without emitting it.
          pending = [];
      }
      continue;
    }
    i++;
  }
  flush();
  if (inText && current.length > 0) lines.push(current);
  return lines.join("\n");
}

/** Collapse trailing spaces per line + runs of blank lines; trim the whole text. */
function tidy(text: string): string {
  return text
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "");
}

/**
 * Normalize an `application/pdf` source to text (`pdf-page-span` locator). Detects
 * encryption (`encrypted-source`), walks the page tree, extracts text per page, and
 * joins pages with a blank line. Zero extractable text across all pages ⇒
 * `no-extractable-text`; any faithful-decode failure ⇒ `partial-extraction`.
 */
export function normalizePdf(bytes: Uint8Array): NormalizeOutcome {
  const s = latin1(bytes);
  if (isEncrypted(s)) {
    return { ok: false, rejection: { code: "encrypted-source", format: "pdf", detail: "password-protected document" } };
  }
  try {
    const objects = parseObjects(s);
    const catalog = resolveCatalog(s, objects); // throws partial-extraction if unresolvable
    const pagesRoot = /\/Pages\s+(\d+)\s+\d+\s+R/.exec(catalog);
    if (pagesRoot === null) throw new PartialExtractionError("catalog has no page tree");
    const pages = collectPages(Number(pagesRoot[1]), objects, new Set<number>(), "");
    if (pages.length === 0) throw new PartialExtractionError("no pages in page tree");

    const pageTexts: string[] = [];
    for (const { page: pageNum, resources } of pages) {
      const pageBody = objects.get(pageNum);
      if (pageBody === undefined) throw new PartialExtractionError(`missing page object ${pageNum}`);
      // Reject before decoding if the page's EFFECTIVE (own-or-inherited) fonts need
      // unsupported byte→Unicode mapping (finding 4: inherited /Pages resources count);
      // capture which resource fonts are WinAnsi so their strings decode via cp1252 (finding 3).
      const fonts = resolvePageFonts(resources, objects);
      let content = "";
      for (const ref of pageContentRefs(pageBody)) {
        const streamBody = objects.get(ref);
        if (streamBody === undefined) throw new PartialExtractionError(`missing content stream ${ref}`);
        content += decodeStream(streamBody);
        content += "\n";
      }
      pageTexts.push(tidy(extractContentText(content, fonts)));
    }

    const text = tidy(pageTexts.join("\n\n"));
    if (text.length === 0) {
      return {
        ok: false,
        rejection: { code: "no-extractable-text", format: "pdf", detail: "no text layer (scanned/image-only)" },
      };
    }
    return { ok: true, text, gaps: [] };
  } catch (e) {
    if (e instanceof PartialExtractionError) {
      return { ok: false, rejection: { code: "partial-extraction", format: "pdf", detail: e.message } };
    }
    // Any other unexpected parse failure is also a faithful-extraction failure.
    return {
      ok: false,
      rejection: { code: "partial-extraction", format: "pdf", detail: e instanceof Error ? e.message : String(e) },
    };
  }
}
