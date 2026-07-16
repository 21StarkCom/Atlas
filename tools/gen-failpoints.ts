/**
 * `gen-failpoints` (Task 4.11) — the crash-recovery FAILPOINT generator. Derives the exhaustive
 * failpoint matrix DETERMINISTICALLY from the machine-readable `stateTable`
 * (`recovery-state-machine.md`): a crash BEFORE and AFTER the atomic write of every progression
 * checkpoint, and a crash mid-write of every terminal record (base + `failed@`/`cancelled@`
 * suffixed). Each failpoint carries the row's recovery contract (idempotency anchor, recovery
 * action, retained artifacts, worktree cleanup) so `crash-recovery.failpoints.test.ts` can assert
 * the contract is fully specified at every failpoint and drive the reconciler against it.
 *
 * `--write` regenerates the committed matrix doc; `--check` fails if it drifted (same
 * generate-then-verify discipline as `gen-cli-contract.ts`).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  findRepoRoot,
  loadStateTable,
  RECOVERY_CHECKPOINTS,
  RECOVERY_TERMINALS,
  FAILABLE_CHECKPOINTS,
  type StateTable,
  type StateTableEntry,
} from "./cli-contract.ts";

/** The generated failpoints doc (committed, regenerated, `--check`ed in CI). */
export const FAILPOINTS_DOC_PATH = "docs/specs/cli-contract/failpoints.generated.md";

/** Where in a state's lifecycle the crash is injected. */
export type FailpointPhase = "before-write" | "after-write" | "terminal-write";

/** One generated failpoint: a crash site + the recovery contract the reconciler must honor. */
export interface Failpoint {
  /** Stable id, e.g. `planned@before-write` / `failed@planned@terminal-write`. */
  readonly id: string;
  readonly state: string;
  readonly kind: "checkpoint" | "terminal";
  readonly phase: FailpointPhase;
  /** The atomic write the crash straddles (verbatim from the stateTable). */
  readonly atomicWrite: string;
  /** The idempotency anchor a replay keys on (verbatim). */
  readonly idempotencyCheck: string;
  /** The contract recovery action (verbatim). */
  readonly recoveryAction: string;
  /** Artifacts that MUST survive the crash. */
  readonly retainedArtifacts: readonly string[];
  /** The worktree-cleanup obligation. */
  readonly worktreeCleanup: string;
  /** The terminal/checkpoint audit event, if any. */
  readonly auditEmission: string | null;
  /** The states recovery may advance to (checkpoints) or `[]` (terminals). */
  readonly nextStates: readonly string[];
  /** The derived expected recovery outcome for this crash site. */
  readonly expectedRecovery: string;
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}
function nonEmptyArray(v: unknown): v is unknown[] {
  return Array.isArray(v) && v.length > 0;
}

/**
 * Assert a stateTable row fully specifies its recovery contract — a row missing any field would
 * emit an invalid (unrecoverable) failpoint, so the generator refuses it (the load-bearing gate).
 */
function assertRecoveryContract(s: StateTableEntry): void {
  const missing: string[] = [];
  if (!nonEmptyString(s.atomicWrite)) missing.push("atomicWrite");
  if (!nonEmptyString(s.idempotencyCheck)) missing.push("idempotencyCheck");
  if (!nonEmptyString(s.recoveryAction)) missing.push("recoveryAction");
  if (!nonEmptyArray(s.retainedArtifacts)) missing.push("retainedArtifacts");
  if (!nonEmptyString(s.worktreeCleanup)) missing.push("worktreeCleanup");
  // auditEmission is OPTIONAL: only `planned`/`integrated` checkpoints emit a run.* event;
  // the others advance silently (D6 — intermediate checkpoints carry no audit event).
  if (s.kind === "checkpoint" && !nonEmptyArray(s.nextStates)) missing.push("nextStates");
  if (missing.length > 0) {
    throw new Error(`stateTable row "${s.state}" cannot generate a failpoint — missing recovery contract field(s): ${missing.join(", ")}`);
  }
}

