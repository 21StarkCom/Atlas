/**
 * The sandboxed parser worker (Task 2.3, D15). It runs as a dedicated low-privilege
 * process INSIDE the host jail (Seatbelt / bwrap+seccomp) with an empty environment,
 * no network, no subprocess, and a filesystem view of exactly its read-only input
 * handle + a disposable worker-private temp.
 *
 * Flow (nothing normalized ever touches disk — the scan-before-persist invariant):
 *   1. read the raw source bytes from the read-only input handle;
 *   2. enforce the per-format raw-byte ceiling (`too-large`);
 *   3. validate the content SIGNATURE against the declared format (`signature-mismatch`);
 *   4. normalize to text IN MEMORY (Task 2.4 replaces this seam with the full
 *      per-format normalizers; Task 2.3 ships the text/markdown path that proves the
 *      end-to-end mechanism, and a typed rejection for the formats it does not yet
 *      extract);
 *   5. run the secret scanner (`@atlas/scan`, imported here so it executes INSIDE the
 *      sandbox) over the normalized output;
 *   6. on a hit → emit a `scan-rejection` control message and NO bytes (the source is
 *      quarantined CLI-side by the caller, which still holds the raw bytes); on clean →
 *      compute the SHA-256 over the exact bytes it is about to release, write them to
 *      the output pipe (fd 1), and emit a digest-bound `clean` attestation on fd 3.
 *
 * The worker is intentionally dependency-light: its runtime closure is `@atlas/scan`
 * (pure) + Node builtins, so the jail's read-allowlist stays small.
 */
import { createHash } from "node:crypto";
import { openSync, readSync, closeSync, fstatSync, writeSync } from "node:fs";
import type { RepresentedGap } from "@atlas/contracts";
import { scanBytes, type SecretFinding } from "@atlas/scan";
import { MAX_BYTES, signatureMatches, type SourceFormat } from "../formats.js";
import type { NormalizationRejection } from "../types.js";
import { normalizeMarkdown } from "../normalize/markdown.js";
import { normalizeText } from "../normalize/text.js";
import { normalizePdf } from "../normalize/pdf.js";
import { normalizeHtml } from "../normalize/html.js";
import type { NormalizeOutcome } from "../normalize/media.js";
import { CONTROL_FD, MAX_QUARANTINE_CONTROL_BYTES, OUTPUT_FD, type WorkerControl, type WorkerRequest } from "../sandbox/protocol.js";

/** Write an entire buffer to `fd`, looping over partial writes (pipes can short-write). */
function writeAll(fd: number, data: Uint8Array): void {
  let off = 0;
  while (off < data.length) {
    off += writeSync(fd, data, off, data.length - off);
  }
}

/** Emit the single control message on the result pipe. */
function emitControl(control: WorkerControl): void {
  writeAll(CONTROL_FD, new TextEncoder().encode(JSON.stringify(control)));
}

/** The in-worker normalization result: normalized bytes + gaps, or a typed rejection value. */
type WorkerNormalize =
  | { ok: true; bytes: Uint8Array; gaps: readonly RepresentedGap[] }
  | { ok: false; rejection: NormalizationRejection };

/**
 * In-worker normalization — Task 2.4's per-format normalizers wired into the sandbox
 * seam. Runs the SAME pure `normalize/{markdown,text,pdf,html}` extractors the
 * trusted-side `normalize()` uses (one owner of extraction logic), so the confined
 * parse path and the guard-enforced entry point produce byte-identical output for the
 * same bytes. A per-format normalizer returns a typed rejection VALUE (never truncated
 * text as success); the worker forwards it as a `normalization-rejection`. The
 * normalized text is re-encoded UTF-8 for the in-sandbox scan + attested stream.
 */
