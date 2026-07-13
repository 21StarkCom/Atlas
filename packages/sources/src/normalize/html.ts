/**
 * The HTML normalizer (`text/html`) — a deterministic STATIC-DOM text extractor built on
 * a standards-conformant, INERT HTML parser (`normalization-contract.md`; `dom-anchor`
 * locator).
 *
 * PARSER (wing round-2 finding 4): the extraction is driven by **parse5** — the WHATWG
 * tree-construction implementation `jsdom` is built on. It is used purely as a parser: it
 * builds the static DOM tree from bytes and NEVER executes anything (no scripting, no
 * `on*` handlers, no `javascript:` navigation), so the tree is exactly the inert document
 * structure. Replacing the prior hand-written tokenizer removes its faithfulness bugs
 * (small entity subset, mishandled uppercase-hex references, tags terminated at a quoted
 * `>`, no tree construction) — parse5 implements the full named/numeric entity set,
 * quote-aware attribute tokenization, RCDATA/raw-text states, and implicit tag closing.
 *
 * STATIC DOM (security-load-bearing): `<script>`, `<style>`, and `<template>` subtrees are
 * DROPPED and never contribute output — the normalized text is exactly the inert document
 * text plus image `alt` handling (per `./media.ts`).
 *
 * PINNING: {@link PARSE5_VERSION} records the pinned parse5 generation; it composes into
 * `extractorVersion` (in `./index.ts`) so a parse5 upgrade that changes extraction
 * behaviour mints a NEW rendition identity, never silent drift on the old one.
 *
 * ENCODING: the accepted encodings are the contract's HTML set (utf-8, utf-8-bom,
 * iso-8859-1, windows-1252). A UTF-16/UTF-32 BOM or a declared charset outside that set is
 * `unsupported-encoding` (never a lossy guess). Bytes are decoded to a string HERE (parse5
 * consumes a string); entity decoding + tree construction are parse5's.
 */
import { parse } from "parse5";
import type { DefaultTreeAdapterMap } from "parse5";
import type { RepresentedGap } from "@atlas/contracts";
import { classifyMedia } from "./media.js";
import type { NormalizeOutcome } from "./media.js";
import { PARSE5_VERSION } from "./pins.js";

/** Re-exported for local convenience; the canonical pin lives in {@link ./pins.js}. */
export { PARSE5_VERSION };

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
type ChildNode = DefaultTreeAdapterMap["childNode"];

/** Block-level elements whose boundaries introduce a newline in the extracted text. */
const BLOCK_ELEMENTS = new Set([
  "address", "article", "aside", "blockquote", "br", "dd", "div", "dl", "dt", "fieldset", "figcaption", "figure",
  "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li", "main", "nav", "ol", "p", "pre",
  "section", "table", "tbody", "td", "th", "thead", "tr", "ul",
]);

/** Elements whose entire subtree is dropped (inert — static DOM). */
const DROP_ELEMENTS = new Set(["script", "style", "template", "noscript"]);

/** Accepted HTML charset labels → the `TextDecoder` label used to decode them. */
const HTML_CHARSETS: Record<string, string> = {
  "utf-8": "utf-8", "utf8": "utf-8", "us-ascii": "utf-8", "ascii": "utf-8",
  "iso-8859-1": "latin1", "latin1": "latin1", "l1": "latin1",
  "windows-1252": "windows-1252", "cp1252": "windows-1252", "x-cp1252": "windows-1252",
};

type EncodingPick = { readonly ok: true; readonly text: string } | { readonly ok: false };

/**
 * Decode the raw bytes to a string under the contract's accepted HTML encoding set. A
 * UTF-8 BOM selects UTF-8 (fatal); a UTF-16/UTF-32 BOM is NOT an accepted HTML encoding
 * (`unsupported-encoding`). Otherwise a declared `<meta charset>` (or `Content-Type`
 * charset) is honoured when in the accepted set and rejected when not; absent a
 * declaration the default is UTF-8 (fatal — invalid UTF-8 ⇒ `unsupported-encoding`).
 */
