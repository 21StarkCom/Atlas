/**
 * Ref naming + the **security boundary** of this package.
 *
 * Agents (the consumers of `@atlas/git`) hold object-write + `refs/agent/*` +
 * protected-ref *read*. The broker is the sole mutator of protected refs
 * (`refs/heads/*`, `refs/tags/*`, and the canonical branch). Therefore every
 * ref-*writing* code path in this package MUST route through {@link updateAgentRef}
 * / {@link attachHeadToAgentRef}, both of which reject any ref outside the
 * `refs/agent/` namespace. Reading (see {@link readRef}) may target any ref,
 * protected or not — that is the permitted read-only view.
 *
 * `git.no-protected-write.test` grep-guards this: the only git ref-write
 * subcommands allowed anywhere in `src` are the two guarded calls below.
 */
import { ULID_RE } from "@atlas/contracts";
import { GitError, runGit } from "./exec.js";

/** The one namespace agents may write. */
export const AGENT_REF_PREFIX = "refs/agent/";

/**
 * A fully-qualified agent branch ref: `refs/agent/<ULID runId>`. The `runId`
 * segment is pinned to a ULID so a caller cannot smuggle path segments (e.g.
 * `../heads/main`) into the ref name.
 */
export const AGENT_REF_RE = new RegExp(`^refs/agent/${ULID_RE.source.replace(/^\^|\$$/g, "")}$`);

/** True iff `ref` is a well-formed `refs/agent/<ulid>` ref. */
export function isAgentRef(ref: string): boolean {
  return AGENT_REF_RE.test(ref);
}

/**
 * Throw unless `ref` is a writable agent ref. This is the guard the whole
 * no-protected-write invariant rests on — do not weaken it.
 */
export function assertAgentRef(ref: string): void {
  if (!isAgentRef(ref)) {
    throw new Error(
      `refusing to write non-agent ref "${ref}": this package may only write ${AGENT_REF_PREFIX}<runId> ` +
        `(protected-ref writes are broker-only)`,
    );
  }
}

/** Build the agent ref for a run id, validating the id is a ULID. */
export function agentRef(runId: string): string {
  if (!ULID_RE.test(runId)) {
    throw new Error(`invalid runId "${runId}": expected a ULID`);
  }
  return `${AGENT_REF_PREFIX}${runId}`;
}

/**
 * Resolve `name` (a ref, sha, or any commit-ish) to its commit SHA, or `null`
 * if it does not resolve. Read-only: `name` may be a protected ref — reading
 * protected refs is explicitly permitted for agents.
 */
export async function readRef(dir: string, name: string): Promise<string | null> {
  try {
    // `^{commit}` peels tags/annotated objects to the underlying commit.
    return await runGit(dir, ["rev-parse", "--verify", "--quiet", `${name}^{commit}`]);
  } catch (err) {
    // Distinguish "ref does not resolve" from operational failures. With
    // `--verify --quiet`, git exits 1 with empty stderr solely because the name
    // is unknown — that is the only case we translate to `null`. Every other
    // failure (exit 128: not a git repo / bad cwd / corrupt object, a missing
    // git binary surfaced as a non-`GitError`, permission errors, etc.) is
    // operational and MUST propagate rather than masquerade as an unknown ref.
    if (err instanceof GitError && err.exitCode === 1 && err.stderr.trim() === "") {
      return null;
    }
    throw err;
  }
}

/**
 * Point an agent ref at `targetSha` via `git update-ref`. GUARDED: throws for
 * any ref outside `refs/agent/`. This is the *only* `update-ref` call site in
 * the package.
 */
export async function updateAgentRef(dir: string, ref: string, targetSha: string): Promise<void> {
  assertAgentRef(ref);
  await runGit(dir, ["update-ref", ref, targetSha]);
}

