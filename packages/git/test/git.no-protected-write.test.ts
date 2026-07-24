/**
 * `git.no-protected-write.test` — the security-boundary invariant.
 *
 * Agents may write only `refs/agent/*`; protected-ref writes are broker-only.
 * Three complementary guards:
 *
 *  1. STRUCTURAL source audit — a pure {@link auditSources} function walks the
 *     ENTIRE `src/` tree RECURSIVELY and enforces that (a) every git ref-*write*
 *     subcommand (`update-ref`, `symbolic-ref`, `branch`, `push`, `tag`,
 *     `fast-import`) lives only in `refs.ts`, and (b) each write call site there
 *     sits inside a function that also calls `assertAgentRef`. Run over the real
 *     sources AND over synthetic mutations proving both bypasses (a nested
 *     unguarded write, and a guard removed from an existing write) are caught.
 *
 *  2. PUBLIC-SURFACE — the package index must not re-export `runGit` (raw git
 *     argv execution), which would let a consumer sidestep every guard.
 *
 *  3. BEHAVIORAL — the guarded write functions reject every protected ref
 *     (`refs/heads/*`, `refs/tags/*`, canonical, HEAD, bare/short names) and
 *     accept only well-formed `refs/agent/<ulid>`.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as publicApi from "../src/index.js";
import { assertAgentRef, isAgentRef, updateAgentRef, attachHeadToAgentRef } from "../src/index.js";

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

/** git subcommands that create or move a ref. Reads (rev-parse/show/…) excluded. */
const REF_WRITE_SUBCOMMANDS = ["update-ref", "symbolic-ref", "branch", "push", "tag", "fast-import"];

/** The one module allowed to contain guarded ref-write call sites. */
const GUARDED_WRITE_FILE = "refs.ts";
/**
 * The guards a write call site may be co-located with. `assertAgentRef` guards
 * agent-ref writes; `assertCanonicalRef` guards the v2 in-process canonical-ref
 * fast-forward advance (ADR-0003 — the retired broker no longer owns it). Both
 * reject the audit/trust anchor namespaces, so no write can reach a ledger ref.
 */
const GUARD_CALLS = ["assertAgentRef", "assertCanonicalRef"];

/**
 * The EXACT guard each known ref-writing function must carry. The canonical
 * advance is guarded only by `assertCanonicalRef` (rejects agent/audit/trust);
 * the agent-ref writers only by `assertAgentRef` (rejects everything but
 * `refs/agent/<ulid>`). Binding the guard to the writer prevents a swapped
 * guard from smuggling a writer into the wrong namespace. A ref-writing
 * function not listed here falls back to "any guard in GUARD_CALLS".
 */
const REQUIRED_GUARD: Record<string, string> = {
  advanceCanonicalRef: "assertCanonicalRef",
  updateAgentRef: "assertAgentRef",
  deleteAgentRef: "assertAgentRef",
  attachHeadToAgentRef: "assertAgentRef",
};

interface SrcFile {
  /** Path relative to `src/` (posix-normalized), e.g. `refs.ts` or `sub/x.ts`. */
  readonly path: string;
  readonly text: string;
}

/** Recursively collect every `.ts` source under `src/`. */
function collectSrcFiles(dir: string = SRC_DIR): SrcFile[] {
  const out: SrcFile[] = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) {
      out.push(...collectSrcFiles(abs));
    } else if (entry.endsWith(".ts")) {
      out.push({ path: relative(SRC_DIR, abs).split("\\").join("/"), text: readFileSync(abs, "utf8") });
    }
  }
  return out;
}

/** True iff `text` invokes any ref-write subcommand as a quoted argv token. */
function hasWriteSubcommand(text: string): boolean {
  return REF_WRITE_SUBCOMMANDS.some((sub) => new RegExp(`["']${sub}["']`).test(text));
}

/**
 * Split a source file into top-level function bodies keyed by name, so a write
 * call site can be checked against the guard within its OWN function (not merely
 * "somewhere in the file"). Coarse but sufficient for this flat module.
 */
