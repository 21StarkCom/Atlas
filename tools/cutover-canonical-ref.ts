#!/usr/bin/env node
/**
 * `tools/cutover-canonical-ref.ts` — the ONE-SHOT live-vault ref convergence for
 * the v2 canonical-ref fold-out (task 3-3b, #325). GATE-EXEMPT: it is the sole
 * source file permitted to name the legacy `refs/atlas/main` canonical ref, and
 * it is NOT wired into CI. It is retained through Phase 4 and EXECUTED once at the
 * Phase-5 preflight (task 3), then deleted.
 *
 * Before v2, an adopted vault kept its Atlas projection on a broker-owned
 * `refs/atlas/main` distinct from the working branch `refs/heads/main`. v2 commits
 * directly onto `refs/heads/main` (no indirection), so a real adopted vault must
 * first converge: fast-forward `refs/heads/main` up to the `refs/atlas/main` tip
 * (the authoritative Atlas history), update the working tree, and leave HEAD on
 * `refs/heads/main`. On a fresh vault born on `main` there is no `refs/atlas/main`,
 * so this is a NO-OP (exit 0, main unmoved, HEAD == main) — which is exactly the
 * fixture the acceptance harness probes.
 *
 * Deliberately standalone (shells `git` via `node:child_process`, no workspace
 * imports) so it runs under `node --experimental-strip-types` with no build step.
 *
 *   node --experimental-strip-types tools/cutover-canonical-ref.ts <vault-path>
 */
import { execFileSync } from "node:child_process";

const LEGACY_CANONICAL = "refs/atlas/main";
const MAIN = "refs/heads/main";

function git(dir: string, args: readonly string[]): string {
  return execFileSync("git", ["--literal-pathspecs", ...args], { cwd: dir, encoding: "utf8" }).trim();
}

/** Resolve a ref/commit-ish to its SHA, or null when it does not resolve. */
function revParse(dir: string, ref: string): string | null {
  try {
    return git(dir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  } catch {
    return null;
  }
}

/** True iff `ancestor` is an ancestor of (or equal to) `descendant`. */
function isAncestor(dir: string, ancestor: string, descendant: string): boolean {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], { cwd: dir });
    return true;
  } catch {
    return false;
  }
}

function fail(msg: string): never {
  process.stderr.write(`cutover-canonical-ref: ${msg}\n`);
  process.exit(1);
}

function main(): void {
  const dir = process.argv[2];
  if (dir === undefined || dir === "") fail("usage: cutover-canonical-ref.ts <vault-path>");

  // The vault must be checked out on main — a feature-branch/detached checkout is
  // never mutated (the same HEAD-guard the mutation order enforces).
  let head: string;
  try {
    head = git(dir, ["rev-parse", "--symbolic-full-name", "HEAD"]);
  } catch {
    fail(`not a git repository (or unreadable HEAD): ${dir}`);
  }
  if (head !== MAIN) fail(`HEAD is ${head === "HEAD" ? "detached" : head}, not ${MAIN}; check out main before the cutover`);

  // The vault must be clean — the cutover fast-forwards the working tree.
  const status = git(dir, ["status", "--porcelain=v1"]);
  if (status !== "") fail("vault working tree is dirty; commit or discard changes before the cutover");

  const legacy = revParse(dir, LEGACY_CANONICAL);
  const mainSha = revParse(dir, MAIN);

  // NO-OP: a fresh vault born on main has no legacy canonical ref — nothing to
  // converge. Also a no-op when the two already point at the same commit.
  if (legacy === null || legacy === mainSha) {
    process.stdout.write(`cutover: no-op (${legacy === null ? `no ${LEGACY_CANONICAL}` : "already converged"})\n`);
    process.exit(0);
  }

  // The legacy canonical history must CONTAIN main's tip (an ancestor-checked
  // fast-forward) — a divergence is not silently overwritten.
  if (mainSha !== null && !isAncestor(dir, mainSha, legacy)) {
    fail(`refusing non-fast-forward cutover: ${MAIN} (${mainSha}) is not an ancestor of ${LEGACY_CANONICAL} (${legacy})`);
  }

  // Fast-forward main to the legacy canonical tip and update the working tree
  // (HEAD stays attached to main throughout — `merge --ff-only` never detaches).
  git(dir, ["merge", "--ff-only", legacy]);

  const after = git(dir, ["rev-parse", "--symbolic-full-name", "HEAD"]);
  if (after !== MAIN) fail(`post-cutover HEAD is ${after}, not ${MAIN}`);
  process.stdout.write(`cutover: fast-forwarded ${MAIN} to ${legacy}\n`);
  process.exit(0);
}

main();
