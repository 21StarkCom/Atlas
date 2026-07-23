/**
 * `brain link <source> <target> [--predicate <p>] [--alias <a>] [--remove]` —
 * the one NEW v2 command (#331): add, re-alias, or remove an edge between two
 * notes, fronting the two ChangePlan link ops through the canonical mutation
 * order (`runMutation` → `commitPaths` onto `refs/heads/main` → fold).
 *
 * Two edge kinds, one selector rule (spec §interfaces "link (NEW)"):
 *   - **SetLink** (no `--predicate`) — a plain `[[wiki-link]]` living in the
 *     source note's BODY. Add appends `[[target]]`/`[[target|alias]]` to the
 *     canonical `## Links` section (created at the end when absent); remove
 *     strips EVERY body occurrence that resolves to the target.
 *   - **CreateRelationship** (`--predicate`) — a typed edge living in the source
 *     note's frontmatter `related:` list (markdown-derived, model A) as
 *     `{target, predicate, alias?}`.
 *
 * Both kinds are markdown-authored: every non-noop outcome edits the source
 * note and lands EXACTLY ONE commit (`commit` null IFF `noop` — machine-enforced
 * by link.schema.json). Classification reads the projection `note_links` edge
 * set, whose two partial UNIQUE indexes (`ux_note_links_plain` /
 * `ux_note_links_pred`) are the physical mirror of the `@atlas/contracts`
 * identity-key resolution used here — never a second local derivation.
 *
 * Binding behavior (spec §behavior "link behavior"):
 *   - `--alias` + `--remove` ⇒ exit 5 (usage), BEFORE grounding.
 *   - Grounding: <source>/<target> resolve via the shared tiered id → slug →
 *     declared-alias precedence (`resolveNoteId`); unknown ⇒ exit 1. BOTH notes
 *     must be clean (the dirty-vault two-condition test) — checked before any
 *     noop classification, because a noop verdict is only meaningful against a
 *     projection that agrees with the markdown.
 *   - The noop set is EXACTLY: duplicate-identical add, aliasless re-add of an
 *     existing edge (an omitted `--alias` preserves the stored alias — never
 *     clobbers), and absent-edge remove. Every noop: `action:"noop"`,
 *     `commit:null`, exit 0, NO git write, NO projection write (short-circuits
 *     before `runMutation`).
 *   - An alias CHANGE on an existing edge is `action:"updated"` — one in-place
 *     mutation, one commit, never a new edge.
 *   - `--remove` with `--predicate p` removes exactly that typed edge (the plain
 *     link and other predicates survive); without, only the plain (NULL-predicate)
 *     edge.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openRepo } from "@atlas/git";
import { foldNotesV2, type Store } from "@atlas/sqlite-store";
import type { ParsedNote } from "@atlas/contracts";
import { parseDocument } from "yaml";
import { normalizeIdentityKey } from "../vault/identity.js";
import { CliError, EXIT, emitJson } from "../errors/envelope.js";
import { registerCommand, type RunContext } from "../handlers.js";
import { assertNotDirty, runMutation, CANONICAL_BRANCH, type Grounded } from "../workflows/mutation-order.js";
import { resolveAtRef } from "../sync/resolve-at-ref.js";
import { splitFrontmatter, WIKILINK_RE } from "../markdown/parse.js";
import { openingFence, isClosingFence, type OpenFence } from "../markdown/fence.js";
import { resolvePath } from "./backup-config.js";
import { openMigratedStore } from "./store-open.js";
import { resolveNoteId, loadVaultSnapshot } from "./note.js";

type LinkAction = "added" | "updated" | "removed" | "related" | "noop";

/** The `link --json` success envelope (mirrors link.schema.json). */
export interface LinkEnvelope {
  readonly command: "link";
  readonly action: LinkAction;
  readonly source: string;
  readonly target: string;
  readonly predicate: string | null;
  readonly alias: string | null;
  readonly commit: string | null;
  readonly noop: boolean;
}

interface LinkArgs {
  readonly source: string;
  readonly target: string;
  readonly predicate: string | undefined;
  readonly alias: string | undefined;
  readonly remove: boolean;
}

