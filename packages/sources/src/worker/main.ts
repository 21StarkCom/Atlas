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
import { scanBytes } from "@atlas/scan";
import { MAX_BYTES, signatureMatches, decodeTextStrict, type SourceFormat } from "../formats.js";
import type { NormalizationRejection } from "../types.js";
import { CONTROL_FD, OUTPUT_FD, type WorkerControl, type WorkerRequest } from "../sandbox/protocol.js";

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

/** The in-worker normalization result: normalized bytes, or a typed rejection value. */
type WorkerNormalize = { ok: true; bytes: Uint8Array } | { ok: false; rejection: NormalizationRejection };

/**
 * Minimal in-worker normalization (the Task 2.4 seam). Text + Markdown are decoded
 * FATALLY under an accepted encoding (UTF-8/UTF-16) — a malformed or unsupported byte
 * sequence yields a typed `unsupported-encoding` rejection rather than a lossy
 * `U+FFFD`-riddled "clean" rendition (wing round-3 finding 8). PDF/HTML return a typed
 * rejection until Task 2.4 lands the per-format extractors (documented assumption —
 * Task 2.3's deliverable is the sandbox + scan-before-persist mechanism, proven
 * end-to-end on the text/markdown path).
 */
function normalizeInWorker(format: SourceFormat, raw: Uint8Array): WorkerNormalize {
  switch (format) {
    case "markdown":
    case "text": {
      const dec = decodeTextStrict(raw);
      if (!dec.ok) {
        return {
          ok: false,
          rejection: { code: "unsupported-encoding", format, detail: "input is not valid UTF-8 / UTF-16 text" },
        };
      }
      return { ok: true, bytes: new TextEncoder().encode(dec.text) };
    }
    case "pdf":
    case "html":
      return {
        ok: false,
        rejection: { code: "no-extractable-text", format, detail: "per-format normalizer arrives in Task 2.4" },
      };
  }
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
      // (6a) secret detected: emit NO bytes, distinct exit-3 scan rejection.
      emitControl({ kind: "scan-rejection", code: "secret-detected", scannerRulesetVersion: verdict.rulesetVersion });
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
    });
  } catch (e) {
    emitControl({ kind: "worker-error", message: e instanceof Error ? e.message : String(e) });
    process.exit(4);
  }
}

main();