function base(s: StateTableEntry, phase: FailpointPhase, id: string, expectedRecovery: string): Failpoint {
  return {
    id,
    state: s.state,
    kind: s.kind,
    phase,
    atomicWrite: s.atomicWrite as string,
    idempotencyCheck: s.idempotencyCheck as string,
    recoveryAction: s.recoveryAction as string,
    retainedArtifacts: s.retainedArtifacts as string[],
    worktreeCleanup: s.worktreeCleanup as string,
    auditEmission: (s.auditEmission as string | undefined) ?? null,
    nextStates: (s.nextStates as string[] | undefined) ?? [],
    expectedRecovery,
  };
}

/**
 * Generate the failpoint matrix from a parsed `stateTable`. Two failpoints per checkpoint (crash
 * before + after its atomic write) and one per terminal (crash mid-§2.8 write); each is validated
 * to carry a complete recovery contract first.
 */
export function generateFailpoints(table: StateTable): Failpoint[] {
  const out: Failpoint[] = [];
  for (const s of table.states) {
    assertRecoveryContract(s);
    if (s.kind === "checkpoint") {
      out.push(
        base(
          s,
          "before-write",
          `${s.state}@before-write`,
          `no durable write yet — recovery re-derives and idempotently retries the atomic write, keyed on: ${s.idempotencyCheck}`,
        ),
        base(
          s,
          "after-write",
          `${s.state}@after-write`,
          `checkpoint durable — recovery detects it (${s.idempotencyCheck}) and advances to one of [${(s.nextStates as string[]).join(", ")}] per: ${s.recoveryAction}`,
        ),
      );
    } else {
      out.push(base(s, "terminal-write", `${s.state}@terminal-write`, s.recoveryAction as string));
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** The number of failpoints a well-formed stateTable must yield (the completeness expectation). */
export function expectedFailpointCount(): number {
  // 2 per progression checkpoint + 1 per base terminal + 1 per failed@/cancelled@ suffixed terminal.
  return RECOVERY_CHECKPOINTS.length * 2 + RECOVERY_TERMINALS.length + FAILABLE_CHECKPOINTS.length * 2;
}

/** Render the committed matrix doc. */
export function renderFailpointsDoc(fps: readonly Failpoint[]): string {
  const rows = fps
    .map(
      (f) =>
        `| \`${f.id}\` | ${f.state} | ${f.kind} | ${f.phase} | ${f.auditEmission ?? "—"} | ${f.retainedArtifacts.length} | ${f.expectedRecovery.replace(/\|/g, "\\|")} |`,
    )
    .join("\n");
  return `<!-- GENERATED by tools/gen-failpoints.ts — do not edit; run \`node tools/gen-failpoints.ts --write\`. -->
# Crash-recovery failpoint matrix (Task 4.11)

Generated from the machine-readable \`stateTable\` in [\`recovery-state-machine.md\`](../recovery-state-machine.md).
Every progression checkpoint contributes a crash BEFORE and AFTER its atomic write; every terminal
(base + \`failed@\`/\`cancelled@\` suffixed) contributes a mid-write crash. ${fps.length} failpoints.

| Failpoint | State | Kind | Phase | Audit | Retained | Expected recovery |
|-----------|-------|------|-------|-------|----------|-------------------|
${rows}
`;
}

function readIfExists(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function main(argv: string[]): number {
  const wantCheck = argv.includes("--check");
  const wantWrite = argv.includes("--write");
  if (wantCheck === wantWrite) {
    process.stderr.write("usage: gen-failpoints.ts (--check | --write)\n");
    return 5;
  }
  const root = findRepoRoot();
  const fps = generateFailpoints(loadStateTable(root));
  const expected = renderFailpointsDoc(fps);
  const docPath = join(root, FAILPOINTS_DOC_PATH);

  if (wantWrite) {
    writeFileSync(docPath, expected, "utf8");
    process.stdout.write(`wrote ${FAILPOINTS_DOC_PATH} (${fps.length} failpoints)\n`);
    return 0;
  }
  const actual = readIfExists(docPath);
  if (actual !== expected) {
    process.stderr.write(`derived file drift: ${FAILPOINTS_DOC_PATH} is out of date — run \`node tools/gen-failpoints.ts --write\`\n`);
    return 1;
  }
  process.stdout.write("failpoint matrix check: clean\n");
  return 0;
}

// Run as a CLI only when invoked directly (importable for tests without side effects).
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