/** Parse argv; every refusal here is exit 5 (usage), evaluated BEFORE grounding. */
export function parseLinkArgs(argv: readonly string[]): LinkArgs {
  let source: string | undefined;
  let target: string | undefined;
  let predicate: string | undefined;
  let alias: string | undefined;
  let remove = false;

  const valued = (name: "--predicate" | "--alias", inline: string | undefined, next: () => string | undefined): string => {
    const v = inline !== undefined ? inline : next();
    if (v === undefined || v.length === 0) throw CliError.usage(`\`link\`: ${name} requires a non-empty value`);
    return v;
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--predicate" || a.startsWith("--predicate=")) {
      predicate = valued("--predicate", a.startsWith("--predicate=") ? a.slice("--predicate=".length) : undefined, () => argv[++i]);
    } else if (a === "--alias" || a.startsWith("--alias=")) {
      alias = valued("--alias", a.startsWith("--alias=") ? a.slice("--alias=".length) : undefined, () => argv[++i]);
    } else if (a === "--remove") {
      remove = true;
    } else if (a.startsWith("-")) {
      throw CliError.usage(`\`link\`: unknown flag ${a}`);
    } else if (source === undefined) {
      source = a;
    } else if (target === undefined) {
      target = a;
    } else {
      throw CliError.usage(`\`link\`: unexpected argument ${a}`);
    }
  }
  if (source === undefined || target === undefined) {
    throw CliError.usage("`link` requires <source> and <target> note arguments");
  }
  // The one binding flag conflict: an alias is meaningful only on add.
  if (alias !== undefined && remove) {
    throw CliError.usage("`link`: --alias and --remove are mutually exclusive (an alias is meaningful only on add)");
  }
  return { source, target, predicate, alias, remove };
}

/**
 * Resolve a raw link/relationship target spelling against the CURRENT projection
 * — exact note id first, then the `@atlas/contracts` normalized identity key
 * (slug/alias). Byte-identical to the fold's `resolveLinkTarget`, so what the
 * surgery matches is exactly what the projection derives.
 */
function resolveRawTarget(store: Store, raw: string): string | undefined {
  const asId = store.db.prepare(`SELECT note_id FROM notes WHERE note_id = ?`).get(raw) as
    | { note_id: string }
    | undefined;
  if (asId !== undefined) return asId.note_id;
  const row = store.db
    .prepare(`SELECT note_id FROM note_identity_keys WHERE normalized_key = ?`)
    .get(normalizeIdentityKey(raw)) as { note_id: string } | undefined;
  return row?.note_id;
}

/** The projected vault-relative path of a resolved note (grounding binds to it). */
function notePath(store: Store, noteId: string): string {
  const row = store.db.prepare(`SELECT file_path FROM notes WHERE note_id = ?`).get(noteId) as
    | { file_path: string }
    | undefined;
  if (row === undefined) {
    throw new CliError({
      code: "note-not-found",
      message: `\`link\`: note "${noteId}" is not in the projection`,
      hint: "The note exists in the vault but is not projected yet; run `brain sync` first.",
      exitCode: EXIT.VALIDATION,
    });
  }
  return row.file_path;
}

/** The current edge for the selector `(source, target, predicate?)`, or undefined. */
function readEdge(store: Store, sourceId: string, targetId: string, predicate: string | null): { alias: string | null } | undefined {
  return predicate === null
    ? (store.db
        .prepare(`SELECT alias FROM note_links WHERE source_note_id = ? AND target_note_id = ? AND predicate IS NULL`)
        .get(sourceId, targetId) as { alias: string | null } | undefined)
    : (store.db
        .prepare(`SELECT alias FROM note_links WHERE source_note_id = ? AND target_note_id = ? AND predicate = ?`)
        .get(sourceId, targetId, predicate) as { alias: string | null } | undefined);
}

/**
 * Classify the outcome against the current edge (spec §behavior, BINDING).
 * The noop set is exactly: duplicate-identical add + aliasless re-add of an
 * existing edge + absent-edge remove.
 */
function classify(args: LinkArgs, edge: { alias: string | null } | undefined): LinkAction {
  if (args.remove) return edge === undefined ? "noop" : "removed";
  if (edge === undefined) return args.predicate !== undefined ? "related" : "added";
  if (args.alias === undefined) return "noop"; // omitted --alias preserves the stored alias — never clobbers
  return args.alias === edge.alias ? "noop" : "updated";
}

