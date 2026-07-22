# `@atlas/git` — agent-side git plumbing

Typed git plumbing over the vault repo, **for the agent side only**. Its reason to exist: expose exactly the git operations agents are permitted, and make protected-ref *writes* **structurally impossible**. That boundary is the package, not a feature.

Agents (via this package) may: **read any ref** (protected or not), **write objects**, create/advance **`refs/agent/<ulid>`** branches, and add/remove worktrees + commit into an agent worktree with a run-manifest trailer. Agents may **not** write any protected ref — that is the broker's job (`@atlas/broker`, separate OS identity, its own privileged git client `packages/broker/src/git.ts`). The two never share a write path.

Zero external git library: everything shells the system `git` binary via `node:child_process`, per the task contract.

Specs: `docs/specs/security-broker-contract.md` (the privilege boundary), `docs/specs/recovery-state-machine.md` (why `commitTree`/`isAncestor` exist). Design SSOT invariant 1: raw model output never writes a file; only the broker advances protected refs.

## Fit in the monorepo

- **Single dependency:** `@atlas/contracts` (workspace) — `ULID_RE`, `RunManifest`/`RunManifestSchema`, `canonicalSerialize` (`atlas-jcs-v1`). See `package.json`.
- **Dependents:** `apps/cli` (the vault-write substrate for the whole run lifecycle) + `@atlas/broker`, which imports **only `readRef`** (read-only reuse) and keeps its OWN privileged git client for protected-ref writes (`packages/broker/src/git.ts`). The two never share a *write* path.

## Key files (all flat, ESM/NodeNext)

