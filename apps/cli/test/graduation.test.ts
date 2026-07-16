/**
 * `graduation` (Task 5.1/5.2, #57/#58) — the deterministic cores behind `graduation scan` +
 * `graduation audit`: the working-tree + git-history secret scan, the §7 category inventory, the
 * persisted scan-state gate, and both commands' arg parsing. (The scan command's clone+quarantine
 * and the audit command's run.readonly wiring run over live custody/broker; these cover the pure
 * logic that decides gate/findings/categories.)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ParsedNote, VaultSnapshot, VaultError } from "@atlas/contracts";
import { scanVaultCopy, scanGitHistory } from "../src/graduation/scan.js";
import { categorizeGraduationCopy } from "../src/graduation/audit.js";
import { readScanState, writeScanState, scanStatePath } from "../src/graduation/state.js";
import { parseArgs as scanParseArgs } from "../src/commands/graduation-scan.js";

const AWS_KEY = `AKIA${"A".repeat(16)}`; // a representative, detectable secret (never a real one)

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "atlas-grad-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function git(dir: string, args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
}
function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  git(dir, ["config", "user.email", "t@t"]);
  git(dir, ["config", "user.name", "t"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
}
function commit(dir: string, msg: string): string {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", msg]);
  return git(dir, ["rev-parse", "HEAD"]).trim();
}

describe("graduation scan cores (Task 5.1)", () => {
  it("scanVaultCopy: a clean tree is clean; a secret file is a hit naming the rule (no raw bytes)", () => {
    const dir = join(root, "clean");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "a.md"), "# note\nnothing secret here\n");
    expect(scanVaultCopy(dir).clean).toBe(true);

    writeFileSync(join(dir, "leak.md"), `token: ${AWS_KEY}\n`);
    const r = scanVaultCopy(dir);
    expect(r.clean).toBe(false);
    expect(r.hits.map((h) => h.file)).toContain("leak.md");
    expect(r.hits.flatMap((h) => h.findings.map((f) => f.ruleId))).toContain("aws-access-key-id");
  });

  it("scanGitHistory: a secret committed in an OLD commit then DELETED still blocks (found in history + attributed to its commit)", () => {
    const dir = join(root, "hist");
    initRepo(dir);
    writeFileSync(join(dir, "note.md"), "# clean\n");
    commit(dir, "seed");
    writeFileSync(join(dir, "leak.md"), `key: ${AWS_KEY}\n`);
    const introduced = commit(dir, "add leak");
    rmSync(join(dir, "leak.md"));
    commit(dir, "remove leak"); // gone from the working tree...

    // ...but STILL in history.
    expect(scanVaultCopy(dir).clean).toBe(true); // working tree is now clean
    const hist = scanGitHistory(dir);
    expect(hist.historyCommits).toBe(3);
    const leak = hist.hits.find((h) => h.file === "leak.md");
    expect(leak).toBeDefined();
    expect(leak!.commit).toBe(introduced);
    expect(leak!.findings.map((f) => f.ruleId)).toContain("aws-access-key-id");
  });
});

function err(path: string, kind: string): VaultError {
  return { path, kind, message: kind } as VaultError;
}
function note(id: string, type: string): ParsedNote {
  return { id, path: `${id}.md`, type, schemaVersion: 1, title: id, status: "active", created: "2026-07-16", updated: "2026-07-16", aliases: [], sources: [], declaredSensitivity: "internal", links: [], sections: { heading: "", level: 0, path: "", children: [] }, contentHash: "sha256:0", raw: "" } as ParsedNote;
}

describe("graduation audit category inventory (Task 5.2)", () => {
  it("maps each vault-reader defect to its §7 category and flags an unknown type; detected-credential is empty (clean-gate precondition)", () => {
    const dir = join(root, "vault");
    mkdirSync(dir, { recursive: true });
    // A file that is missing its id (for the missing-* re-parse split).
    writeFileSync(join(dir, "noid.md"), "---\ntype: concept\nschema_version: 1\n---\n# x\n");
    const snapshot: VaultSnapshot = {
      notes: [note("good", "concept"), note("weird", "gizmo")], // 'gizmo' is not a canonical type
      errors: [err("dup.md", "duplicate-id"), err("alias.md", "identity-collision"), err("link.md", "broken-link"), err("old.md", "unsupported-schema-version"), err("noid.md", "invalid-frontmatter")],
    } as VaultSnapshot;

    const { totalNotes, categories } = categorizeGraduationCopy(dir, snapshot);
    expect(totalNotes).toBe(2 + 5); // 2 notes + 5 distinct errored files
    expect(categories["duplicate-identity"]).toEqual(["dup.md"]);
    expect(categories["ambiguous-alias"]).toEqual(["alias.md"]);
    expect(categories["incompatible-link"]).toEqual(["link.md"]);
    expect(categories["unsupported-schema-version"]).toEqual(["old.md"]);
    expect(categories["unknown-type"]).toEqual(["weird.md"]);
    expect(categories["missing-id"]).toEqual(["noid.md"]); // re-parsed: id absent
    expect(categories["detected-credential"]).toEqual([]); // clean-gate precondition
  });
});

describe("graduation scan-state gate (Task 5.1)", () => {
  it("round-trips clean/blocked; a missing or malformed sidecar reads as null (fail-closed)", () => {
    const p = scanStatePath(join(root, ".atlas", "atlas.db"));
    expect(readScanState(p)).toBeNull(); // absent ⇒ not cleared
    writeScanState(p, { copy: "/c", copyHead: "a".repeat(40), gate: "clean", scannedAt: "2026-07-16T00:00:00Z", findingCount: 0 });
    expect(readScanState(p)).toMatchObject({ gate: "clean", copy: "/c" });
    writeScanState(p, { copy: "/c", copyHead: "b".repeat(40), gate: "blocked", scannedAt: "2026-07-16T00:00:00Z", findingCount: 2 });
    expect(readScanState(p)!.gate).toBe("blocked");
    writeFileSync(p, "{ not valid json");
    expect(readScanState(p)).toBeNull();
  });
});

describe("graduation scan arg parsing (Task 5.1)", () => {
  it("requires --source and --copy; rejects unknown flags", () => {
    expect(scanParseArgs(["--source", "/s", "--copy", "/c"])).toEqual({ source: "/s", copy: "/c" });
    expect(scanParseArgs(["--source=/s", "--copy=/c"])).toEqual({ source: "/s", copy: "/c" });
    expect(() => scanParseArgs(["--copy", "/c"])).toThrow(/--source/);
    expect(() => scanParseArgs(["--source", "/s"])).toThrow(/--copy/);
    expect(() => scanParseArgs(["--nope"])).toThrow(/unknown/);
  });
});
