/**
 * `graduation/releases` — the persisted operator RELEASE records (bootstrap-migration.md §7.1).
 * `quarantine resolve --resolution release` authorizes a blocked (incompatible-link) note to migrate
 * as-is; the record (note path → resolving opaqueId + authorization) is persisted here so the next
 * `graduation migrate` re-includes exactly those notes (the plan's `released` input). A sidecar next
 * to the ledger DB, keyed by note path.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ReleaseInput } from "./migrate-plan.js";

/** The release-records sidecar path (next to the ledger DB, in the `graduation/` subdir). */
export function releasesPath(ledgerDbPath: string): string {
  return join(dirname(ledgerDbPath), "graduation", "releases.json");
}

/** Read all persisted release records (path → {opaqueId, authorization}); `{}` when none. */
export function readReleases(path: string): Record<string, ReleaseInput> {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, ReleaseInput>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** Record (idempotently) an operator release of the note at `notePath`. */
export function addRelease(path: string, notePath: string, release: ReleaseInput): void {
  const all = readReleases(path);
  all[notePath] = release;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(all, null, 2)}\n`, "utf8");
}