function normalizeInWorker(format: SourceFormat, raw: Uint8Array): WorkerNormalize {
  let outcome: NormalizeOutcome;
  switch (format) {
    case "markdown":
      outcome = normalizeMarkdown(raw);
      break;
    case "text":
      outcome = normalizeText(raw);
      break;
    case "pdf":
      outcome = normalizePdf(raw);
      break;
    case "html":
      outcome = normalizeHtml(raw);
      break;
  }
  if (!outcome.ok) return { ok: false, rejection: outcome.rejection };
  return { ok: true, bytes: new TextEncoder().encode(outcome.text), gaps: outcome.gaps };
}

/**
 * Read the input handle with a PRE-ALLOCATION size guard (wing round-3 finding 7): a
 * source above the per-format ceiling must be rejected `too-large` WITHOUT slurping it
 * into memory first (an oversized input could otherwise exhaust the worker or trip a
 * cap-kill instead of returning the required typed rejection). We `fstat` the opened
 * handle and refuse before allocating; then read at most `ceiling + 1` bytes (a growth
 * between stat and read — TOCTOU — is still caught by the `+1` overshoot). Returns the
 * bytes, or `null` when the input is too large (the caller emits the rejection).
 */
function readInputBounded(inputPath: string, ceiling: number): Uint8Array | null {
  const fd = openSync(inputPath, "r");
  try {
    if (fstatSync(fd).size > ceiling) return null; // refuse before allocation
    // Read up to ceiling+1: if we actually get ceiling+1 bytes the file grew past the
    // cap after the stat, so it is still too-large.
    const buf = Buffer.allocUnsafe(ceiling + 1);
    let off = 0;
    for (;;) {
      const n = readSync(fd, buf, off, buf.length - off, null);
      if (n === 0) break;
      off += n;
      if (off > ceiling) return null; // overshot the cap (grew since stat)
    }
    return new Uint8Array(buf.subarray(0, off));
  } finally {
    closeSync(fd);
  }
}

/** `sha256:<hex>` over `bytes`. */
function sha256Hex(bytes: Uint8Array): string {
  return "sha256:" + createHash("sha256").update(bytes).digest("hex");
}

/** Char-context padded around a matched span so line-anchored rules still re-match trusted-side. */
const QUARANTINE_WINDOW_PAD = 4096;

/**
 * Build the offending-bytes payload the trusted-side guard re-scans + quarantines on a
 * secret hit (wing round-3 finding 5). Small outputs ship WHOLE (full context, matches the
 * prior behaviour + keeps the quarantined bytes complete). An output larger than the
 * control-channel bound no longer omits the payload — which left `normalize` throwing WITHOUT
 * quarantining anything. Instead we ship a BOUNDED WINDOW around the first finding: the
 * matched span (char offsets into the UTF-8 decode) plus generous context, re-encoded to
 * UTF-8. The window is verified to still re-scan DIRTY so the trusted guard is guaranteed to
 * re-detect + quarantine it. Returns `null` only if no dirty window can be built (unreachable
 * for a real finding — the ±pad window strictly contains the matched token).
 */
function buildQuarantineSample(bytes: Uint8Array, findings: readonly SecretFinding[]): Uint8Array | null {
  // The whole dirty output fits the channel bound → ship it all (complete quarantine bytes).
  if (bytes.length <= MAX_QUARANTINE_CONTROL_BYTES) return bytes;
  const first = findings[0];
  if (first === undefined) return null; // a dirty verdict always has ≥1 finding
  // Offsets are char offsets into the UTF-8-decoded text (same decode the scanner used).
  const text = new TextDecoder().decode(bytes);
  const lo = Math.max(0, first.startOffset - QUARANTINE_WINDOW_PAD);
  const hi = Math.min(text.length, first.endOffset + QUARANTINE_WINDOW_PAD);
  let out = new TextEncoder().encode(text.slice(lo, hi));
  // A pathologically large single span could still exceed the bound; fall back to the bare
  // matched token (still re-scans dirty for value-shaped / entropy rules).
  if (out.length > MAX_QUARANTINE_CONTROL_BYTES) {
    out = new TextEncoder().encode(text.slice(first.startOffset, first.endOffset));
    if (out.length > MAX_QUARANTINE_CONTROL_BYTES) return null;
  }
  // Verify the bounded window still flags — never ship a sample the guard would wave through.
  const recheck = scanBytes({ bytes: out, context: { origin: "quarantine-window", boundary: "pre-persistence", kind: "normalized" } });
  return recheck.clean ? null : out;
}

