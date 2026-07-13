/**
 * `normalize` (Task 2.4) — the guard-enforced normalization entry point that turns a
 * captured source file into a deterministic {@link NormalizedRendition}, driven by
 * `docs/specs/normalization-contract.md` (SSOT).
 *
 * CONTAINMENT (wing round-2 finding 1): the untrusted parse runs INSIDE the sandbox
 * worker via {@link runInSandbox} (D15) — never in this trusted process. So a malicious
 * PDF/HTML cannot escape capability checks or resource limits: this orchestrator only
 * detects the format, scans the RAW bytes, hands the file to the confined worker, scans
 * the NORMALIZED output the worker attests, and assembles the rendition. No per-format
 * parser is ever invoked here.
 *
 * SCAN-BEFORE-PERSIST (fixes R4-F3): it REQUIRES a {@link PrePersistenceGuard} and scans
 * on BOTH sides of the parse — the RAW source bytes BEFORE the sandbox, and the
 * NORMALIZED output the sandbox releases BEFORE returning — so no raw or normalized byte
 * can ever leave unscanned. A secret hit ⇒ the guard quarantines the bytes and throws
 * {@link SecretDetectedError} (exit 3): this function therefore yields NO rendition for a
 * secret-bearing source. The raw scan catches obfuscation present in the bytes; the
 * normalized scan is load-bearing for content that only becomes a matchable secret AFTER
 * extraction (e.g. HTML entity-encoded credentials) — the sandbox scans that too (D15,
 * defence in depth) and hands the offending decoded bytes back for the guard to
 * quarantine, so the trusted guard is always the single quarantine authority.
 *
 * DETERMINISM + PINNING: the rendition carries {@link EXTRACTOR_VERSION} +
 * {@link NORMALIZER_VERSION}. Identical raw bytes + identical versions ⇒ byte-identical
 * `normalizedContentHash` (the extractors are pure). {@link EXTRACTOR_VERSION} PINS the
 * extractor generation — including the pinned `parse5` version ({@link PARSE5_VERSION})
 * the HTML path uses — so any behavioural change bumps a version and an upgrade is a NEW
 * rendition identity, never silent drift on the old one.
 */