function functionsOf(text: string): { name: string; body: string }[] {
  const re = /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(/g;
  const starts: { name: string; index: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) starts.push({ name: m[1]!, index: m.index });
  return starts.map((s, i) => ({
    name: s.name,
    body: text.slice(s.index, i + 1 < starts.length ? starts[i + 1]!.index : text.length),
  }));
}

/**
 * Pure security audit over a set of sources. Returns a list of human-readable
 * violation strings; an empty array means the no-protected-write invariant holds.
 * Kept pure (takes `files`, touches no disk) so mutation tests can feed it
 * synthetic sources and prove each bypass is rejected.
 */
export function auditSources(files: SrcFile[]): string[] {
  const violations: string[] = [];
  for (const file of files) {
    if (!hasWriteSubcommand(file.text)) continue;
    // (a) Writes are confined to the single guarded module.
    if (file.path !== GUARDED_WRITE_FILE) {
      violations.push(`ref-write subcommand outside ${GUARDED_WRITE_FILE}: ${file.path}`);
      continue;
    }
    // (b) In that module, each write must sit inside a function that guards —
    // and with the SPECIFIC guard its ref namespace requires. The canonical
    // advance may use ONLY assertCanonicalRef; the agent-ref writers may use
    // ONLY assertAgentRef. Accepting either guard for either writer would let
    // an agent writer be silently re-guarded by assertCanonicalRef (or vice
    // versa) and escape its namespace check.
    for (const fn of functionsOf(file.text)) {
      if (!hasWriteSubcommand(fn.body)) continue;
      const required = REQUIRED_GUARD[fn.name];
      if (required) {
        if (!fn.body.includes(required)) {
          violations.push(
            `ref-write call site ${file.path}#${fn.name} must be guarded by ${required}`,
          );
        }
      } else if (!GUARD_CALLS.some((g) => fn.body.includes(g))) {
        violations.push(`unguarded ref-write call site: ${file.path}#${fn.name}`);
      }
    }
    // A write literal outside ANY function body (module top-level) is also
    // disallowed — it cannot be guarded.
    const inFunctions = functionsOf(file.text)
      .map((f) => f.body)
      .join("\n");
    for (const sub of REF_WRITE_SUBCOMMANDS) {
      const anywhere = new RegExp(`["']${sub}["']`).test(file.text);
      const inFn = new RegExp(`["']${sub}["']`).test(inFunctions);
      if (anywhere && !inFn) {
        violations.push(`top-level (un-guardable) ref-write literal "${sub}" in ${file.path}`);
      }
    }
    // Never a protected namespace literal in the same file as a write.
    if (/['"]refs\/heads\//.test(file.text) || /['"]refs\/tags\//.test(file.text)) {
      violations.push(`protected-namespace literal in write module ${file.path}`);
    }
  }
  return violations;
}

describe("structural source audit (recursive)", () => {
  it("passes over the real sources: writes confined to refs.ts and each is guarded", () => {
    expect(auditSources(collectSrcFiles())).toEqual([]);
  });

  it("MUTATION: catches an unguarded ref-write added in a nested file", () => {
    const mutated: SrcFile[] = [
      ...collectSrcFiles(),
      {
        path: "sneaky/evil.ts",
        text: `import { runGit } from "../exec.js";\nexport async function evil(d: string) {\n  await runGit(d, ["update-ref", "refs/heads/main", "0"]);\n}\n`,
      },
    ];
    const v = auditSources(mutated);
    expect(v).toContain("ref-write subcommand outside refs.ts: sneaky/evil.ts");
  });

  it("MUTATION: catches the guard being removed from an existing write call site", () => {
    const files = collectSrcFiles();
    const refs = files.find((f) => f.path === GUARDED_WRITE_FILE)!;
    // Strip every assertAgentRef call/reference from refs.ts.
    const guardless: SrcFile = {
      path: refs.path,
      text: refs.text.replace(/assertAgentRef/g, "noop"),
    };
    const mutated = files.map((f) => (f.path === refs.path ? guardless : f));
    const v = auditSources(mutated);
    // The agent-ref writers require assertAgentRef specifically; stripping it
    // must be flagged (either the writer-specific "must be guarded by" message
    // or the generic unguarded fallback for any unlisted writer).
    expect(
      v.some(
        (s) =>
          s.startsWith("unguarded ref-write call site: refs.ts#") ||
          (s.startsWith("ref-write call site refs.ts#") && s.includes("must be guarded by assertAgentRef")),
      ),
    ).toBe(true);
  });

  it("MUTATION: catches a protected-namespace literal reaching a write module", () => {
    const files = collectSrcFiles();
    const refs = files.find((f) => f.path === GUARDED_WRITE_FILE)!;
    const poisoned = files.map((f) =>
      f.path === refs.path ? { path: f.path, text: `${f.text}\nconst x = "refs/heads/main";\n` } : f,
    );
    expect(auditSources(poisoned)).toContain("protected-namespace literal in write module refs.ts");
  });
});

describe("public surface", () => {
  it("does not re-export runGit (no raw git argv execution)", () => {
    expect(Object.keys(publicApi)).not.toContain("runGit");
    expect((publicApi as Record<string, unknown>).runGit).toBeUndefined();
  });

  it("exports only capability-specific operations plus the guarded ref helpers", () => {
    // GitError is allowed (error type); everything callable is a guarded helper.
    expect(publicApi).toHaveProperty("openRepo");
    expect(publicApi).toHaveProperty("updateAgentRef");
    expect(publicApi).toHaveProperty("attachHeadToAgentRef");
    expect(publicApi).toHaveProperty("assertAgentRef");
  });
});

describe("behavioral guard — assertAgentRef", () => {
  const PROTECTED = [
    "refs/heads/main",
    "refs/heads/canonical",
    "refs/tags/v1",
    "refs/remotes/origin/main",
    "HEAD",
    "main",
    "canonical",
    "",
    "refs/agent/../heads/main",
    "refs/agent/not-a-ulid",
    "refs/agent/01ARZ3NDEKTSV4RRFFQ69G5FA", // 25 chars — too short for a ULID
  ];

  for (const ref of PROTECTED) {
    it(`rejects "${ref}"`, () => {
      expect(isAgentRef(ref)).toBe(false);
      expect(() => assertAgentRef(ref)).toThrow();
    });
  }

  it("accepts a well-formed refs/agent/<ulid>", () => {
    const ok = "refs/agent/01ARZ3NDEKTSV4RRFFQ69G5FAV";
    expect(isAgentRef(ok)).toBe(true);
    expect(() => assertAgentRef(ok)).not.toThrow();
  });

  it("updateAgentRef rejects a protected ref before shelling git", async () => {
    await expect(updateAgentRef("/tmp", "refs/heads/main", "0".repeat(40))).rejects.toThrow(
      /non-agent ref/,
    );
  });

  it("attachHeadToAgentRef rejects a protected ref before shelling git", async () => {
    await expect(attachHeadToAgentRef("/tmp", "refs/heads/main")).rejects.toThrow(/non-agent ref/);
  });
});
