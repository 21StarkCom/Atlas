/**
 * `graduation/scan` — the fail-closed full-vault scan gate (Task 5.1 / #57). Before a real
 * vault is graduated onto Atlas, EVERY file in the working copy is scanned through the same
 * detection engine (`@atlas/scan`) the ingest + generated-artifact boundaries use. The gate is
 * FAIL-CLOSED: graduation proceeds only when the whole copy is clean; a single hit blocks it
 * and names the offending files so they can be quarantined/resolved before graduation.
 *
 * This runs on a COPY (never the user's live vault — plan §Vault safety) and is read-only.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { scanBytes, type SecretFinding } from "@atlas/scan";

/** A file that tripped the scan, with its findings. */
export interface GraduationScanHit {
  readonly file: string;
  readonly findings: readonly SecretFinding[];
}

/** The verdict of a full-vault graduation scan. */
export interface GraduationScanResult {
  /** `true` iff EVERY scanned file was clean — the only state that permits graduation. */
  readonly clean: boolean;
  readonly scannedFiles: number;
  /** The files that tripped the scan (empty iff clean). */
  readonly hits: readonly GraduationScanHit[];
}

/** Recursively list every file under `dir`, excluding `.git`. */
function walk(dir: string): string[] {
  const out: string[] = [];
  const recurse = (cur: string): void => {
    for (const entry of readdirSync(cur).sort()) {
      if (entry === ".git") continue;
      const full = join(cur, entry);
      if (statSync(full).isDirectory()) recurse(full);
      else out.push(full);
    }
  };
  recurse(dir);
  return out;
}

/**
 * Scan every file in the vault copy at `dir` (fail-closed). Returns `clean: true` only when
 * no file tripped the detector; otherwise `hits` names each offending file (deterministic,
 * sorted). Read-only — never mutates the copy.
 */
export function scanVaultCopy(dir: string): GraduationScanResult {
  const files = walk(dir);
  const hits: GraduationScanHit[] = [];
  for (const file of files) {
    const rel = relative(dir, file);
    const verdict = scanBytes({
      bytes: readFileSync(file),
      context: { origin: rel, boundary: "pre-persistence" },
    });
    if (!verdict.clean) hits.push({ file: rel, findings: verdict.findings });
  }
  return { clean: hits.length === 0, scannedFiles: files.length, hits };
}