// ---------------------------------------------------------------------------
// Markdown surgery — body (plain SetLink) + frontmatter `related` (typed)
// ---------------------------------------------------------------------------

const LINKS_HEADING_RE = /^##\s+Links\s*$/;
const ANY_HEADING_RE = /^#{1,6}\s/;
/** A list line whose only content was the removed link — dropped whole. */
const EMPTY_BULLET_RE = /^\s*[-*+]\s*$/;

/** The inline-code span ranges of one line (CommonMark N-backtick pairing) —
 * mirrors the extractor's `stripInlineCode` so surgery never edits a link the
 * parser does not extract. */
function inlineCodeRanges(line: string): [number, number][] {
  const ranges: [number, number][] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] !== "`") {
      i++;
      continue;
    }
    let open = i;
    while (line[open] === "`") open++;
    const runLen = open - i;
    let k = open;
    let closeEnd = -1;
    while (k < line.length) {
      if (line[k] !== "`") {
        k++;
        continue;
      }
      let run = k;
      while (line[run] === "`") run++;
      if (run - k === runLen) {
        closeEnd = run;
        break;
      }
      k = run;
    }
    if (closeEnd === -1) {
      i = open; // unclosed run: literal backticks, keep scanning after them
      continue;
    }
    ranges.push([i, closeEnd]);
    i = closeEnd;
  }
  return ranges;
}

/** Append a wiki-link bullet to the canonical `## Links` section (created at the
 * end of the body when absent). */
