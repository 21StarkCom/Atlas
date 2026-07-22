/**
 * `note add` (#262) — unit/integration for {@link addNote}, the deterministic
 * Tier-1 ingest of a PRE-AUTHORED vault note, REWRITTEN for the v2 direct-commit
 * mutation order (task 3-3b, #325).
 *
 * The v2 `addNote(ctx, { path, dest, deps })` owns its own vault lock via
 * `runMutation`, commits directly onto `refs/heads/main` via `commitPaths` (no
 * agent branch/worktree/broker CAS, no idempotency-replay layer), and projects
 * the note into a `:memory:` migrated store. Proven against a REAL git vault +
 * REAL migrated projection store — no daemon, no socket, no binary.
 *
 * Covers:
 *   1. happy path — a schema-valid authored note lands at `<dest>/<basename>` on
 *      `refs/heads/main`, byte-exact, with a projection row present;
 *   2. duplicate id vs an existing `notes` row — refused, canonical does NOT advance;
 *   3. duplicate path vs an existing `notes` row — refused;
 *   4. invalid frontmatter (missing `id`) — refused before any write;
 *   5. a secret in the note body — quarantined + `SecretDetectedError` exit 3,
 *      nothing on canonical;
 *   6. REGRESSION (TOCTOU): bytes swapped on disk AFTER normalize()'s clean scan
 *      are re-scanned as the exact persisted buffer — quarantined + exit 3;
 *   7. `deriveDestPath` unit cases.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { probeSandbox } from "@atlas/sources";
import { openStore, ProjectionRepo, type Store } from "@atlas/sqlite-store";
import { PrePersistenceGuard, SecretDetectedError, type QuarantineSink, type SecretFinding } from "@atlas/scan";
import { addNote, deriveDestPath, NoteAddRejectedError, type NoteAddResult } from "../src/ingest/note-add.js";
import type { RunContext } from "../src/handlers.js";

const CANONICAL_REF = "refs/heads/main";

const gitEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  GIT_AUTHOR_NAME: "Aryeh Stark",
  GIT_AUTHOR_EMAIL: "aryeh@21stark.com",
  GIT_COMMITTER_NAME: "Aryeh Stark",
  GIT_COMMITTER_EMAIL: "aryeh@21stark.com",
});

/** Records what was quarantined, so we can assert quarantine-before-throw. */
class RecordingSink implements QuarantineSink {
  readonly entries: { bytes: Uint8Array; origin: string; findings: readonly SecretFinding[] }[] = [];
  quarantine(input: { bytes: Uint8Array; origin: string; findings: readonly SecretFinding[] }): Promise<void> {
    this.entries.push({ bytes: Uint8Array.from(input.bytes), origin: input.origin, findings: input.findings });
    return Promise.resolve();
  }
}

/** A fresh guard whose sink never trips on clean authored notes. */
function cleanGuard(): PrePersistenceGuard {
  return new PrePersistenceGuard(new RecordingSink());
}

/**
 * A guard simulating a TOCTOU attacker: after the FIRST scan (normalize()'s
 * raw-bytes pass over its own read) clears, it rewrites the on-disk file — so
 * the bytes addNote later reads for persistence differ from the bytes normalize
 * proved clean. Only the persisted-buffer re-scan stands between the swapped-in
 * secret and canonical.
 */
class RewriteAfterFirstScanGuard extends PrePersistenceGuard {
  private fired = false;
  constructor(
    sink: QuarantineSink,
    private readonly rewrite: () => void,
  ) {
    super(sink);
  }
  override async assertClean(a: {
    readonly bytes: Uint8Array;
    readonly origin: string;
    readonly kind?: "raw" | "normalized";
  }): Promise<void> {
    await super.assertClean(a);
    if (!this.fired) {
      this.fired = true;
      this.rewrite();
    }
  }
}

/** A schema-valid authored vault note (the vault reader's frontmatter contract). */
function noteText(id: string, title: string, body = "A perfectly ordinary note body."): string {
  return [
    "---",
    `id: ${id}`,
    "type: history",
    "schema_version: 1",
    `title: ${title}`,
    "created: 2026-07-19",
    "updated: 2026-07-19",
    "---",
    `# ${title}`,
    "",
    body,
    "",
  ].join("\n");
}

