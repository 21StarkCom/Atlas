/**
 * `note add` (#262) — CLI e2e for {@link addNote}, the deterministic Tier-1
 * ingest of a PRE-AUTHORED vault note.
 *
 * Reuses the Phase-2 in-process harness (`makePhase2Harness`): a REAL started
 * `BrokerService` over its REAL Unix-socket server, a git-backed vault, a
 * migrated workflow store, and the PRODUCTION `buildCaptureDeps` wiring with
 * `scope: "note"` — so every integration goes through the genuine
 * `signAndIntegrateSourceCapture` RPC under the additions-only note scope.
 *
 * Covers:
 *   1. happy path — a schema-valid authored note lands at `<dest>/<basename>`
 *      on canonical, byte-exact, with the result ids bound to the new head;
 *   2. duplicate id vs an existing `notes` projection row — refused, canonical
 *      does NOT advance;
 *   3. invalid frontmatter (missing `id`) — refused BEFORE any mutating dep is
 *      constructed (spy factories prove nothing persisted);
 *   4. a secret in the note body — quarantined + `SecretDetectedError` exit 3,
 *      mutating deps never constructed (mirrors capture.scans-before-persist);
 *   5. idempotent replay — the SAME `--idempotency-key` returns the SAME result
 *      with no second canonical advance; a FRESH key at the same dest is a
 *      duplicate rejection;
 *   6. `deriveDestPath` unit cases — absolute/`..`/`sources/`/`.git`/non-`.md`
 *      refused, nested folders accepted;
 *   7. REGRESSION: same-key replay AFTER the note is visible in the `notes`
 *      projection — the idempotency claim runs BEFORE the collision check, so a
 *      legitimate retry replays instead of failing duplicate-id;
 *   8. REGRESSION (TOCTOU): bytes swapped on disk AFTER normalize()'s clean scan
 *      are re-scanned as the exact persisted buffer — quarantined + exit 3,
 *      nothing reaches canonical.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { probeSandbox } from "@atlas/sources";
import { PrePersistenceGuard, SecretDetectedError, type QuarantineSink, type SecretFinding } from "@atlas/scan";
import { addNote, deriveDestPath, NoteAddRejectedError, type NoteAddResult } from "../src/ingest/note-add.js";
import { buildCaptureDeps } from "../src/ingest/wiring.js";
import type { CaptureDeps } from "../src/ingest/capture.js";
import {
  CANONICAL_REF,
  insertProjectionMarker,
  makePhase2Harness,
  type Phase2Harness,
} from "./e2e/phase2-support.js";

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
 * proved clean. Only the persisted-buffer re-scan (`guard.assertClean` on the
 * `readFileSync` buffer) stands between the swapped-in secret and canonical.
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

/** Production note-add deps against the harness (scope `"note"`), optional pinned key. */
function noteDeps(h: Phase2Harness, idempotencyKey?: string): CaptureDeps {
  return buildCaptureDeps(h.runContext(), "note add", idempotencyKey, "note");
}

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

// ── e2e against the in-process broker (REAL socket, scope "note") ────────────

