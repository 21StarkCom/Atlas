/**
 * `normalize` (v2, #334) — the normalization entry point that turns a captured
 * source file into a deterministic {@link NormalizedRendition}, driven by
 * `docs/specs/normalization-contract.md` (SSOT).
 *
 * The v1 sandbox jail + scan-before-persist guard are RETIRED (ADR-0003): the
 * per-format extractors run IN-PROCESS (they are pure functions over the raw
 * bytes — the same modules the confined worker used to run), no secret scan
 * gates the output, and a rejection is always a typed VALUE. What survives
 * unchanged is the contract's determinism core: bounded single-fd reads (no
 * stat→read TOCTOU, no FIFO/device slurp), signature-before-parse, per-format
 * ceilings, and the pinned extractor/normalizer generations — identical raw
 * bytes + identical versions ⇒ byte-identical `normalizedContentHash`.
 */
import { createHash } from "node:crypto";
import { closeSync, constants as fsConstants, fstatSync, openSync, readSync } from "node:fs";
import { extname } from "node:path";
import type { ContentId, LocatorScheme, NormalizedRendition, RepresentedGap } from "@atlas/contracts";
import { CANONICAL_MEDIA_TYPE, MAX_BYTES, signatureMatches, type SourceFormat } from "../formats.js";
import type { NormalizationRejection } from "../types.js";
import type { NormalizeOutcome } from "./media.js";
import { normalizeMarkdown } from "./markdown.js";
import { normalizeText } from "./text.js";
import { normalizePdf } from "./pdf.js";
import { normalizeHtml } from "./html.js";
import { PARSE5_VERSION } from "./pins.js";

/**
 * PINNED extractor generation. It pins the whole extraction surface — the PDF extractor
 * generation AND the `parse5` version ({@link PARSE5_VERSION}) the HTML path uses.
 * Bumping this mints a NEW rendition identity — an upgrade is never silent drift on the
 * existing `renditionId`. Matches `normalization-contract.md §1 extractorVersion`.
 */
export const EXTRACTOR_VERSION = 1 as const;

/** PINNED normalizer generation (`normalization-contract.md §1 normalizerVersion`). */
export const NORMALIZER_VERSION = 1 as const;

/**
 * The concrete library/extractor versions {@link EXTRACTOR_VERSION} pins, surfaced so an
 * upgrade is a conscious, testable change (the conformance test asserts the installed
 * `parse5` still equals this — bumping `parse5` without bumping the extractor version
 * fails CI). This makes "an upgrade is a new rendition, never silent drift" enforceable.
 */
export const EXTRACTOR_PINS = {
  parse5: PARSE5_VERSION,
  pdf: "atlas-pdf-1", // the in-repo deterministic PDF extractor generation
} as const;

/** Per-format locator scheme (`normalization-contract.md §1 locatorScheme`). */
export const LOCATOR_SCHEME: Record<SourceFormat, LocatorScheme> = {
  markdown: "char-offset",
  text: "char-offset",
  pdf: "pdf-page-span",
  html: "dom-anchor",
};

/** File extension → declared source format (`normalization-contract.md §1 extensions`). */
const EXTENSION_FORMAT: Record<string, SourceFormat> = {
  ".md": "markdown",
  ".markdown": "markdown",
  ".txt": "text",
  ".pdf": "pdf",
  ".html": "html",
  ".htm": "html",
};

/**
 * Thrown when `normalize` is handed a path whose extension names no supported format.
 * This is a usage error (exit 5), distinct from the in-contract typed rejections — the
 * contract's rejection set covers malformed CONTENT of a supported format, not an
 * unsupported file type. (Assumption: `normalize` derives the candidate format from the
 * extension; the sandbox worker then validates the content signature.)
 */
export class UnsupportedSourceError extends Error {
  readonly exitCode = 5 as const;
  constructor(path: string) {
    super(`unsupported source extension for "${path}" (supported: .md, .markdown, .txt, .pdf, .html, .htm)`);
    this.name = "UnsupportedSourceError";
  }
}

/**
 * Thrown when the source path is not a REGULAR file (a directory, FIFO, socket, or device).
 * A trusted process must not `read` an unbounded/blocking non-file handle (finding 4:
 * TOCTOU/DoS via a swapped-in FIFO/device) — it is a usage error (exit 5), like an
 * unsupported extension, not an in-contract content rejection.
 */
export class IrregularSourceError extends Error {
  readonly exitCode = 5 as const;
  constructor(path: string) {
    super(`source "${path}" is not a regular file`);
    this.name = "IrregularSourceError";
  }
}