| File | Role |
|------|------|
| `src/exec.ts` | `runGit(cwd, args, {input?})` — the ONE funnel for every git call; `execFile` (argv array, never a shell string) ⇒ no shell-injection surface. Exports `GitError` (`args`, `cwd`, `exitCode`, `stderr`). `maxBuffer` 64 MiB. `runGitBuffer(cwd, args)` — the byte-exact variant (no trim, no utf8 decode) blob reads require. **Both are package-internal, never re-exported.** |
| `src/refs.ts` | **The security boundary.** Ref naming + the guarded write functions. `AGENT_REF_PREFIX`, `AGENT_REF_RE`, `isAgentRef`, `assertAgentRef`, `agentRef`, `readRef` (read-only, any ref), `updateAgentRef`, `deleteAgentRef`, `attachHeadToAgentRef`. **v2 (ADR-0003):** `assertCanonicalRef` + `advanceCanonicalRef` — the in-process FF-only CAS advance of the canonical ref (`CanonicalRefError`), the deliberate relaxation of no-protected-write for the ONE canonical ref (the retired broker no longer owns it); the audit/trust anchor namespaces stay off-limits. |
| `src/repo.ts` | `openRepo(dir) → Repo` (pure — `resolve`s dir only, does not touch the FS). Composes refs + worktree ops: `readRef`, `createAgentBranch`, `addWorktree`, `removeWorktree`, `listWorktrees`, `commitTree`, `isAncestor`, plus the read-only sync-cycle helpers `readBlobAt` (byte-exact blob at `<commit>:<path>`, null-only-unresolved), `commitsInRange` (first-parent walk, every commit boundary returned, merge = first-parent diff) and `changedPaths` (net tree diff) — both with fail-closed name-status normalization (`R<n>`→`R`+`fromPath`, `C<n>`→`A`, `T`→`M`, anything else throws) — plus `changedStatusesInRange` (the RAW-status, ALL-REACHABLE `git log … -m` range inspection, byte-for-byte the broker's `changedPathStatuses{InRange,FromRoot}`: letters UNtouched — `T` stays `T` — both rename sides reported; the shape an in-process scope gate needs to match the broker). Types: `WorktreeEntry`, `ChangeStatus`, `PathChange`, `RawStatusChange`, `CommitChanges`. |
| `src/worktree.ts` | `Worktree` bound to an agent ref. `commit(msg, manifest)` (stage-all + manifest trailer, advances the ref), `readManifest(rev?)`. |
| `src/commit-paths.ts` | **v2 direct-commit primitive.** `commitPaths(repo, paths, message)` — snapshot touched-path index → `git add -- <paths>` (creates/edits/deletions) → `git commit -- <paths>` (partial commit, unrelated staged entries survive) → SHA; on commit failure restores ONLY the touched index entries (`update-index --cacheinfo`/`--force-remove`) to their pre-stage state. Paths are canonicalized ONCE (`posix.normalize` + repo-escape reject) so snapshot/restore key off git's spelling, and every path-consuming call carries `--literal-pathspecs` so a `*`/`[ab]`/`:(exclude)` filename stages literally (no pathspec magic). Deterministic `Aryeh Stark <aryeh@21stark.com>` authorship, same identity-pinning as `worktree.ts`. Narrow API, not raw argv (the privilege invariant is moot in v2). Consumed by the 3-3b mutation-order orchestration. |
| `src/commit.ts` | Run-manifest trailer codec. `RUN_MANIFEST_TRAILER = "Atlas-Run-Manifest"`, `encodeManifestTrailer`, `buildCommitMessage`, `parseManifestTrailer`. Manifest → `canonicalSerialize` → base64 → one byte-stable trailer line. |
| `src/index.ts` | Public surface. Deliberately does NOT export `runGit` (locked by the public-surface test; the reasoning is inline at `index.ts:29-33`). |

Tests (53 across 4 files): `test/git.plumbing.test.ts` (Task 1.5 round-trip), `test/git.no-protected-write.test.ts` (the invariant, three ways — exports a pure `auditSources()` fed synthetic mutations), `test/git.adversarial.test.ts` (failure propagation, rollback-on-attach-failure, trailer-injection resistance), `test/git.sync-helpers.test.ts` (byte-exact blob reads, first-parent walk semantics, net diffs, NUL-safe paths, `runGitBuffer` unexported).

## Invariants & guardrails — do not weaken

- **v2 canonical-advance carve-out (ADR-0003).** The single-process pivot retires the broker; `advanceCanonicalRef` is the in-process, **fast-forward-only CAS** advance of the canonical ref (guarded by `assertCanonicalRef`, which still rejects the `refs/audit/*` / `refs/trust/*` anchor namespaces + agent refs). The structural source audit binds each writer to its **specific** guard (`git.no-protected-write.test.ts` `REQUIRED_GUARD`): `advanceCanonicalRef` may use only `assertCanonicalRef`; `updateAgentRef`/`deleteAgentRef`/`attachHeadToAgentRef` only `assertAgentRef`. A swapped guard fails the audit, so a writer cannot be smuggled into the wrong namespace. No audit/WORM append rides this advance — it moves a ref only. Everything below still holds for agent refs.
- **No-protected-write (the core invariant, agent refs).** Every ref-*writing* path routes through `updateAgentRef` / `deleteAgentRef` / `attachHeadToAgentRef`, each of which calls `assertAgentRef` FIRST (`refs.ts:37-44` rejects anything not matching `refs/agent/<ulid>`). Enforced three independent ways in `git.no-protected-write.test.ts`:
  1. **Structural source audit** — `auditSources()` walks all of `src/` and fails if any ref-write subcommand (`update-ref`, `symbolic-ref`, `branch`, `push`, `tag`, `fast-import`) appears outside `refs.ts`, inside a `refs.ts` function lacking `assertAgentRef`, as a top-level literal, or if a `refs/heads/`|`refs/tags/` literal sits in the write module. Proven with synthetic mutation cases.
  2. **Public-surface** — the index must not re-export `runGit`. Exposing raw argv execution would let a consumer `update-ref` any protected ref and bypass every guard.
  3. **Behavioral** — the guards reject `refs/heads/*`, `refs/tags/*`, `refs/remotes/*`, `HEAD`, bare/short names, `refs/agent/../heads/main`, non-ULID, and a 25-char ULID; accept only a well-formed 26-char `refs/agent/<ulid>`.
- **ULID-pinned ref names.** `agentRef` / `AGENT_REF_RE` require the runId segment to be a ULID, so a caller cannot smuggle path segments into a ref name (`refs.ts:21-26`).
- **`addWorktree` is atomic-or-rolled-back.** Rejects a non-agent ref *before* `git worktree add` (a protected ref can't even create a detached worktree), then attaches HEAD; if the attach fails it removes the just-added worktree so no half-attached orphan survives (`repo.ts:114-139`).
- **Trailer-injection resistance.** `buildCommitMessage` refuses a caller message containing `Atlas-Run-Manifest:` (case-insensitive, any line); `parseManifestTrailer` rejects zero or >1 trailers rather than guessing (`commit.ts:39-46`, `54-69`).
- **`null` means only "unresolved".** `readRef`/`commitTree`/`isAncestor` translate git exit-1-empty-stderr to `null`/`false`; every other failure (exit 128 not-a-repo, missing binary, corruption) propagates as `GitError` (adversarial-test-locked, `refs.ts:70-73`, `repo.ts:83`,`99`).
- **Codec round-trip.** `parseManifestTrailer(buildCommitMessage(msg, m))` deep-equals `m` (Task 1.5).
- **Deterministic agent authorship (v2, ADR-0003).** Agent commits use `Aryeh Stark <aryeh@21stark.com>` (author AND committer) set per-invocation via `-c`, with `commit.gpgsign=false` — never mutates ambient config (`worktree.ts:10-18,40-60`). Under the v2 in-process cutover the agent commit is FF-installed DIRECTLY onto the canonical ref (the retired broker no longer re-authors an audit commit over it), so the worktree commit itself must carry the required deterministic human authorship — the same identity the broker formerly stamped on canonical writes (`packages/broker/src/git.ts:44-47`). Asserted in `apps/cli/test/e2e/inprocess-integrator.e2e.test.ts`.

## Gotchas & sharp edges

- **HEAD-attach, not `refs/heads/`.** Agent refs live outside `refs/heads/`, so a checkout is normally detached; `addWorktree` does `worktree add --detach` then `symbolic-ref HEAD refs/agent/<runId>` (`repo.ts:118-125`). Consequence: git's "a branch is checked out in at most one worktree" rule is **bypassed** — *duplicate* worktrees bound to the same agent ref are possible. `git cleanup` therefore removes EVERY worktree bound to the ref, not one (round-2 finding W4; `apps/cli/src/commands/git-cleanup.ts`).
- **Cleanup discovers worktrees by verified git binding, not the ledger path.** `listWorktrees().branch === refs/agent/<runId>` is the discovery key (finding W2; `repo.ts:45-52`); the ref is deleted only after git RE-LISTS and confirms no worktree still binds it (never trust `existsSync`; finding W3). Filesystem absence is not proof git deregistered it.
- **Containment tested by ancestry, not equality.** `isAncestor` exists because ref-tip *equality* wrongly rejects a valid recorded commit once a later commit layers on top; recovery must test containment (round-2 finding W4; `repo.ts:59-67`).
- **Manifest ≠ signature.** This package embeds the manifest trailer only. Ed25519 signing of the manifest/commit is broker territory (documented assumption, `commit.ts:11-14`) — **do not add signing here.**
- **`removeWorktree` uses `--force`.** Uncommitted/locked worktree state is not a blocker to teardown; callers wanting dirty-tree protection won't get it (`repo.ts:141-143`).
- **`brain git rollback` does NOT use this package for the revert.** It shells `git worktree add`/`revert` via raw `execFileSync` in a throwaway detached dir — a deliberate one-off outside the guarded surface (`apps/cli/src/commands/git-rollback.ts`); the actual canonical write is still broker-only.

## How `apps/cli` consumes it (map, don't restate)

- **capture / synthesis / refresh** (`ingest/capture.ts`, `workflows/synthesis.ts`, `workflows/refresh.ts`): `createAgentBranch(runId, canonicalRef)` → `addWorktree` → agent works → `Worktree.commit` writes the manifest trailer.
- **`git verify`** (`git-verify.ts`): read-only; asserts the recorded agent commit resolves and `refs/agent/<runId>` points at it. Divergences are REPORTED, never mutated (`repaired` always 0 — repair is not built).
- **`git approve`** (`git-approve.ts`): `openRepo`/`readRef(canonicalRef)` to detect a moved base → `refresh-required` (exit 6); the FF onto `refs/heads/main` is a **broker** write, not this package.
- **`git reject`** (`git-reject.ts`): terminates the run + cleans its worktree; the agent commit is RETAINED for audit (never FF'd).
- **`git cleanup` / `git status`** (`git-cleanup.ts`, `git-status.ts`): `listWorktrees` + guarded `deleteAgentRef`; status propagates `GitError` as `internal`, only genuine non-repo degrades to empty.
- **reconciler / engine** (`workflows/reconciler.ts`, `workflows/engine.ts`): `commitTree` + `isAncestor` prove a recorded commit's tree and containment during crash recovery.

## History (real PRs)

The package changed shape in exactly four PRs, then stabilized:

- **#61** (Phase 0, `21f8125`) — scaffold: `package.json`, `tsconfig.json`, stub `index.ts`.
- **#62 / sub-PR #21** (Phase 1, `805f68f`) — real implementation: all six src modules + three test files (`feat(git): @atlas/git plumbing client`). The raw-executor concern was resolved by keeping `runGit` unexported + mutation-testing it; manifest-signing declared out of scope (broker seam).
- **#74** (Phase 2, `93c2035`) — added `commitTree` + `isAncestor` for the persisted run state machine + startup reconciler (ancestry-not-equality = round-2 finding W4). Carries KNOWN-OPEN crash-safety edges tracked on **#5**.
- **#78** (Phase 2, `634e891`) — added `deleteAgentRef` + `listWorktrees`/`WorktreeEntry` for `git status`/`git cleanup`. Review hardened cleanup to key on the verified ref binding and remove worktrees before deleting refs (findings W2/W3), and made `git status` propagate operational `GitError`s instead of swallowing them.

The approve/reject/rollback/verify *commands* (Phase 4) consume this surface but added no code here.

## Open items / follow-ups

- **`git verify` repair is a no-op** — it REPORTS divergences; `repaired` is always empty. Convergent repair (re-fold from canonical) is a separate, not-yet-built step (`apps/cli/src/commands/git-verify.ts`).
- **Crash-safety residuals tracked on #5** (from the #74 review): `recordIntegration` can record `integrated` without an authoritative ancestry proof; finalize can commit before backup coverage is verified; reconciler intent ordering isn't a single global oldest-first barrier. These are workflow-engine issues but lean on this package's `commitTree`/`isAncestor` proofs.
- **`functionsOf` in the source-audit test is deliberately coarse** — a regex top-level-function splitter, adequate for the current flat module; a nested closure containing a write would need the audit revisited if the module grows.