describeIfSandbox("note add — e2e via the in-process BrokerService (scope \"note\")", () => {
  let h: Phase2Harness;
  beforeEach(async () => {
    h = await makePhase2Harness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it(
    "happy path: a schema-valid authored note lands at <dest>/<basename> on canonical, byte-exact",
    async () => {
      const inbox = join(h.root, "inbox");
      mkdirSync(inbox, { recursive: true });
      const input = join(inbox, "trip-report.md");
      writeFileSync(input, noteText("history-trip-2026", "Trip Report"), "utf8");
      const raw = readFileSync(input);
      const before = h.git(["rev-parse", CANONICAL_REF]);

      const result: NoteAddResult = await addNote({ path: input, dest: "history/2026", guard: cleanGuard(), deps: noteDeps(h) });

      // The result carries the note identity + content identity + the new head.
      expect(result.noteId).toBe("history-trip-2026");
      expect(result.path).toBe("history/2026/trip-report.md");
      expect(result.contentHash).toBe(`sha256:${createHash("sha256").update(raw).digest("hex")}`);
      expect(result.runId).toBeTruthy();

      // Canonical advanced exactly to the reported sha …
      const head = h.git(["rev-parse", CANONICAL_REF]);
      expect(head).not.toBe(before);
      expect(result.canonicalSha).toBe(head);

      // … and the file exists in the CANONICAL TREE with the exact input bytes.
      const shown = execFileSync("git", ["show", `${CANONICAL_REF}:history/2026/trip-report.md`], { cwd: h.vaultDir });
      expect(Buffer.from(shown).equals(raw)).toBe(true);
    },
    60_000,
  );

  it(
    "duplicate id vs an existing note: NoteAddRejectedError(duplicate-id), canonical does NOT advance",
    async () => {
      // Seed an existing `notes` projection row that owns the id.
      const store = h.openStore();
      try {
        insertProjectionMarker(store.db, "history-dup-2026");
      } finally {
        store.close();
      }

      const input = join(h.root, "dup.md");
      writeFileSync(input, noteText("history-dup-2026", "Duplicate"), "utf8");
      const before = h.git(["rev-parse", CANONICAL_REF]);

      const code = await rejectedCode(addNote({ path: input, dest: "history", guard: cleanGuard(), deps: noteDeps(h) }));
      expect(code).toBe("duplicate-id");

      // Canonical did not move.
      expect(h.git(["rev-parse", CANONICAL_REF])).toBe(before);
    },
    60_000,
  );

  it(
    "idempotent replay: the SAME key returns the SAME result without a second advance; a FRESH key at the same dest is a duplicate rejection",
    async () => {
      const input = join(h.root, "replay.md");
      writeFileSync(input, noteText("history-replay-2026", "Replay"), "utf8");
      const key = "note-add-replay-key-1";

      const first = await addNote({ path: input, dest: "history", guard: cleanGuard(), deps: noteDeps(h, key) });
      const headAfterFirst = h.git(["rev-parse", CANONICAL_REF]);
      expect(first.canonicalSha).toBe(headAfterFirst);

      // Same key ⇒ the persisted caller-idempotency layer replays the SAME result …
      const replay = await addNote({ path: input, dest: "history", guard: cleanGuard(), deps: noteDeps(h, key) });
      expect(replay).toEqual(first);
      // … and canonical did NOT advance a second time.
      expect(h.git(["rev-parse", CANONICAL_REF])).toBe(headAfterFirst);

      // A FRESH key with the same content at the same dest is a genuine duplicate.
      const code = await rejectedCode(addNote({ path: input, dest: "history", guard: cleanGuard(), deps: noteDeps(h, "note-add-fresh-key-2") }));
      expect(code).toMatch(/^duplicate-(path|id|identity)$/);
      expect(h.git(["rev-parse", CANONICAL_REF])).toBe(headAfterFirst);
    },
    60_000,
  );

  it(
    "REGRESSION: same-key replay AFTER the note is visible in the projections replays — never duplicate-id",
    async () => {
      const input = join(h.root, "replay-after-visible.md");
      writeFileSync(input, noteText("history-visible-2026", "Visible"), "utf8");
      const key = "note-add-replay-after-visible-1";

      const first = await addNote({ path: input, dest: "history", guard: cleanGuard(), deps: noteDeps(h, key) });
      const headAfterFirst = h.git(["rev-parse", CANONICAL_REF]);
      expect(first.canonicalSha).toBe(headAfterFirst);

      // Make the integrated note VISIBLE to the collision check (as `db rebuild`
      // would): a `notes` projection row now owns the id.
      const store = h.openStore();
      try {
        insertProjectionMarker(store.db, "history-visible-2026");
      } finally {
        store.close();
      }

      // The SAME key must REPLAY the recorded result. The idempotency claim runs
      // BEFORE the collision check, so the now-visible row cannot fail this
      // legitimate retry as duplicate-id (the pre-fix order threw here).
      const replay = await addNote({ path: input, dest: "history", guard: cleanGuard(), deps: noteDeps(h, key) });
      expect(replay).toEqual(first);
      // … and canonical did NOT advance a second time.
      expect(h.git(["rev-parse", CANONICAL_REF])).toBe(headAfterFirst);
    },
    60_000,
  );
});

// ── preflight refusals (spy deps prove NOTHING was persisted) ────────────────

describeIfSandbox("note add — preflight refusals persist NOTHING (spy mutating deps)", () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "atlas-note-add-pre-"));
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  /** Spy deps: any touch of a mutating dep before the preflight clears is a failure. */
  function spyDeps(): { deps: CaptureDeps; calls: () => { openStore: number; connectIntegration: number } } {
    let openStoreCalls = 0;
    let connectIntegrationCalls = 0;
    const deps = {
      openStore: () => {
        openStoreCalls++;
        throw new Error("openStore must NOT be called for a refused note (preflight-before-persist)");
      },
      connectIntegration: () => {
        connectIntegrationCalls++;
        throw new Error("connectIntegration must NOT be called for a refused note");
      },
      repo: {} as CaptureDeps["repo"],
      backup: {} as CaptureDeps["backup"],
      worktreesPath: join(base, "worktrees"),
      command: "note add",
    } as unknown as CaptureDeps;
    return { deps, calls: () => ({ openStore: openStoreCalls, connectIntegration: connectIntegrationCalls }) };
  }

  it("invalid frontmatter (missing id): rejected, mutating deps never constructed, nothing on disk", async () => {
    const input = join(base, "no-id.md");
    writeFileSync(
      input,
      ["---", "type: history", "schema_version: 1", "title: No Id", "created: 2026-07-19", "updated: 2026-07-19", "---", "# No Id", ""].join("\n"),
      "utf8",
    );
    const { deps, calls } = spyDeps();

    const code = await rejectedCode(addNote({ path: input, dest: "history", guard: cleanGuard(), deps }));
    expect(code).toBe("invalid-frontmatter");

    // The mutating deps were never even CONSTRUCTED — the strongest no-persistence proof.
    expect(calls()).toEqual({ openStore: 0, connectIntegration: 0 });
    const worktreeLeftovers = existsSync(join(base, "worktrees")) ? readdirSync(join(base, "worktrees")) : [];
    expect(worktreeLeftovers).toEqual([]);
  });

  it("a secret in the note body: quarantined, SecretDetectedError exit 3, mutating deps never constructed", async () => {
    // A live-format AWS key assembled at runtime (never a committed literal — the repo is public).
    const secret = "AKIA" + "A".repeat(16);
    const input = join(base, "leaky-note.md");
    writeFileSync(input, noteText("history-leaky-2026", "Leaky", `embedded credential: ${secret}`), "utf8");
    const { deps, calls } = spyDeps();
    const sink = new RecordingSink();
    const guard = new PrePersistenceGuard(sink);

    let thrown: unknown;
    let result: unknown;
    try {
      result = await addNote({ path: input, dest: "history", guard, deps });
    } catch (e) {
      thrown = e;
    }

    // 1. No result, and the exit-3 secret refusal.
    expect(result).toBeUndefined();
    expect(thrown).toBeInstanceOf(SecretDetectedError);
    expect((thrown as SecretDetectedError).exitCode).toBe(3);

    // 2. The offending bytes WERE quarantined (quarantine-before-throw).
    expect(sink.entries.length).toBeGreaterThanOrEqual(1);
    expect(sink.entries[0]!.origin).toBe(input);
    expect(sink.entries[0]!.findings.length).toBeGreaterThanOrEqual(1);

    // 3. THE INVARIANT: no mutating dependency was ever constructed — nothing landed
    //    on canonical or any other sink.
    expect(calls()).toEqual({ openStore: 0, connectIntegration: 0 });
    const worktreeLeftovers = existsSync(join(base, "worktrees")) ? readdirSync(join(base, "worktrees")) : [];
    expect(worktreeLeftovers).toEqual([]);
  });

  it("REGRESSION (TOCTOU): a secret swapped in AFTER normalize()'s clean scan is caught on the persisted buffer", async () => {
    // A live-format AWS key assembled at runtime (never a committed literal — the repo is public).
    const secret = "AKIA" + "A".repeat(16);
    const input = join(base, "toctou-note.md");
    // CLEAN at normalize() time — its raw + normalized scans both pass.
    writeFileSync(input, noteText("history-toctou-2026", "Toctou"), "utf8");
    const { deps, calls } = spyDeps();
    const sink = new RecordingSink();
    const guard = new RewriteAfterFirstScanGuard(sink, () => {
      // The attacker's mid-flight rewrite: normalize() has already proven the
      // ORIGINAL bytes clean; the file carries a secret when addNote reads the
      // bytes it will actually persist.
      writeFileSync(input, noteText("history-toctou-2026", "Toctou", `swapped-in credential: ${secret}`), "utf8");
    });

    let thrown: unknown;
    let result: unknown;
    try {
      result = await addNote({ path: input, dest: "history", guard, deps });
    } catch (e) {
      thrown = e;
    }

    // 1. The persisted-buffer scan refused the swapped bytes with exit-3 semantics.
    expect(result).toBeUndefined();
    expect(thrown).toBeInstanceOf(SecretDetectedError);
    expect((thrown as SecretDetectedError).exitCode).toBe(3);

    // 2. What was quarantined is the POISONED persisted buffer, not the clean original.
    expect(sink.entries.length).toBeGreaterThanOrEqual(1);
    const q = sink.entries[sink.entries.length - 1]!;
    expect(q.origin).toBe(input);
    expect(q.findings.length).toBeGreaterThanOrEqual(1);
    expect(Buffer.from(q.bytes).toString("utf8")).toContain(secret);

    // 3. Nothing landed anywhere: no mutating dep was ever constructed.
    expect(calls()).toEqual({ openStore: 0, connectIntegration: 0 });
    const worktreeLeftovers = existsSync(join(base, "worktrees")) ? readdirSync(join(base, "worktrees")) : [];
    expect(worktreeLeftovers).toEqual([]);
  });
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

  it("rejects the sources/ capture-only namespace", () => {
    expect(codeOf(() => deriveDestPath("sources", MD))).toBe("bad-dest");
    expect(codeOf(() => deriveDestPath("sources/sub", MD))).toBe("bad-dest");
  });

  it("rejects any .git segment", () => {
    expect(codeOf(() => deriveDestPath(".git", MD))).toBe("bad-dest");
    expect(codeOf(() => deriveDestPath("notes/.git", MD))).toBe("bad-dest");
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