/**
 * Delete an agent ref via `git update-ref -d`. GUARDED: throws for any ref
 * outside `refs/agent/`, so `git cleanup` (Task 2.9) can prune a terminal run's
 * abandoned branch without ever being able to delete a protected ref. A ref that
 * does not exist is a no-op success (`update-ref -d` is convergent), which keeps
 * cleanup intrinsically idempotent. This is a guarded write call site — it MUST
 * stay co-located with {@link assertAgentRef} for the no-protected-write audit.
 */
export async function deleteAgentRef(dir: string, ref: string): Promise<void> {
  assertAgentRef(ref);
  await runGit(dir, ["update-ref", "-d", ref]);
}

/**
 * Attach a worktree's `HEAD` to an agent ref via `git symbolic-ref`, so commits
 * made in that worktree advance `refs/agent/<runId>` (a ref checked out into a
 * worktree is otherwise detached, since it lives outside `refs/heads/`).
 * GUARDED on the target ref: HEAD may only be attached to an agent ref, so this
 * can never make a worktree commit onto a protected branch. This is the only
 * `symbolic-ref` call site in the package.
 */
export async function attachHeadToAgentRef(dir: string, ref: string): Promise<void> {
  assertAgentRef(ref);
  await runGit(dir, ["symbolic-ref", "HEAD", ref]);
}

// ── in-process canonical-ref advance (v2 single-process cutover, ADR-0003) ────
//
// The v2 pivot retires the privilege-separated broker: with "zero provisioning"
// there is no separate OS identity to hold the attestation key, so the canonical
// ref can no longer be advanced by a broker daemon. The agent process advances it
// itself. This is a DELIBERATE relaxation of the (now-retired) no-protected-write
// invariant for the ONE canonical ref only — the audit (`refs/audit/*`) and trust
// (`refs/trust/*`) anchor namespaces stay off-limits (there is no signer to append
// to them), and agent refs are still routed through {@link updateAgentRef}. The
// canonical advance is a FAST-FORWARD-only compare-and-swap: it never rewinds or
// forks canonical, and it appends NO audit event / WORM anchor (both dropped this
// phase — Phase-3 collapses this onto a direct `refs/heads/main` commit).

/** The all-zeros object id used as a CAS old-value meaning "the ref must not exist". */
const ZERO_OID = "0".repeat(40);

/** A typed canonical-advance failure carrying a broker-compatible `.code`. */
export class CanonicalRefError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "CanonicalRefError";
  }
}

/**
 * Throw unless `ref` is a canonical protected ref this process may advance. A
 * canonical ref is a fully-qualified `refs/…` ref that is NOT an agent ref (those
 * go through {@link updateAgentRef}) and NOT under the audit/trust anchor
 * namespaces (reserved by the ledger/trust model — no signer exists to write
 * them). Mirrors the config `git.canonical_ref` constraints (`config/schema.ts`).
 * Path-traversal / whitespace are rejected so a caller cannot smuggle a segment.
 */
export function assertCanonicalRef(ref: string): void {
  if (
    !ref.startsWith("refs/") ||
    // Reject the ENTIRE agent namespace by prefix — not just well-formed
    // `refs/agent/<ulid>` (isAgentRef). Malformed/nested agent refs such as
    // `refs/agent/not-a-ulid` or `refs/agent/foo/bar` must never be reachable by
    // the canonical writer.
    ref.startsWith(AGENT_REF_PREFIX) ||
    ref.startsWith("refs/audit/") ||
    ref.startsWith("refs/trust/") ||
    ref.includes("..") ||
    /\s/.test(ref)
  ) {
    throw new Error(
      `refusing to advance non-canonical ref "${ref}": the in-process canonical advance ` +
        `may only move a fully-qualified refs/ ref outside the agent/audit/trust namespaces`,
    );
  }
}

