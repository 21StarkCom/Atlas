/**
 * Egress-spool drain (CLI-side, D18) — the receiving half of the egress daemon's
 * narrow ciphertext-only quarantine hand-off.
 *
 * The `atlas-egress` daemon cannot hold the quarantine AEAD key (§4, trusted-CLI
 * only), so when its in-broker scan blocks a payload it SEALS the offending bytes +
 * finding metadata to the CLI's quarantine PUBLIC key and drops a ciphertext-only
 * envelope into the spool dir. This drain — run by the CLI, which holds the matching
 * X25519 PRIVATE key — opens each envelope and re-seals the bytes into the CLI-owned
 * encrypted {@link QuarantineStore} (AES-256-GCM at rest), then deletes the drained
 * spool file. Nothing is ever at rest in plaintext on either side.
 *
 * A malformed/corrupt/wrong-key envelope is left in place and surfaced in the result
 * (fail closed — never silently dropped, never trusted to expire a neighbour).
 */
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type KeyObject } from "node:crypto";
import { openSpoolEnvelope, type SealedSpoolEnvelope } from "@atlas/broker";
import type { QuarantineStore } from "./store.js";

/** Only committed sealed envelopes (`q-<hex>.spool.json`) are drained; temps are skipped. */
const SPOOL_NAME = /^q-[0-9a-f]{32}\.spool\.json$/;

/** The outcome of a drain pass. */
export interface SpoolDrainResult {
  /** Item ids written into the CLI quarantine store, one per drained envelope. */
  readonly drained: string[];
  /** Envelopes that failed to open/validate (left in place). */
  readonly failed: { file: string; error: string }[];
}

/**
 * Drain the egress spool at `spoolDir` into `store`, opening each sealed envelope
 * with the CLI's quarantine `privateKey`. Returns the drained item ids + any
 * failures. Idempotent: a drained envelope is deleted, so a re-run is a no-op.
 */
export function drainEgressSpool(
  spoolDir: string,
  privateKey: KeyObject | Buffer | string,
  store: QuarantineStore,
): SpoolDrainResult {
  const drained: string[] = [];
  const failed: { file: string; error: string }[] = [];
  if (!existsSync(spoolDir)) return { drained, failed };

  for (const name of readdirSync(spoolDir)) {
    if (!SPOOL_NAME.test(name)) continue;
    const path = join(spoolDir, name);
    try {
      const envelope = JSON.parse(readFileSync(path, "utf8")) as SealedSpoolEnvelope;
      const opened = openSpoolEnvelope(privateKey, envelope);
      const itemId = store.quarantineItem({
        bytes: opened.bytes,
        origin: opened.origin,
        findings: opened.findings.map((f) => ({
          ruleId: f.ruleId,
          title: f.title,
          severity: f.severity as "high" | "medium",
          startOffset: f.startOffset,
          endOffset: f.endOffset,
          redactedPreview: "",
        })),
      });
      drained.push(itemId);
      rmSync(path, { force: true }); // remove only AFTER a durable re-seal into the store
    } catch (e) {
      failed.push({ file: name, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { drained, failed };
}