/**
 * Open `path` ONCE and read it under the per-format ceiling without a stat→read TOCTOU
 * window (finding 4). The pre-fix `statSync(path).size` then unbounded `readFileSync(path)`
 * let a growing/swapped/FIFO/device source (a) be a different file at read time than at
 * stat time and (b) stream unbounded bytes into the trusted process. Here we open the file
 * once, `fstat` THAT descriptor (require a regular file — never a FIFO/device/dir), refuse
 * before allocating if it already exceeds the ceiling, then read at most `ceiling + 1` bytes
 * from the same fd; the `+1` overshoot catches growth AFTER the fstat. Returns the bytes, or
 * `"too-large"` when the input meets/exceeds the ceiling (the caller emits the typed rejection).
 *
 * NON-BLOCKING OPEN (round-2 finding): `open(path, "r")` on a FIFO with no writer BLOCKS
 * INDEFINITELY — before `fstat` ever runs — so a swapped-in FIFO could hang the trusted
 * process. We open `O_RDONLY | O_NONBLOCK` so the open returns immediately for a FIFO/device;
 * we then `fstat` THAT SAME descriptor and reject anything that is not a regular file. On a
 * regular file `O_NONBLOCK` has no effect on the subsequent reads, so the bounded read is
 * unchanged. `O_NOCTTY` is added defensively so opening a TTY-like device never acquires a
 * controlling terminal (it is rejected by the `isFile` check regardless).
 */
function readSourceBounded(path: string, ceiling: number): Uint8Array | "too-large" {
  // eslint-disable-next-line no-bitwise -- POSIX open flags are combined by design
  const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOCTTY);
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new IrregularSourceError(path);
    if (st.size > ceiling) return "too-large"; // refuse before allocation
    // Read up to ceiling+1: actually receiving ceiling+1 bytes means the file grew past
    // the cap after the fstat, so it is still too-large (never a truncated success).
    const buf = Buffer.allocUnsafe(ceiling + 1);
    let off = 0;
    for (;;) {
      const n = readSync(fd, buf, off, buf.length - off, null);
      if (n === 0) break;
      off += n;
      if (off > ceiling) return "too-large";
    }
    return new Uint8Array(buf.subarray(0, off));
  } finally {
    closeSync(fd);
  }
}

/** The public `normalize` input: the source path. */
export interface NormalizeInput {
  readonly path: string;
}

/**
 * The `normalize` result — a full rendition, or a typed normalization rejection (a
 * VALUE, exit 1). Nothing throws for CONTENT: an unsupported extension or an
 * irregular file are usage errors (exit 5); everything in-contract is a value.
 */
export type NormalizeResult =
  | { readonly ok: true; readonly rendition: NormalizedRendition }
  | { readonly ok: false; readonly rejection: NormalizationRejection };

/** Lowercase-hex SHA-256 of `bytes` (bare — no `sha256:` prefix). */
function rawHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** `sha256:<hex>` over `bytes` — the normalized-content digest form. */
function prefixedHash(bytes: Uint8Array): string {
  return "sha256:" + rawHash(bytes);
}

/** Derive the candidate source format from a path extension (or throw usage error). */
function formatFromPath(path: string): SourceFormat {
  const format = EXTENSION_FORMAT[extname(path).toLowerCase()];
  if (format === undefined) throw new UnsupportedSourceError(path);
  return format;
}

/** Dispatch to the pure per-format extractor (the one owner of extraction logic). */
function runExtractor(format: SourceFormat, raw: Uint8Array): NormalizeOutcome {
  switch (format) {
    case "markdown":
      return normalizeMarkdown(raw);
    case "text":
      return normalizeText(raw);
    case "pdf":
      return normalizePdf(raw);
    case "html":
      return normalizeHtml(raw);
  }
}

/**
 * Normalize the source at `input.path` into a deterministic {@link NormalizedRendition}:
 * bounded single-fd read → content-signature check (`signature-mismatch`, never a
 * guess) → the pure per-format extractor, in-process → the pinned rendition identity.
 * Kept `async` so the call sites are unchanged from the guarded v1 surface.
 */
export async function normalize(input: NormalizeInput): Promise<NormalizeResult> {
  const { path } = input;
  const format = formatFromPath(path);

  const ceiling = MAX_BYTES[format];
  const read = readSourceBounded(path, ceiling);
  if (read === "too-large") {
    return { ok: false, rejection: { code: "too-large", format, detail: `raw input exceeds ${ceiling}` } };
  }
  const raw = read;

  // Signature first, extension second (contract §1): a .pdf whose bytes are not
  // %PDF- is a typed mismatch, never a guessed parse.
  if (!signatureMatches(format, raw)) {
    return {
      ok: false,
      rejection: { code: "signature-mismatch", format, detail: "content signature does not match declared format" },
    };
  }

  const outcome = runExtractor(format, raw);
  if (!outcome.ok) return { ok: false, rejection: outcome.rejection };

  const normalizedBytes = new TextEncoder().encode(outcome.text);
  const gaps: readonly RepresentedGap[] = outcome.gaps;
  const contentId: ContentId = {
    kind: "content",
    rawContentHash: rawHash(raw),
    canonicalMediaType: CANONICAL_MEDIA_TYPE[format],
  };
  const rendition: NormalizedRendition = {
    contentId,
    extractorVersion: EXTRACTOR_VERSION,
    normalizerVersion: NORMALIZER_VERSION,
    normalizedContentHash: prefixedHash(normalizedBytes),
    sizeBytes: normalizedBytes.length,
    locatorScheme: LOCATOR_SCHEME[format],
    text: outcome.text,
    gaps,
  };
  return { ok: true, rendition };
}