/**
 * FAST-FORWARD-advance the canonical ref `ref` from `expectedOld` to `newCommit`
 * under compare-and-swap. This is the in-process replacement for the broker's
 * protected-ref CAS advance (`packages/broker` `advanceProtectedRef`), MINUS the
 * attestation-signed `refs/audit/runs` append + WORM anchor (both retired in v2).
 *
 * GUARDED by {@link assertCanonicalRef}. The CAS is enforced two ways: the current
 * tip is read + compared to `expectedOld` up front (a mismatch ⇒ a typed
 * `broker.cas_failed`, so the synthesis-apply retry loop rebases exactly as it did
 * against the broker), and the `git update-ref <ref> <new> <old>` write re-asserts
 * `expectedOld` atomically. Fast-forward is enforced: `newCommit` must contain the
 * current tip (or canonical must be unborn), else `broker.not_fast_forward`.
 * `expectedOld` = {@link ZERO_OID} asserts the ref must not already exist.
 * Returns the installed commit SHA.
 */
export async function advanceCanonicalRef(
  dir: string,
  ref: string,
  newCommit: string,
  expectedOld: string,
): Promise<string> {
  assertCanonicalRef(ref);
  const current = (await readRef(dir, ref)) ?? ZERO_OID;
  if (current !== expectedOld) {
    throw new CanonicalRefError(
      "broker.cas_failed",
      `canonical ref ${ref} moved during integration: expected ${expectedOld}, found ${current}`,
    );
  }
  const newSha = await readRef(dir, newCommit);
  if (newSha === null) {
    throw new CanonicalRefError("broker.bad_commit", `newCommit "${newCommit}" does not resolve to a commit`);
  }
  if (current !== ZERO_OID && !(await isAncestorOf(dir, current, newSha))) {
    throw new CanonicalRefError(
      "broker.not_fast_forward",
      `refusing non-fast-forward canonical advance of ${ref}: ${current} is not an ancestor of ${newSha}`,
    );
  }
  // The write re-asserts `expectedOld` atomically (git's own CAS), so a concurrent
  // advance between the read above and here still fails closed rather than racing.
  // git enforces the old-value assertion itself, exiting 128 when the ref moved after
  // the pre-read: translate THAT expected mismatch narrowly to `broker.cas_failed` so
  // the synthesis-apply retry loop (which retries only that code) rebases exactly as it
  // did against the broker — a raw GitError here would abort the critical CAS race
  // instead. Every OTHER git failure (not-a-repo, corrupt object, permission) is
  // operational and MUST propagate unchanged.
  try {
    await runGit(dir, ["update-ref", ref, newSha, expectedOld]);
  } catch (err) {
    if (err instanceof GitError && isExpectedOldMismatch(err)) {
      throw new CanonicalRefError(
        "broker.cas_failed",
        `canonical ref ${ref} advanced concurrently during integration (expected ${expectedOld})`,
      );
    }
    throw err;
  }
  return newSha;
}

/**
 * True iff `err` is git's atomic `update-ref <new> <old>` refusal because the ref's
 * current value no longer matched `<old>` — the CAS race this function must surface as
 * `broker.cas_failed`. Pinned to git's own wordings (exit 128):
 *   - `cannot lock ref '…': is at <sha> but expected <sha>`  (old-value mismatch)
 *   - `cannot lock ref '…': reference already exists`        (must-not-exist old = zeros, but it exists)
 * Kept narrow so an operational lock/IO failure (`Unable to create '…/ref.lock': File
 * exists`, not-a-repo, corruption) is NOT laundered into a CAS refusal.
 */
function isExpectedOldMismatch(err: GitError): boolean {
  return err.exitCode === 128 && /but expected|reference already exists/i.test(err.stderr);
}

/**
 * `true` iff `ancestor` is an ancestor of (or identical to) `descendant`
 * (`git merge-base --is-ancestor`). A read-only helper for the fast-forward gate
 * in {@link advanceCanonicalRef}; `merge-base` is not a ref-write subcommand.
 */
async function isAncestorOf(dir: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await runGit(dir, ["merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch (err) {
    if (err instanceof GitError && err.exitCode === 1) return false;
    throw err;
  }
}
