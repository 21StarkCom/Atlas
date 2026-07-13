/**
 * Run-manifest commit trailer codec.
 *
 * A `RunManifest` (from `@atlas/contracts`) is recorded on the agent commit as a
 * single-line git trailer. The manifest is canonicalized (`atlas-jcs-v1`) and
 * base64-encoded so the trailer is one line, byte-stable, and free of characters
 * git trailer parsing would fold or truncate. The contract this package must
 * uphold: {@link parseManifestTrailer} run on a message produced by
 * {@link buildCommitMessage} yields a `RunManifest` deep-equal to the original
 * ("manifest trailer parses back to an equal RunManifest", Task 1.5).
 *
 * NOTE (assumption): "signed-manifest trailer" in the plan refers to the commit
 * carrying the manifest; the Ed25519 signing itself is broker/Task-0.3 territory
 * and is out of scope here. This package embeds the manifest trailer only.
 */
import { canonicalSerialize, RunManifestSchema, type RunManifest } from "@atlas/contracts";

/** The trailer key carrying the base64 canonical manifest. */
export const RUN_MANIFEST_TRAILER = "Atlas-Run-Manifest";

/** Encode a manifest as the single trailer line `Atlas-Run-Manifest: <b64>`. */
export function encodeManifestTrailer(manifest: RunManifest): string {
  const canonical = canonicalSerialize(manifest);
  const b64 = Buffer.from(canonical).toString("base64");
  return `${RUN_MANIFEST_TRAILER}: ${b64}`;
}

/**
 * Build a commit message from a human `msg` and the manifest trailer, separated
 * by a blank line (git's trailer-block convention).
 */
export function buildCommitMessage(msg: string, manifest: RunManifest): string {
  // Refuse a caller message that itself carries the reserved trailer key.
  // Otherwise an injected `Atlas-Run-Manifest:` line would sit alongside the
  // one we append; since parsing rejects duplicates (below) — and, defensively,
  // the first line could shadow the appended one — the injected value could
  // override the supplied manifest and break the parse(build(...)) equality
  // this codec guarantees. This key is ours alone.
  const injected = msg
    .split(/\r?\n/)
    .some((l) => l.trim().toLowerCase().startsWith(`${RUN_MANIFEST_TRAILER.toLowerCase()}:`));
  if (injected) {
    throw new Error(
      `commit message may not contain a reserved ${RUN_MANIFEST_TRAILER} trailer line`,
    );
  }
  return `${msg.trimEnd()}\n\n${encodeManifestTrailer(manifest)}\n`;
}

/**
 * Parse the run-manifest trailer out of a full commit message and validate it
 * against `RunManifestSchema`. Throws if the trailer is missing or malformed.
 */
export function parseManifestTrailer(commitMessage: string): RunManifest {
  const prefix = `${RUN_MANIFEST_TRAILER}:`;
  const lines = commitMessage
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith(prefix));
  if (lines.length === 0) {
    throw new Error(`commit message has no ${RUN_MANIFEST_TRAILER} trailer`);
  }
  if (lines.length > 1) {
    // Ambiguous: a second trailer (e.g. injected via the caller message) must
    // never silently win or lose. Reject rather than guess which is canonical.
    throw new Error(
      `commit message has ${lines.length} ${RUN_MANIFEST_TRAILER} trailers; expected exactly one`,
    );
  }
  const line = lines[0]!;
  const b64 = line.slice(prefix.length).trim();
  let json: string;
  try {
    json = Buffer.from(b64, "base64").toString("utf8");
  } catch (err) {
    throw new Error(`malformed ${RUN_MANIFEST_TRAILER} trailer (base64): ${String(err)}`);
  }
  return RunManifestSchema.parse(JSON.parse(json));
}