interface Fix {
  dir: string;
  store: Store;
  ctx: RunContext;
  git(args: string[]): string;
  projectNote(rel: string, id: string): void;
}

let fix: Fix;

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "atlas-note-add-"));
  const git = (args: string[]): string => execFileSync("git", args, { cwd: dir, encoding: "utf8", env: gitEnv() }).trim();
  git(["init", "-q", "-b", "main"]);
  git(["config", "commit.gpgsign", "false"]);
  writeFileSync(join(dir, "README.md"), "seed\n", "utf8");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "seed"]);

  const store = openStore({ path: ":memory:" });
  store.migrate();
  const proj = new ProjectionRepo(store.db);

  // vault.path ABSOLUTE ⇒ resolvePath returns it as-is regardless of cwd.
  const ctx = {
    env: {},
    cwd: dir,
    withLock: (_s: unknown, fn: () => unknown) => fn(),
    config: { config: { vault: { path: dir, note_globs: ["**/*.md"] } } },
  } as unknown as RunContext;

  fix = {
    dir,
    store,
    ctx,
    git,
    projectNote(rel, id): void {
      proj.insertNote({
        note_id: id,
        slug: id,
        title: id,
        type: "note",
        schema_version: 1,
        status: "active",
        file_path: rel,
        content_hash: "sha256:" + "0".repeat(64),
        created: "2026-01-01T00:00:00Z",
        updated: "2026-01-01T00:00:00Z",
      });
    },
  };
});

afterEach(() => {
  try {
    fix.store.close();
  } catch {
    /* ignore */
  }
  rmSync(fix.dir, { recursive: true, force: true });
});

/** Capture the {@link NoteAddRejectedError} an addNote call throws (fails if it resolves). */
async function rejectedCode(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(NoteAddRejectedError);
    return (e as NoteAddRejectedError).code;
  }
  throw new Error("expected addNote to throw NoteAddRejectedError, but it resolved");
}

// `normalize` runs the sandboxed parser worker — same #29 gate as the other
// capture-driving suites: STRICT on a provisioned host, LOUD SKIP otherwise.
const NA_SANDBOX = await probeSandbox();
const NA_REQUIRE = process.env.ATLAS_SANDBOX_REQUIRE === "1" || (process.env.CI === "true" && platform() === "darwin");
if (!NA_SANDBOX.supported && NA_REQUIRE) {
  const missing = NA_SANDBOX.checks.filter((c) => !c.available).map((c) => c.guarantee).join(", ");
  throw new Error(`[note-add] provisioned host must support the sandbox but does not (${NA_SANDBOX.host}: ${missing})`);
}
if (!NA_SANDBOX.supported) console.warn(`[note-add] SKIP sandbox-dependent tests: sandbox unsupported on ${NA_SANDBOX.host}`);
const describeIfSandbox = NA_SANDBOX.supported ? describe : describe.skip;

