/**
 * `graduation/state` — the persisted scan-state gate (Task 5.1/5.2). `graduation scan` writes it
 * after scanning the disposable copy; the flag-free `graduation audit` (and, later, `graduation
 * migrate`) read it to enforce the fail-closed ordering: audit/migrate refuse until a CLEAN scan
 * of the recorded copy exists. It records the copy path + its scanned HEAD so downstream commands
 * operate on the exact copy the scan cleared — a sidecar next to the ledger DB, not inside the copy
 * (writing into the copy would perturb its tree hash).
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/** The persisted verdict of the most recent `graduation scan`. */
export interface GraduationScanState {
  /** Absolute path of the disposable graduation copy that was scanned. */
  readonly copy: string;
  /** 40-char hex HEAD of the copy at scan time. */
  readonly copyHead: string;
  /** `clean` ⇒ downstream graduation may proceed; `blocked` ⇒ findings must be resolved first. */
  readonly gate: "clean" | "blocked";
  /** RFC-3339 scan timestamp. */
  readonly scannedAt: string;
  /** Number of findings that produced the gate (0 iff clean). */
  readonly findingCount: number;
  /**
   * The working-tree paths whose files carried ≥1 credential finding (Task 5.1 handshake). A
   * BLOCKED gate that records these lets `graduation migrate` proceed by SKIPPING + quarantining
   * exactly these paths (they never migrate); apply then deletes them from the copy. A blocked
   * gate with NO recorded credentialPaths (older state) still hard-fails migrate (scan-gate-open).
   * Optional so pre-Task-5 sidecars read back cleanly.
   */
  readonly credentialPaths?: readonly string[];
  /**
   * How many findings are HISTORY-ONLY (git-history commits, no working-tree file). Apply scrubs the
   * working tree ONLY, and the copy retains its full `.git` history, so a history-only credential
   * would leak into the graduated vault. Any non-zero count makes `graduation migrate` hard-fail
   * (scan-gate-open) even when `credentialPaths` records the working-tree handshake. Optional so
   * pre-Task-5 sidecars read back cleanly (absent ⇒ 0 ⇒ governed by the credentialPaths check).
   */
  readonly historyCredentialCount?: number;
}

/** The scan-state sidecar path (next to the ledger DB, in a `graduation/` subdir). */
export function scanStatePath(ledgerDbPath: string): string {
  return join(dirname(ledgerDbPath), "graduation", "scan-state.json");
}

/** Persist the scan-state gate (creating the `graduation/` dir as needed). */
export function writeScanState(path: string, state: GraduationScanState): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

/** Read the scan-state gate, or `null` when no scan has run (fail-closed: absence ⇒ not cleared). */
export function readScanState(path: string): GraduationScanState | null {
  let s: GraduationScanState;
  try {
    s = JSON.parse(readFileSync(path, "utf8")) as GraduationScanState;
  } catch {
    return null; // absent OR malformed JSON ⇒ treated as no clearance (fail-closed)
  }
  if (typeof s.copy !== "string" || typeof s.copyHead !== "string" || (s.gate !== "clean" && s.gate !== "blocked")) {
    return null; // a structurally-invalid sidecar is treated as no clearance (fail-closed)
  }
  return s;
}