import { createHash } from "node:crypto";
import { closeSync, constants as fsConstants, fstatSync, mkdtempSync, openSync, readSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import type { ContentId, LocatorScheme, NormalizedRendition, RepresentedGap } from "@atlas/contracts";
import { PrePersistenceGuard, SecretDetectedError } from "@atlas/scan";
import { CANONICAL_MEDIA_TYPE, MAX_BYTES, type SourceFormat } from "../formats.js";
import type { NormalizationRejection, WorkerResult } from "../types.js";
import { runInSandbox } from "../sandbox/launcher.js";
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

/** The public `normalize` input: a source path + the required scan guard. */
export interface NormalizeInput {
  readonly path: string;
  readonly guard: PrePersistenceGuard;
}

/**
 * The `normalize` result — a full rendition, or a typed normalization rejection (a
 * VALUE, exit 1). A secret hit is NOT in this union: the guard throws
 * {@link SecretDetectedError} (exit 3), so a secret-bearing source yields neither an
 * `ok: true` nor an `ok: false` result — it throws.
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

/**
 * Normalize the source at `input.path` into a deterministic {@link NormalizedRendition}.
 * Scans the RAW bytes through the required {@link PrePersistenceGuard}, parses the file
 * INSIDE the sandbox worker, then scans the sandbox's NORMALIZED output before returning.
 */
export async function normalize(input: NormalizeInput): Promise<NormalizeResult> {
  const { path, guard } = input;
  const format = formatFromPath(path);

  // Per-format raw-byte ceiling enforced via a SINGLE opened descriptor (finding 4): open
  // once, require a regular file, fstat that fd, and bounded-read at most ceiling+1 — no
  // stat→read TOCTOU window, no unbounded read of a growing/FIFO/device source.
  const ceiling = MAX_BYTES[format];
  const read = readSourceBounded(path, ceiling);
  if (read === "too-large") {
    return { ok: false, rejection: { code: "too-large", format, detail: `raw input exceeds ${ceiling}` } };
  }
  const raw = read;

  // (1) Scan the RAW bytes BEFORE the sandbox — quarantines + throws on a secret (exit 3).
  await guard.assertClean({ bytes: raw, origin: path, kind: "raw" });

  // (2) Parse INSIDE the sandbox (containment + caps + in-sandbox D15 scan) over the EXACT
  // bytes just scanned + hashed — NOT the mutable source pathname (wing round-3 finding 1).
  // If the worker re-opened `path`, a replacement between our read and its open (TOCTOU)
  // could be parsed UNSCANNED and produce text under the wrong `contentId.rawContentHash`.
  // So we stage the scanned snapshot into a freshly-named private temp file no other party
  // can race, and point the confined worker at THAT immutable handle. The worker's signature
  // check + normalization then run on the same bytes the guard cleared and the contentId
  // commits to. The staged file is the worker's sole read handle (granted as the input
  // literal), removed in the finally even after a forced termination.
  const stageDir = mkdtempSync(join(tmpdir(), "atlas-stage-"));
  const stagedPath = join(stageDir, "source");
  let result: WorkerResult;
  try {
    writeFileSync(stagedPath, raw);
    result = await runInSandbox({ inputPath: stagedPath, format });
  } finally {
    rmSync(stageDir, { recursive: true, force: true });
  }

  if (!result.ok && result.kind === "normalization-rejection") {
    // (3a) A typed, in-contract rejection is a VALUE (exit 1) — never a throw.
    return { ok: false, rejection: result.rejection };
  }

  if (!result.ok) {
    // (3b) The in-sandbox scan flagged a secret in the NORMALIZED output. A valid, NON-EMPTY
    // quarantine artifact is MANDATORY on every scan rejection (finding 7): a secret-bearing
    // source MUST land in quarantine, never merely reject.
    //   - Payload PRESENT (the common case): route the offending decoded bytes through the
    //     guard so the trusted-side quarantine captures the exact content and raises the
    //     exit-3 refusal. The worker ships these for a real hit — the whole output when it
    //     fits the channel, else a bounded window around the match (wing round-3 finding 5).
    //   - Payload ABSENT or EMPTY (previously threw WITHOUT quarantining anything): fall back
    //     to quarantining the trusted RAW snapshot. `assertClean` is NOT reused for this — the
    //     raw bytes can be individually clean (a secret that only becomes matchable AFTER
    //     normalization), so a re-scan would wave them through; `quarantineRejection` captures
    //     them unconditionally (the sandbox verdict is the authority) and throws exit-3.
    if (result.quarantineBytes !== undefined && result.quarantineBytes.length > 0) {
      await guard.assertClean({ bytes: result.quarantineBytes, origin: path, kind: "normalized" });
      // `assertClean` throws on the (guaranteed dirty) payload; a defensively-clean payload
      // still requires a mandatory artifact, so fall through to quarantine the raw snapshot.
    }
    // Mandatory non-empty artifact: quarantine the trusted raw snapshot, THEN refuse exit-3.
    await guard.quarantineRejection({ bytes: raw, origin: path });
    throw new SecretDetectedError(path, [], "pre-persistence");
  }

  // (4) Consume the attested clean stream, then scan the NORMALIZED output BEFORE
  // returning (the required normalized-output guard; a clean stream passes, and this is
  // the trusted authority for any residual match).
  const normalizedBytes = new Uint8Array(await new Response(result.stream).arrayBuffer());
  await guard.assertClean({ bytes: normalizedBytes, origin: path, kind: "normalized" });

  // (5) Assemble the pinned rendition identity. Gaps come from the sandbox result
  // (validated deterministic metadata; wing round-2 finding 2).
  const gaps: readonly RepresentedGap[] = result.gaps;
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
    text: new TextDecoder().decode(normalizedBytes),
    gaps,
  };
  return { ok: true, rendition };
}