function decodeHtml(bytes: Uint8Array): EncodingPick {
  // Disallowed BOMs first (UTF-16 LE/BE) — not in the HTML accepted set.
  if (bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))) {
    return { ok: false };
  }
  // UTF-8 BOM → strip + decode UTF-8 (fatal).
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return decodeWith("utf-8", bytes.subarray(3));
  }
  const head = Buffer.from(bytes.subarray(0, 4096)).toString("latin1").toLowerCase();
  const declared = metaCharset(head);
  if (declared !== null) {
    const label = HTML_CHARSETS[declared];
    if (label === undefined) return { ok: false }; // declared charset outside the accepted set
    return decodeWith(label, bytes);
  }
  return decodeWith("utf-8", bytes);
}

/**
 * Elements whose content is RAW-TEXT / RCDATA — parsed as text, not markup — so a
 * `<meta …>` written INSIDE them is inert and must NOT be read as a charset declaration
 * (wing round-3 finding 1). The lexical scan skips their content to the matching end tag,
 * exactly as the real tokenizer (and `DROP_ELEMENTS`) would treat it.
 */
const RAWTEXT_ELEMENTS = new Set(["script", "style", "title", "textarea", "noscript", "noframes", "iframe", "xmp", "plaintext"]);

/** ASCII letter — the only lead a genuine HTML tag name may start with. */
function isAsciiAlpha(ch: string | undefined): boolean {
  return ch !== undefined && ((ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z"));
}

/** A tag-name terminator per the HTML tokenizer (whitespace, `/`, or `>`). */
function isTagNameEnd(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === "/" || ch === ">";
}

/**
 * Scan a start/end tag quote-aware from `nameEnd` (the index just past the tag name) to the
 * tag's closing `>`. A `>` INSIDE a single- or double-quoted attribute value does NOT end the
 * tag (matching the tokenizer's attribute-value states), so `<meta content="a>b" charset=…>`
 * is one tag, not two. Returns the full tag text (`<` … up to but not including `>`) and the
 * index just AFTER the closing `>` (or end-of-input for an unterminated tag).
 */
function readTag(head: string, start: number, nameEnd: number): { readonly tag: string; readonly after: number } {
  let i = nameEnd;
  let quote: string | null = null;
  for (; i < head.length; i++) {
    const ch = head[i]!;
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === ">") return { tag: head.slice(start, i), after: i + 1 };
  }
  return { tag: head.slice(start, i), after: i };
}

/** The charset a genuine `<meta>` tag declares, or `null` (HTML5 `charset` or legacy pair). */
function charsetFromMetaTag(tag: string): string | null {
  const attrs = parseTagAttrs(tag);
  // HTML5 `<meta charset="…">` — the charset attribute is authoritative.
  const direct = attrs.get("charset");
  if (direct !== undefined && direct !== "") return direct;
  // Legacy `<meta http-equiv="Content-Type" content="text/html; charset=…">` — a `content`
  // charset counts ONLY when http-equiv names content-type (otherwise `content` is prose).
  if (attrs.get("http-equiv") === "content-type") {
    const content = attrs.get("content");
    if (content !== undefined) {
      const m = /\bcharset\s*=\s*([a-z0-9._-]+)/.exec(content);
      if (m !== null) return m[1]!;
    }
  }
  return null;
}

/**
 * Extract a declared charset ONLY from a real HTML `<meta>` START TAG, via an HTML-tokenizer-
 * style LEXICAL SCAN (wing round-3 finding 1). The pre-fix code stripped comment/raw-text
 * regions with regexes (which miss UNCLOSED comment/script/style regions) and then matched
 * `<meta\b` globally — so `<meta-widget charset="koi8-r">` (a custom element whose name merely
 * STARTS with "meta"), a fake `<meta …>` inside a quoted attribute value of another tag, or a
 * `<meta>` inside RCDATA / an unclosed comment were all wrongly read as declarations. Here we
 * walk `head` as tokens: skip comments (including unterminated → to end), skip other markup
 * declarations / processing instructions, skip RAW-TEXT element content to its end tag, and
 * recognise a meta declaration ONLY when a start tag's NAME is exactly `meta` (the char after
 * the name is a tokenizer tag-name terminator, so `meta-widget`/`metadata` do not match).
 * Every tag is consumed quote-aware, so a fake `<meta>` nested in a quoted attribute value is
 * part of that value, never a tag. Returns the lower-cased label, or `null` when none declares.
 */
function metaCharset(head: string): string | null {
  const n = head.length;
  let i = 0;
  while (i < n) {
    const lt = head.indexOf("<", i);
    if (lt === -1) break;
    i = lt;
    // Comment: skip to `-->`; an UNTERMINATED comment consumes to end-of-input (so a `<meta>`
    // inside it is never seen), exactly as the tokenizer's comment states would.
    if (head.startsWith("<!--", i)) {
      const end = head.indexOf("-->", i + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    // Other markup declaration (`<!doctype`, CDATA) or processing instruction — skip to `>`.
    if (head[i + 1] === "!" || head[i + 1] === "?") {
      const gt = head.indexOf(">", i + 1);
      i = gt === -1 ? n : gt + 1;
      continue;
    }
    const isEnd = head[i + 1] === "/";
    const nameStart = i + (isEnd ? 2 : 1);
    if (!isAsciiAlpha(head[nameStart])) {
      i = i + 1; // a `<` not opening a tag is data — advance one and keep scanning
      continue;
    }
    let j = nameStart;
    while (j < n && !isTagNameEnd(head[j]!)) j++;
    const name = head.slice(nameStart, j); // `head` is already lower-cased by the caller
    const { tag, after } = readTag(head, i, j);
    if (!isEnd && name === "meta") {
      const label = charsetFromMetaTag(tag);
      if (label !== null) return label;
    }
    if (!isEnd && RAWTEXT_ELEMENTS.has(name)) {
      // The element's content is text, not markup: skip to its matching end tag (or end of
      // input) so a `<meta>` written inside it is never read as a declaration. The end tag
      // must be the EXACT element name followed by a tag-name terminator — a prefix match
      // (`</scripture>` for `<script>`) must NOT close it and expose following markup.
      const needle = "</" + name;
      let close = -1;
      for (let k = head.indexOf(needle, after); k !== -1; k = head.indexOf(needle, k + 1)) {
        const nextCh = head[k + needle.length];
        if (nextCh === undefined || isTagNameEnd(nextCh)) {
          close = k;
          break;
        }
      }
      i = close === -1 ? n : close; // the end tag itself is consumed on the next iteration
      continue;
    }
    i = after;
  }
  return null;
}

/**
 * Parse the attributes of a single tag's text into a lower-cased `name → value` map. Values
 * may be double-quoted, single-quoted, or unquoted; a bare attribute maps to `""`. Quote-aware
 * so a `>` or `=` inside a quoted value is part of the value, not a delimiter.
 */
function parseTagAttrs(tag: string): Map<string, string> {
  const attrs = new Map<string, string>();
  // Skip the `<meta` (or other) element name token.
  let i = 0;
  while (i < tag.length && tag[i] !== " " && tag[i] !== "\t" && tag[i] !== "\n" && tag[i] !== "\r" && tag[i] !== "\f") i++;
  while (i < tag.length) {
    while (i < tag.length && /[\s/]/.test(tag[i]!)) i++; // skip whitespace + self-closing slash
    if (i >= tag.length) break;
    let n = i;
    while (n < tag.length && !/[\s/=]/.test(tag[n]!)) n++; // attribute name
    const name = tag.slice(i, n).toLowerCase();
    i = n;
    while (i < tag.length && /\s/.test(tag[i]!)) i++;
    if (tag[i] !== "=") {
      if (name !== "") attrs.set(name, ""); // bare attribute
      continue;
    }
    i++; // consume '='
    while (i < tag.length && /\s/.test(tag[i]!)) i++;
    let value = "";
    const q = tag[i];
    if (q === '"' || q === "'") {
      const end = tag.indexOf(q, i + 1);
      value = end === -1 ? tag.slice(i + 1) : tag.slice(i + 1, end);
      i = end === -1 ? tag.length : end + 1;
    } else {
      let v = i;
      while (v < tag.length && !/\s/.test(tag[v]!)) v++;
      value = tag.slice(i, v);
      i = v;
    }
    if (name !== "") attrs.set(name, value.trim().toLowerCase());
  }
  return attrs;
}

/** Decode `bytes` with `label`; UTF-8 is FATAL (invalid ⇒ failure), single-byte sets never fail. */
function decodeWith(label: string, bytes: Uint8Array): EncodingPick {
  try {
    const fatal = label === "utf-8";
    return { ok: true, text: new TextDecoder(label, { fatal }).decode(bytes) };
  } catch {
    return { ok: false };
  }
}

function isElement(n: Node): n is Element {
  return "tagName" in n && typeof (n as { tagName?: unknown }).tagName === "string";
}

/**
 * A token the {@link TextSink} accumulates before assembling the final text. Separating
 * "collapsible inline text" from "verbatim" and from the two whitespace signals
 * (inline `space` vs block `break`) lets `finish` (a) keep separators BETWEEN inline
 * siblings — a whitespace-only `#text` node between `<span>`s is a real word boundary,
 * not noise (wing round-3 finding 2) — and (b) preserve image alt text EXACTLY, never
 * collapsing its internal/edge whitespace (wing round-3 finding 3).
 */
type TextToken =
  | { readonly kind: "text"; readonly value: string } // collapsible inline text (runs already → single space)
  | { readonly kind: "verbatim"; readonly value: string } // preserved exactly (image alt)
  | { readonly kind: "space" } // inline separator (a whitespace-only #text node / node-edge whitespace)
  | { readonly kind: "break" }; // block boundary → newline

/** Emitter accumulating extracted text with inline separators + block-boundary newlines. */
class TextSink {
  private readonly tokens: TextToken[] = [];

  /** Mark a block boundary (a stronger separator than an inline space). */
  break(): void {
    this.tokens.push({ kind: "break" });
  }

  /**
   * Push a `#text` node. parse5 has already decoded entities; intra-node whitespace RUNS
   * collapse to a single space. A whitespace-only node is NOT dropped — it emits an inline
   * `space` separator so `<span>a</span> <span>b</span>` keeps the word boundary. A node's
   * own leading/trailing whitespace likewise emits edge `space` separators.
   */
  push(raw: string): void {
    const text = raw.replace(/\s+/g, " ");
    if (text === "") return; // genuinely empty node
    if (text.trim() === "") {
      this.tokens.push({ kind: "space" }); // whitespace-only node → inline separator
      return;
    }
    if (text.startsWith(" ")) this.tokens.push({ kind: "space" });
    this.tokens.push({ kind: "text", value: text.trim() });
    if (text.endsWith(" ")) this.tokens.push({ kind: "space" });
  }

  /** Push text that must survive EXACTLY as given (image alt) — never whitespace-collapsed. */
  pushVerbatim(value: string): void {
    if (value === "") return;
    this.tokens.push({ kind: "verbatim", value });
  }

  /**
   * Assemble the tokens: a `break` overrides a pending inline `space` and collapses runs of
   * breaks to one newline; a surviving inline `space` between two content tokens becomes a
   * single space; leading/trailing spaces + breaks are dropped. `text`/`verbatim` values are
   * emitted as-is (verbatim whitespace intact), so the collapsing happens ONLY between
   * tokens, never inside a verbatim value.
   */
  finish(): string {
    const out: string[] = [];
    let emittedContent = false;
    let pendingBreak = false;
    let pendingSpace = false;
    for (const tok of this.tokens) {
      if (tok.kind === "break") {
        pendingBreak = true;
        pendingSpace = false; // a block boundary supersedes an inline space
        continue;
      }
      if (tok.kind === "space") {
        if (emittedContent && !pendingBreak) pendingSpace = true;
        continue;
      }
      // content token (text | verbatim)
      if (emittedContent) {
        if (pendingBreak) out.push("\n");
        else if (pendingSpace) out.push(" ");
      }
      out.push(tok.value);
      emittedContent = true;
      pendingBreak = false;
      pendingSpace = false;
    }
    return out.join("");
  }
}

/** True for a parse5 text node (`#text`). */
function isText(n: ChildNode): n is DefaultTreeAdapterMap["textNode"] {
  return n.nodeName === "#text";
}

/** The `template` element's inert content lives on a separate fragment node. */
function templateContent(el: Element): Node | null {
  const content = (el as { content?: DefaultTreeAdapterMap["documentFragment"] }).content;
  return content ?? null;
}

/** Read an element attribute value (attrs is a name/value array in the default adapter). */
function attr(el: Element, name: string): string | null {
  for (const a of el.attrs) {
    if (a.name === name) return a.value;
  }
  return null;
}

/**
 * Walk the static DOM depth-first, emitting text nodes with block-boundary newlines and
 * applying the media alt rules to `<img>`. The `dom-anchor` locator is the 1-based
 * element path (`/html[1]/body[1]/img[1]`), computed from same-tag element siblings — a
 * deterministic, exact anchor independent of hash-map iteration order.
 */
function walk(node: Node, path: string, sink: TextSink, gaps: RepresentedGap[]): void {
  const children = "childNodes" in node ? node.childNodes : [];
  // Per-parent same-tag index for the DOM anchor (deterministic; source order).
  const counts = new Map<string, number>();
  for (const child of children) {
    if (isText(child)) {
      sink.push(child.value);
      continue;
    }
    if (!isElement(child)) continue; // comments / doctype carry no represented text
    const tag = child.tagName;
    const idx = (counts.get(tag) ?? 0) + 1;
    counts.set(tag, idx);
    const childPath = `${path}/${tag}[${idx}]`;

    if (DROP_ELEMENTS.has(tag)) continue; // inert — drop the entire subtree

    if (tag === "img") {
      const rawAlt = attr(child, "alt");
      const disposition = classifyMedia({ alt: rawAlt, locator: `dom:${childPath}` });
      // Meaningful alt is preserved VERBATIM (finding 3): route it through the verbatim
      // sink so its internal/edge whitespace is never collapsed by the inline text path.
      if (disposition.kind === "text") sink.pushVerbatim(disposition.text);
      else gaps.push(disposition.gap);
      continue; // void
    }

    const block = BLOCK_ELEMENTS.has(tag);
    if (block) sink.break();
    // `<template>` content is parsed into a detached fragment — walk it inert.
    const tmpl = tag === "template" ? null : templateContent(child);
    walk(tmpl ?? child, childPath, sink, gaps);
    if (block) sink.break();
  }
}

/**
 * Normalize a `text/html` source to inert static-DOM text (`dom-anchor` locator) via
 * parse5. Emits text nodes with inline separators + block-boundary newlines, applies the
 * `<img>` alt rules (meaningful alt → verbatim text, exact `alt=""` → decorative gap, no
 * alt → `image-no-alt` gap), and drops `<script>`/`<style>`/`<template>`/`<noscript>`
 * subtrees. Empty document text with no gaps ⇒ `no-extractable-text`.
 */
export function normalizeHtml(bytes: Uint8Array): NormalizeOutcome {
  const decoded = decodeHtml(bytes);
  if (!decoded.ok) {
    return {
      ok: false,
      rejection: { code: "unsupported-encoding", format: "html", detail: "charset not in the accepted HTML set" },
    };
  }

  const document = parse(decoded.text);
  const sink = new TextSink();
  const gaps: RepresentedGap[] = [];
  // The document's element children are `<html>` etc.; anchors are rooted at "" so the
  // first level renders `/html[1]`.
  walk(document, "", sink, gaps);
  const text = sink.finish();

  if (text.length === 0 && gaps.length === 0) {
    return { ok: false, rejection: { code: "no-extractable-text", format: "html", detail: "no document text" } };
  }
  return { ok: true, text, gaps };
}