function appendPlainLink(body: string, wikilink: string): string {
  const lines = body.split("\n");
  const headingIdx = lines.findIndex((l) => LINKS_HEADING_RE.test(l));
  if (headingIdx === -1) {
    const trimmed = body.replace(/\n+$/, "");
    return `${trimmed}\n\n## Links\n\n- ${wikilink}\n`;
  }
  let end = lines.length;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (ANY_HEADING_RE.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  let insertAt = end;
  while (insertAt > headingIdx + 1 && lines[insertAt - 1]!.trim() === "") insertAt--;
  lines.splice(insertAt, 0, `- ${wikilink}`);
  return lines.join("\n");
}

/**
 * Rewrite every PLAIN body occurrence resolving to the target: `remove` strips
 * it (a bullet line left empty is dropped whole); `realias` swaps the display
 * alias in place, keeping the author's raw target spelling. Fenced code blocks
 * and inline code spans are skipped — exactly the occurrences the extractor
 * ignores.
 */
function transformPlainLinks(
  body: string,
  matchesTarget: (raw: string) => boolean,
  mode: { kind: "remove" } | { kind: "realias"; alias: string },
): string {
  const lines = body.split("\n");
  const out: string[] = [];
  let fence: OpenFence | null = null;
  for (const line of lines) {
    if (fence !== null) {
      if (isClosingFence(line, fence)) fence = null;
      out.push(line);
      continue;
    }
    const open = openingFence(line);
    if (open) {
      fence = open;
      out.push(line);
      continue;
    }
    const ranges = inlineCodeRanges(line);
    const inCode = (idx: number): boolean => ranges.some(([s, e]) => idx >= s && idx < e);
    const next = line.replace(WIKILINK_RE, (match: string, target: string, _alias: string | undefined, offset: number) => {
      if (inCode(offset) || !matchesTarget(target.trim())) return match;
      return mode.kind === "remove" ? "" : `[[${target.trim()}|${mode.alias}]]`;
    });
    if (mode.kind === "remove" && next !== line && EMPTY_BULLET_RE.test(next)) continue;
    out.push(next);
  }
  return out.join("\n");
}

/** One `related:` frontmatter entry as authored (reader-validated shape, but
 * surgery guards against hand-authored drift anyway). */
interface RelatedEntry {
  readonly target?: unknown;
  readonly predicate?: unknown;
  readonly alias?: unknown;
}

/**
 * Frontmatter surgery for the typed (`CreateRelationship`) form, via the yaml
 * Document API so untouched frontmatter (ordering, comments, quoting) survives
 * byte-faithfully. `add` appends `{target, predicate, alias?}` (targets are
 * written as the RESOLVED note id — stable across renames); `realias` updates
 * the first matching entry in place; `remove` deletes every matching entry and
 * drops an emptied `related:` key entirely.
 */
function transformRelated(
  frontmatterYaml: string,
  store: Store,
  targetId: string,
  predicate: string,
  mode: { kind: "add"; alias: string | undefined } | { kind: "realias"; alias: string } | { kind: "remove" },
): string {
  const doc = parseDocument(frontmatterYaml);
  const js = doc.toJS() as { related?: unknown } | null;
  const list: RelatedEntry[] = Array.isArray(js?.related) ? (js.related as RelatedEntry[]) : [];
  const matches = (e: RelatedEntry): boolean =>
    typeof e?.target === "string" &&
    e.predicate === predicate &&
    resolveRawTarget(store, e.target) === targetId;

  if (mode.kind === "add") {
    const entry = { target: targetId, predicate, ...(mode.alias !== undefined ? { alias: mode.alias } : {}) };
    if (js?.related === undefined) doc.set("related", [entry]);
    else doc.addIn(["related"], entry);
  } else if (mode.kind === "realias") {
    const idx = list.findIndex(matches);
    if (idx === -1) throw surgeryDrift(targetId, predicate);
    doc.setIn(["related", idx, "alias"], mode.alias);
  } else {
    const idxs = list.map((e, i) => (matches(e) ? i : -1)).filter((i) => i !== -1);
    if (idxs.length === 0) throw surgeryDrift(targetId, predicate);
    for (const i of idxs.reverse()) doc.deleteIn(["related", i]);
    const after = (doc.toJS() as { related?: unknown } | null)?.related;
    if (Array.isArray(after) && after.length === 0) doc.delete("related");
  }
  return doc.toString();
}

/** The projection said the edge exists but the (clean) markdown disagrees —
 * a fold/projection bug, never user error. */
function surgeryDrift(targetId: string, predicate: string | null): CliError {
  return new CliError({
    code: "internal",
    message: `\`link\`: the projection has the edge (target ${targetId}, predicate ${predicate ?? "NULL"}) but the source markdown carries no matching occurrence`,
    hint: "The projection disagrees with a clean note — run `brain db rebuild` and retry.",
    exitCode: EXIT.INTERNAL,
  });
}

/** Apply the classified surgery to the source note's full text. */
function transformNote(
  text: string,
  store: Store,
  action: Exclude<LinkAction, "noop">,
  args: LinkArgs,
  targetId: string,
): string {
  const { frontmatter, body } = splitFrontmatter(text);
  if (frontmatter === null) {
    throw new CliError({
      code: "internal",
      message: "`link`: the projected source note has no frontmatter block",
      exitCode: EXIT.INTERNAL,
    });
  }
  const reassemble = (fm: string, b: string): string => `---\n${fm}---\n${b}`;

  if (args.predicate !== undefined) {
    // Typed form: all surgery lives in the frontmatter `related:` list.
    const mode =
      action === "related"
        ? ({ kind: "add", alias: args.alias } as const)
        : action === "updated"
          ? ({ kind: "realias", alias: args.alias! } as const)
          : ({ kind: "remove" } as const);
    return reassemble(transformRelated(frontmatter, store, targetId, args.predicate, mode), body);
  }

  // Plain form: all surgery lives in the body.
  if (action === "added") {
    const wikilink = args.alias !== undefined ? `[[${targetId}|${args.alias}]]` : `[[${targetId}]]`;
    return reassemble(frontmatter, appendPlainLink(body, wikilink));
  }
  const matchesTarget = (raw: string): boolean => resolveRawTarget(store, raw) === targetId;
  const nextBody = transformPlainLinks(
    body,
    matchesTarget,
    action === "updated" ? { kind: "realias", alias: args.alias! } : { kind: "remove" },
  );
  if (nextBody === body) throw surgeryDrift(targetId, null);
  return reassemble(frontmatter, nextBody);
}

function commitMessageFor(action: Exclude<LinkAction, "noop">, sourceId: string, targetId: string, predicate: string | undefined): string {
  const edge = predicate === undefined ? `${sourceId} -> ${targetId}` : `${sourceId} -[${predicate}]-> ${targetId}`;
  switch (action) {
    case "added":
    case "related":
      return `link add ${edge}`;
    case "updated":
      return `link alias ${edge}`;
    case "removed":
      return `link remove ${edge}`;
  }
}

function renderLink(ctx: RunContext, env: LinkEnvelope): void {
  if (ctx.output.mode === "json") {
    emitJson(env);
    return;
  }
  const pred = env.predicate === null ? "" : ` [${env.predicate}]`;
  ctx.render(
    env.noop
      ? `link: noop — ${env.source} -> ${env.target}${pred} already matches (no commit)`
      : `link: ${env.action}${pred} ${env.source} -> ${env.target} @ ${env.commit!.slice(0, 12)}`,
  );
}

async function link(ctx: RunContext): Promise<number> {
  const args = parseLinkArgs(ctx.argv); // every flag refusal (incl. --alias+--remove) exits 5 HERE, before grounding
  const cfg = ctx.config.config;
  const vaultPath = resolvePath(ctx, cfg.vault.path);
  const repo = openRepo(vaultPath);
  const store = openMigratedStore(ctx);
  try {
    // Grounding (read-only): resolve both seeds through the SHARED tiered
    // id → slug → declared-alias precedence; unknown either ⇒ exit 1.
    let notesPromise: Promise<readonly ParsedNote[]> | undefined;
    const lazyNotes = (): Promise<readonly ParsedNote[]> =>
      (notesPromise ??= loadVaultSnapshot("link", ctx).then((s) => s.notes));
    const sourceId = await resolveNoteId("link", store.db, args.source, lazyNotes);
    const targetId = await resolveNoteId("link", store.db, args.target, lazyNotes);
    const sourcePath = notePath(store, sourceId);
    const targetPath = notePath(store, targetId);

    // Dirty-vault gate BEFORE noop classification (spec: the noop paths apply
    // ONLY to grounded, CLEAN, existing notes): the source because it is
    // rewritten, the target because grounding binds the edge to its projected
    // identity. runMutation re-runs the same gate under the lock.
    const dirtyCheckPaths = [...new Set([sourcePath, targetPath])];
    await assertNotDirty({ repo, vaultPath, store }, dirtyCheckPaths);

    const predicate = args.predicate ?? null;
    const action = classify(args, readEdge(store, sourceId, targetId, predicate));
    const envelope = (commit: string | null): LinkEnvelope => ({
      command: "link",
      action: commit === null ? "noop" : action,
      source: sourceId,
      target: targetId,
      predicate,
      alias: args.alias ?? null,
      commit,
      noop: commit === null,
    });

    if (action === "noop") {
      // Idempotent short-circuit: NO git write, NO projection write — return
      // before runMutation (which refuses an empty touched-path set anyway).
      renderLink(ctx, envelope(null));
      return EXIT.OK;
    }

    const result = await runMutation<LinkEnvelope>({
      ctx,
      repo,
      vaultPath,
      store,
      ground(preApply): Grounded {
        // Surgery is computed from the CURRENT bytes inside the lock.
        const abs = join(vaultPath, sourcePath);
        const next = transformNote(readFileSync(abs, "utf8"), store, action, args, targetId);
        preApply();
        return {
          touchedPaths: [sourcePath],
          commitMessage: commitMessageFor(action, sourceId, targetId, args.predicate),
          affectedNoteIds: [sourceId],
          dirtyCheckPaths,
          apply(): void {
            writeFileSync(abs, next, "utf8");
          },
        };
      },
      async refreshProjection(): Promise<void> {
        // Re-fold the source note from the just-committed canonical blob: the
        // fold re-derives BOTH link kinds from the markdown (model A). No
        // LanceDB refresh — a link edit never re-embeds.
        foldNotesV2(store, [sourceId], resolveAtRef(repo, CANONICAL_BRANCH, cfg.vault.note_globs));
        await Promise.resolve();
      },
      buildResult(commitSha): LinkEnvelope {
        return envelope(commitSha);
      },
    });
    renderLink(ctx, result);
    return EXIT.OK;
  } finally {
    store.close();
  }
}

registerCommand("link", link);

export { link, classify, appendPlainLink, transformPlainLinks };
