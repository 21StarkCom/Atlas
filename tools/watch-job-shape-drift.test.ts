import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findRepoRoot } from "./cli-contract.js";

/**
 * SP-1 Phase 2 Task 4 — the `watch.schema.json` `job` event payload is a REPLICA
 * of `@atlas/jobs`' `JobListRow` (the SSOT projection shape `jobs list` serializes;
 * spec §7.6): its schema keys MINUS the common NDJSON envelope keys (`v`/`event`/
 * `at`, which every event member carries) must equal `JobListRow`'s key set. The
 * owner side is parsed from the interface source at runtime — a later `JobListRow`
 * field add/rename fails CI until the schema replica matches (the same
 * owner-to-replica guard the audit eventType enum gets). The replica is
 * EXERCISED by a real `job` event in the Phase 4 liveness test; this test pins
 * the shape only.
 */

const root = findRepoRoot();
const ENVELOPE_KEYS = new Set(["v", "event", "at"]);

/** Parse the JobListRow property names out of the owning interface source. */
function jobListRowKeys(): string[] {
  const src = readFileSync(join(root, "packages/jobs/src/repo.ts"), "utf8");
  const m = /export interface JobListRow \{([\s\S]*?)\n\}/.exec(src);
  if (!m) throw new Error("packages/jobs/src/repo.ts: interface JobListRow not found");
  const body = m[1]!
    // strip block + line comments so doc text can't be misread as members
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  const keys = [...body.matchAll(/^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\??\s*:/gm)].map((k) => k[1]!);
  if (keys.length === 0) throw new Error("JobListRow: no members parsed");
  return keys;
}

function jobEventPayloadKeys(): string[] {
  const schema = JSON.parse(
    readFileSync(join(root, "docs/specs/cli-contract/watch.schema.json"), "utf8"),
  ) as { $defs: { job: { properties: Record<string, unknown> } } };
  return Object.keys(schema.$defs.job.properties).filter((k) => !ENVELOPE_KEYS.has(k));
}

describe("watch.schema.json job event ↔ @atlas/jobs JobListRow", () => {
  it("the job payload key set (minus the v/event/at envelope) equals JobListRow's key set", () => {
    expect(jobEventPayloadKeys().sort()).toEqual(jobListRowKeys().sort());
  });

  it("the optionality split matches: nextRunAt/lastError optional, the rest required", () => {
    const schema = JSON.parse(
      readFileSync(join(root, "docs/specs/cli-contract/watch.schema.json"), "utf8"),
    ) as { $defs: { job: { required: string[]; properties: Record<string, unknown> } } };
    const required = new Set(schema.$defs.job.required.filter((k) => !ENVELOPE_KEYS.has(k)));
    const optional = jobEventPayloadKeys().filter((k) => !required.has(k));
    expect(optional.sort()).toEqual(["lastError", "nextRunAt"]);
  });
});