function main(): void {
  const raw = process.argv[2];
  if (raw === undefined) {
    emitControl({ kind: "worker-error", message: "missing request argument" });
    process.exit(4);
  }
  let req: WorkerRequest;
  try {
    req = JSON.parse(raw) as WorkerRequest;
  } catch (e) {
    emitControl({ kind: "worker-error", message: `bad request json: ${e instanceof Error ? e.message : String(e)}` });
    process.exit(4);
  }

  try {
    // (2) raw-byte ceiling — BEFORE allocating (stat/bounded-read, never slurp an
    // oversized input into memory; finding 7).
    const ceiling = MAX_BYTES[req.format];
    const bytes = readInputBounded(req.inputPath, ceiling);
    if (bytes === null) {
      emitControl({ kind: "normalization-rejection", rejection: { code: "too-large", format: req.format, detail: `raw input exceeds ${ceiling}` } });
      return;
    }
    // (3) signature validation before parse.
    if (!signatureMatches(req.format, bytes)) {
      emitControl({ kind: "normalization-rejection", rejection: { code: "signature-mismatch", format: req.format, detail: "content signature does not match declared format" } });
      return;
    }
    // (4) normalize in memory.
    const norm = normalizeInWorker(req.format, bytes);
    if (!norm.ok) {
      emitControl({ kind: "normalization-rejection", rejection: norm.rejection });
      return;
    }
    // (5) scan the normalized output INSIDE the sandbox.
    const verdict = scanBytes({ bytes: norm.bytes, context: { origin: req.inputPath, boundary: "pre-persistence", kind: "normalized" } });
    if (!verdict.clean) {
      // (6a) secret detected: emit NO bytes on fd 1 (scan-before-persist), a distinct
      // exit-3 scan rejection on fd 3. The offending NORMALIZED bytes ride the control
      // message (base64, bounded) so the trusted-side guard QUARANTINES the exact decoded
      // content. An output larger than the channel bound ships a bounded WINDOW around the
      // match (finding 5) rather than omitting the payload — so quarantine still happens.
      const sample = buildQuarantineSample(norm.bytes, verdict.findings);
      const control: WorkerControl =
        sample !== null
          ? { kind: "scan-rejection", code: "secret-detected", scannerRulesetVersion: verdict.rulesetVersion, quarantineB64: Buffer.from(sample).toString("base64") }
          : { kind: "scan-rejection", code: "secret-detected", scannerRulesetVersion: verdict.rulesetVersion };
      emitControl(control);
      return;
    }
    // (6b) clean: release the bytes + a digest-bound attestation.
    if (norm.bytes.length > req.maxOutputBytes) {
      // Defense-in-depth: a normalized output over the cap is a rejection, never a
      // truncated success (the launcher also caps fd1 read + force-kills).
      emitControl({ kind: "normalization-rejection", rejection: { code: "too-large", format: req.format, detail: "normalized output exceeds output cap" } });
      return;
    }
    const outputDigest = sha256Hex(norm.bytes);
    writeAll(OUTPUT_FD, norm.bytes);
    emitControl({
      kind: "clean",
      attestation: { scannerRulesetVersion: verdict.rulesetVersion, scannedBytes: norm.bytes.length, clean: true, outputDigest },
      gaps: norm.gaps,
    });
  } catch (e) {
    emitControl({ kind: "worker-error", message: e instanceof Error ? e.message : String(e) });
    process.exit(4);
  }
}

main();
