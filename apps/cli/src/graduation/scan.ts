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
import { execFileSync } from "node:child_process";
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

/** A blob in git history that tripped the scan, with the commit that introduced it. */
export interface GraduationHistoryHit {
  readonly file: string;
  /** The 40-char hex commit that first added the offending blob's path. */
  readonly commit: string;
  readonly findings: readonly SecretFinding[];
}

/** The verdict of scanning every blob reachable across a copy's git history. */
export interface GraduationHistoryScanResult {
  readonly historyCommits: number;
  readonly hits: readonly GraduationHistoryHit[];
}

/**
 * Scan EVERY blob reachable across the copy's full git history (not just the working tree) — a
 * secret in an old, since-deleted commit still blocks graduation. Deterministic + read-only:
 * enumerates objects via `git rev-list --all --objects`, scans each unique blob's bytes, and
 * attributes a hit to the commit that first added its path. `.git` is never scanned as files.
 */
export function scanGitHistory(dir: string): GraduationHistoryScanResult {
  const git = (args: string[]): string => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  const commits = git(["rev-list", "--all"]).split("\n").filter(Boolean);

  // sha → first path seen (rev-list --objects lists blobs + trees with their paths).
  const blobPath = new Map<string, string>();
  for (const line of git(["rev-list", "--all", "--objects"]).split("\n")) {
    const sp = line.indexOf(" ");
    if (sp < 0) continue; // commit objects have no path
    const sha = line.slice(0, sp);
    const path = line.slice(sp + 1);
    if (path && !blobPath.has(sha)) blobPath.set(sha, path);
  }

  const hits: GraduationHistoryHit[] = [];
  for (const [sha, path] of [...blobPath.entries()].sort((a, b) => a[1].localeCompare(b[1]))) {
    if (git(["cat-file", "-t", sha]).trim() !== "blob") continue;
    const bytes = execFileSync("git", ["-C", dir, "cat-file", "blob", sha], { maxBuffer: 256 * 1024 * 1024 });
    const verdict = scanBytes({ bytes, context: { origin: path, boundary: "pre-persistence" } });
    if (!verdict.clean) {
      const introduced = git(["log", "--all", "--diff-filter=A", "--format=%H", "-1", "--", path]).trim();
      hits.push({ file: path, commit: introduced || (commits[commits.length - 1] ?? ""), findings: verdict.findings });
    }
  }
  return { historyCommits: commits.length, hits };
}
