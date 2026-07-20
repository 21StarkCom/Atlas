#!/usr/bin/env node
/**
 * `atlas-egress` daemon entry point.
 *
 * Started by `provisioning/bin/egress-launcher.sh` as the `atlas-egress` OS
 * identity — the SOLE holder of the provider credential and the SOLE
 * outbound-network process (D13(c)/D17/D18). It reads its config from the
 * environment, constructs the Gemini adapter + a REAL ciphertext-only quarantine
 * channel + a PERSISTENT per-run budget store, and serves the Unix-socket `invoke`
 * protocol until signalled. It has NO SQLite/vault access (D18) — every response is
 * a receipt the CLI persists.
 *
 * ## Custody (operational, secure)
 *   - **Capability-MAC secret — CLI-READABLE, shared (fixes the ACL finding).** The
 *     CLI mints run-bound capabilities and the daemon verifies them against the SAME
 *     shared secret. It therefore does NOT live in the `atlas-egress`-only `0700`
 *     keys dir (which the CLI cannot read); it lives at `ATLAS_EGRESS_CAPABILITY_KEY`
 *     — a file the launcher provisions readable by BOTH the CLI and egress. If absent
 *     the daemon bootstraps it there `0640` (custody bootstrap for the local-first
 *     playground); in production the launcher provisions it ahead of time. The
 *     command-scoped `ATLAS_EGRESS_CAPABILITY_KEY_FD` form is accepted too (#60
 *     Phase 6) and never bootstraps — the two ends share one resolver
 *     (`src/egress/capability-custody.ts`) so their representations cannot drift.
 *   - **Quarantine — CIPHERTEXT-ONLY, sealed to the CLI (fixes the plaintext finding).**
 *     The daemon MUST NOT hold the quarantine AEAD key (trusted-CLI-only, §4). It
 *     holds only the CLI's quarantine PUBLIC key (`ATLAS_EGRESS_QUARANTINE_PUBKEY`,
 *     non-secret) and seals every blocked payload to it (X25519 sealed box) into the
 *     provisioned spool dir (`ATLAS_EGRESS_QUARANTINE_SPOOL`). The CLI drains + opens
 *     the spool with its private key into its sealed store — a real narrow handoff.
 *   - **Budget — PERSISTENT (fixes the restart-reset finding).** Per-run byte/token/
 *     cost tallies are persisted at `ATLAS_EGRESS_BUDGET_STATE`, so a restart /
 *     replacement daemon cannot reset a run's consumed allowance.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { GeminiAdapter } from "../src/egress/gemini.js";
import { EgressService, startEgressServer } from "../src/egress/server.js";
import { SealedSpoolQuarantineSink } from "../src/egress/spool-quarantine.js";
import { FileBudgetStore } from "../src/egress/budget-store.js";
import {
  resolveCapabilitySecret,
  CAPABILITY_KEY_ENV,
  CAPABILITY_KEY_FD_ENV,
} from "../src/egress/capability-custody.js";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (v === undefined || v.length === 0) throw new Error(`${name} is required`);
  return v;
}

/**
 * Resolve the shared capability secret from custody, bootstrapping the custody FILE
 * `0640` (CLI-readable) when the path form is used and the file is absent.
 *
 * Custody itself (fd form vs path form, fail-closed on empty/unreadable) belongs to
 * the one shared {@link resolveCapabilitySecret} the CLI mint path also uses — the
 * two ends must never disagree about the representation (#60 Phase 6, Task 6.2).
 * Bootstrap stays here because it is a property of the FILE, not of the resolution:
 * an fd hand-off has nothing to create, and an fd that cannot be read must fail
 * closed rather than silently mint a fresh secret the CLI does not hold.
 */
function readOrBootstrapCapabilitySecret(): string {
  const fd = process.env[CAPABILITY_KEY_FD_ENV];
  const path = process.env[CAPABILITY_KEY_ENV];
  if ((fd === undefined || fd.length === 0) && path !== undefined && path.length > 0 && !existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o750 });
    const secret = randomBytes(32).toString("base64");
    // 0640: the CLI (group) reads it to MINT; egress reads it to VERIFY. NOT 0600 in
    // the egress-only 0700 keys dir — that is exactly the ACL the finding flagged.
    writeFileSync(path, secret, { mode: 0o640 });
    return secret;
  }
  return resolveCapabilitySecret();
}

async function main(): Promise<void> {
  const socketPath = requireEnv("ATLAS_EGRESS_SOCKET");
  const keysDir = requireEnv("ATLAS_EGRESS_KEYS_DIR");

  // The provider credential is the ONLY key in the egress-only 0700 keys dir.
  const apiKey = readFileSync(join(keysDir, "atlas.gemini.key"), "utf8").trim();

  // Shared, CLI-readable capability-MAC secret (NOT inside the egress-only keys dir).
  const capabilitySecret = readOrBootstrapCapabilitySecret();

  // Ciphertext-only quarantine: seal to the CLI's public key into the provisioned spool.
  const spoolDir = requireEnv("ATLAS_EGRESS_QUARANTINE_SPOOL");
  const recipientPublicKey = readFileSync(requireEnv("ATLAS_EGRESS_QUARANTINE_PUBKEY"));
  mkdirSync(spoolDir, { recursive: true, mode: 0o700 });
  const quarantine = new SealedSpoolQuarantineSink({ dir: spoolDir, recipientPublicKey });

  // Persistent per-run budget (survives restart) — broker-owned state file.
  const budgetStatePath = process.env.ATLAS_EGRESS_BUDGET_STATE ?? join(keysDir, "..", "egress-budget-state.json");
  const budgetStore = new FileBudgetStore(budgetStatePath);

  const adapter = new GeminiAdapter({ apiKey });
  const service = new EgressService({ adapter, quarantine, capabilitySecret, budgetStore });
  const server = await startEgressServer(service, socketPath);

  const shutdown = (): void => {
    void server.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // eslint-disable-next-line no-console
  console.error(`atlas-egress listening on ${socketPath} (quarantine spool: ${spoolDir}, budget: ${budgetStatePath})`);
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(`atlas-egress failed to start: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(4);
});