describeIfSandbox("note add — v2 direct-commit onto refs/heads/main", () => {
  it("happy path: a schema-valid authored note lands at <dest>/<basename> on canonical, byte-exact, projected", async () => {
    const inbox = join(fix.dir, "inbox");
    mkdirSync(inbox, { recursive: true });
    const input = join(inbox, "trip-report.md");
    writeFileSync(input, noteText("history-trip-2026", "Trip Report"), "utf8");
    const raw = readFileSync(input);
    const before = fix.git(["rev-parse", CANONICAL_REF]);

    const result: NoteAddResult = await addNote(fix.ctx, {
      path: input,
      dest: "history/2026",
      deps: { guard: cleanGuard(), store: fix.store },
    });

    expect(result.noteId).toBe("history-trip-2026");
    expect(result.path).toBe("history/2026/trip-report.md");
    expect(result.contentHash).toBe(`sha256:${createHash("sha256").update(raw).digest("hex")}`);
    expect(result.runId).toBeTruthy();

    // Canonical advanced exactly to the reported sha …
    const head = fix.git(["rev-parse", CANONICAL_REF]);
    expect(head).not.toBe(before);
    expect(result.canonicalSha).toBe(head);

    // … and the file exists in the CANONICAL TREE with the exact input bytes.
    const shown = execFileSync("git", ["show", `${CANONICAL_REF}:history/2026/trip-report.md`], { cwd: fix.dir });
    expect(Buffer.from(shown).equals(raw)).toBe(true);

    // … and the projection row is present.
    const row = fix.store.db.prepare("SELECT note_id, file_path FROM notes WHERE note_id = ?").get("history-trip-2026") as
      | { note_id: string; file_path: string }
      | undefined;
    expect(row).toEqual({ note_id: "history-trip-2026", file_path: "history/2026/trip-report.md" });
  }, 60_000);

  it("duplicate id vs an existing note: NoteAddRejectedError(duplicate-id), canonical does NOT advance", async () => {
    fix.projectNote("history/existing.md", "history-dup-2026");
    const input = join(fix.dir, "dup.md");
    writeFileSync(input, noteText("history-dup-2026", "Duplicate"), "utf8");
    const before = fix.git(["rev-parse", CANONICAL_REF]);

    const code = await rejectedCode(addNote(fix.ctx, { path: input, dest: "history", deps: { guard: cleanGuard(), store: fix.store } }));
    expect(code).toBe("duplicate-id");
    expect(fix.git(["rev-parse", CANONICAL_REF])).toBe(before);
  }, 60_000);

  it("duplicate path vs an existing note: NoteAddRejectedError(duplicate-path)", async () => {
    fix.projectNote("history/trip-report.md", "some-other-id");
    const input = join(fix.dir, "trip-report.md");
    writeFileSync(input, noteText("history-fresh-2026", "Fresh"), "utf8");
    const before = fix.git(["rev-parse", CANONICAL_REF]);

    const code = await rejectedCode(addNote(fix.ctx, { path: input, dest: "history", deps: { guard: cleanGuard(), store: fix.store } }));
    expect(code).toBe("duplicate-path");
    expect(fix.git(["rev-parse", CANONICAL_REF])).toBe(before);
  }, 60_000);

  it("invalid frontmatter (missing id): rejected, nothing on canonical", async () => {
    const input = join(fix.dir, "no-id.md");
    writeFileSync(
      input,
      ["---", "type: history", "schema_version: 1", "title: No Id", "created: 2026-07-19", "updated: 2026-07-19", "---", "# No Id", ""].join("\n"),
      "utf8",
    );
    const before = fix.git(["rev-parse", CANONICAL_REF]);

    const code = await rejectedCode(addNote(fix.ctx, { path: input, dest: "history", deps: { guard: cleanGuard(), store: fix.store } }));
    expect(code).toBe("invalid-frontmatter");
    expect(fix.git(["rev-parse", CANONICAL_REF])).toBe(before);
  }, 60_000);

  it("a secret in the note body: quarantined, SecretDetectedError exit 3, nothing on canonical", async () => {
    // A live-format AWS key assembled at runtime (never a committed literal — the repo is public).
    const secret = "AKIA" + "A".repeat(16);
    const input = join(fix.dir, "leaky-note.md");
    writeFileSync(input, noteText("history-leaky-2026", "Leaky", `embedded credential: ${secret}`), "utf8");
    const sink = new RecordingSink();
    const guard = new PrePersistenceGuard(sink);
    const before = fix.git(["rev-parse", CANONICAL_REF]);

    let thrown: unknown;
    let result: unknown;
    try {
      result = await addNote(fix.ctx, { path: input, dest: "history", deps: { guard, store: fix.store } });
    } catch (e) {
      thrown = e;
    }

    expect(result).toBeUndefined();
    expect(thrown).toBeInstanceOf(SecretDetectedError);
    expect((thrown as SecretDetectedError).exitCode).toBe(3);

    expect(sink.entries.length).toBeGreaterThanOrEqual(1);
    expect(sink.entries[0]!.origin).toBe(input);
    expect(sink.entries[0]!.findings.length).toBeGreaterThanOrEqual(1);

    expect(fix.git(["rev-parse", CANONICAL_REF])).toBe(before);
  }, 60_000);

  it("REGRESSION (TOCTOU): a secret swapped in AFTER normalize()'s clean scan is caught on the persisted buffer", async () => {
    const secret = "AKIA" + "A".repeat(16);
    const input = join(fix.dir, "toctou-note.md");
    writeFileSync(input, noteText("history-toctou-2026", "Toctou"), "utf8");
    const sink = new RecordingSink();
    const guard = new RewriteAfterFirstScanGuard(sink, () => {
      writeFileSync(input, noteText("history-toctou-2026", "Toctou", `swapped-in credential: ${secret}`), "utf8");
    });
    const before = fix.git(["rev-parse", CANONICAL_REF]);

    let thrown: unknown;
    let result: unknown;
    try {
      result = await addNote(fix.ctx, { path: input, dest: "history", deps: { guard, store: fix.store } });
    } catch (e) {
      thrown = e;
    }

    expect(result).toBeUndefined();
    expect(thrown).toBeInstanceOf(SecretDetectedError);
    expect((thrown as SecretDetectedError).exitCode).toBe(3);

    expect(sink.entries.length).toBeGreaterThanOrEqual(1);
    const q = sink.entries[sink.entries.length - 1]!;
    expect(q.origin).toBe(input);
    expect(q.findings.length).toBeGreaterThanOrEqual(1);
    expect(Buffer.from(q.bytes).toString("utf8")).toContain(secret);

    expect(fix.git(["rev-parse", CANONICAL_REF])).toBe(before);
  }, 60_000);
});

