/**
 * `graduation-credential-handshake` (Task 5.1) — the scan→migrate credential handshake end to end.
 * The read-only scan leaves the plaintext credential file in the copy and persists its path in the
 * scan-state sidecar; migrate reads that path, EXCLUDES it from the plan (never migrated), and
 * reports it `detected-credential`; apply then DELETES it from the copy (journaled, so rollback
 * restores it). Proves the conservation identity `scanned == migrated + credential-quarantined`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanVaultCopy } from "../src/graduation/scan.js";
import { writeScanState, readScanState } from "../src/graduation/state.js";
import { planBootstrapMigration } from "../src/graduation/migrate-plan.js";
import { applyBootstrapMigration, readOriginalInputs, rollbackBootstrapMigration } from "../src/graduation/migrate-apply.js";

const BOOTSTRAP_TS = "2026-07-12T00:00:00Z";

let root: string;
let copy: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "atlas-cred-"));
  copy = join(root, "copy");
  mkdirSync(join(copy, "People"), { recursive: true });
  // A representative credential, assembled at runtime (never a committed literal secret).
  const secret = `AKIA${"A".repeat(16)}`;
  writeFileSync(join(copy, "People", "Koral.md"), "# Koral\n\nDesign partner.\n", "utf8");
  writeFileSync(join(copy, "Secrets.md"), `# Secrets\n\naws_key = ${secret}\n`, "utf8");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("scan→migrate credential handshake (Task 5.1)", () => {
  it("scan is read-only, migrate skips + quarantines, apply deletes; scanned == migrated + quarantined", () => {
    // 1. Scan (read-only) → derive credential paths exactly as `graduation scan` persists them.
    const scan = scanVaultCopy(copy);
    const scannedFiles = scan.scannedFiles;
    expect(scan.clean).toBe(false);
    const credentialPaths = [...new Set(scan.hits.map((h) => h.file))].sort();
    expect(credentialPaths).toEqual(["Secrets.md"]);

    // 2. The plaintext credential file is STILL present after the read-only scan.
    expect(existsSync(join(copy, "Secrets.md"))).toBe(true);

    // 3. Scan-state round-trips the credential dispositions (the persisted handshake contract).
    const statePath = join(root, "scan-state.json");
    writeScanState(statePath, { copy, copyHead: "0".repeat(40), gate: "blocked", scannedAt: BOOTSTRAP_TS, findingCount: scan.hits.length, credentialPaths });
    const state = readScanState(statePath);
    expect(state?.gate).toBe("blocked");
    expect(state?.credentialPaths).toEqual(["Secrets.md"]);

    // 4. Plan EXCLUDES the credential path from migrable and reports it detected-credential.
    const plan = planBootstrapMigration(readOriginalInputs(copy), { bootstrapTimestamp: BOOTSTRAP_TS, credentialPaths: state!.credentialPaths! });
    expect(plan.notes.map((n) => n.path)).not.toContain("Secrets.md");
    expect(plan.notes.map((n) => n.path)).toContain("People/Koral.md");
    expect(plan.quarantined).toEqual([{ path: "Secrets.md", category: "detected-credential" }]);

    // 5. Apply DELETES the credential file from the copy (journaled) and migrates the other note.
    applyBootstrapMigration(copy, plan, { migrationRunId: "01JQZZZZZZZZZZZZZZZZZZZZZZ", bootstrapTimestamp: BOOTSTRAP_TS });
    expect(existsSync(join(copy, "Secrets.md"))).toBe(false); // credential gone from the graduated copy
    expect(existsSync(join(copy, "People", "Koral.md"))).toBe(true); // other note migrated in place
    expect(readFileSync(join(copy, "People", "Koral.md"), "utf8")).toContain("id: person-koral");

    // 6. Conservation: every scanned input is either migrated or credential-quarantined (exact).
    expect(plan.notes.length + plan.quarantined.length).toBe(scannedFiles);

    // 7. Journaled: rollback restores the deleted credential file byte-for-byte.
    const secretText = `# Secrets\n\naws_key = AKIA${"A".repeat(16)}\n`;
    const rb = rollbackBootstrapMigration(copy);
    expect(rb.rolledBack.map((r) => r.path)).toContain("Secrets.md");
    expect(existsSync(join(copy, "Secrets.md"))).toBe(true);
    expect(readFileSync(join(copy, "Secrets.md"), "utf8")).toBe(secretText);
  });
});