// ── deriveDestPath unit cases (pure — no sandbox, no harness) ────────────────

describe("deriveDestPath", () => {
  const MD = "/anywhere/on/disk/my-note.md";

  function codeOf(fn: () => unknown): string {
    try {
      fn();
    } catch (e) {
      expect(e).toBeInstanceOf(NoteAddRejectedError);
      return (e as NoteAddRejectedError).code;
    }
    throw new Error("expected deriveDestPath to throw NoteAddRejectedError");
  }

  it("accepts a nested folder and joins the input basename", () => {
    expect(deriveDestPath("notes/2026/q3", MD)).toBe("notes/2026/q3/my-note.md");
  });

  it("accepts a trailing slash (normalized away)", () => {
    expect(deriveDestPath("notes/", MD)).toBe("notes/my-note.md");
  });

  it("rejects an absolute dest", () => {
    expect(codeOf(() => deriveDestPath("/etc", MD))).toBe("bad-dest");
  });

  it("rejects .. traversal and . segments", () => {
    expect(codeOf(() => deriveDestPath("notes/../secrets", MD))).toBe("bad-dest");
    expect(codeOf(() => deriveDestPath("..", MD))).toBe("bad-dest");
    expect(codeOf(() => deriveDestPath("notes/./x", MD))).toBe("bad-dest");
  });

  it("rejects the sources/ capture-only namespace (case-insensitively — matches the broker)", () => {
    expect(codeOf(() => deriveDestPath("sources", MD))).toBe("bad-dest");
    expect(codeOf(() => deriveDestPath("sources/sub", MD))).toBe("bad-dest");
    expect(codeOf(() => deriveDestPath("Sources", MD))).toBe("bad-dest");
    expect(codeOf(() => deriveDestPath("SOURCES/sub", MD))).toBe("bad-dest");
  });

  it("rejects any .git segment (case-insensitively — matches the broker)", () => {
    expect(codeOf(() => deriveDestPath(".git", MD))).toBe("bad-dest");
    expect(codeOf(() => deriveDestPath("notes/.git", MD))).toBe("bad-dest");
    expect(codeOf(() => deriveDestPath(".GIT/x", MD))).toBe("bad-dest");
    expect(codeOf(() => deriveDestPath("notes/.Git", MD))).toBe("bad-dest");
  });

  it("rejects backslashes and an empty dest", () => {
    expect(codeOf(() => deriveDestPath("notes\\evil", MD))).toBe("bad-dest");
    expect(codeOf(() => deriveDestPath("", MD))).toBe("bad-dest");
    expect(codeOf(() => deriveDestPath("///", MD))).toBe("bad-dest");
  });

  it("rejects a non-.md input file", () => {
    expect(codeOf(() => deriveDestPath("notes", "/anywhere/thing.txt"))).toBe("bad-input");
  });
});
