# Vault-sync live-drive retro (2026-07-21)

**Verdict: the #60 Phase-6 auto-hook is proven end-to-end on the real 247-note `main-vault`.** A committed edit was absorbed into `refs/atlas/main`, `index:reconcile` drained, and the note came back **retrievable** (FTS + vector rank 1) — with `refs/heads/main` **byte-unchanged**. Getting there surfaced **one real daemon bug** (fixed, PR #306) and a stack of adoption/provisioning gaps (follow-ups #307/#308/#309). This is the authoritative gotcha source for adopting a **user-owned** vault — supersedes the plan's sketch where they differ.

## What was proven

| Criterion | Result |
|---|---|
| Committed edit retrievable within one cycle | `query` answered + cited `[[atlas-drive-probe]]`, found via **both** FTS (rank 1) + vector (rank 1) |
| `refs/heads/main` byte-unchanged | `a6c0c4d` → `a6c0c4d` — Atlas never wrote upstream |
| `refs/atlas/main` advanced | → `f4f0352` (broker-authored reconciled commit) |
| fd-3 keychain credential hand-off | drain minted egress + embedded, credential never on disk / in env |
| Provisioning gate | 6/7 live; the 7th (puller) correctly refused (see #309) |

`sync` returned `absorbed: 1`, `cursorTo: a6c0c4d`, a `reconcileJobId`; `jobs run` drained it `exitCode 0`.

## The headline bug — daemon never learned the adopted canonical ref (PR #306)

`loadBrokerConfigFromEnv` hardcoded `DEFAULT_PROTECTED_REFS` (`refs/heads/main`) with **no env override**. Phase 1 made `git.canonical_ref` config-driven for the CLI/in-process path (`protectedRefsFor`) — **the daemon path was never wired.** Every scope-`sync` integrate CAS-mismatched:

```
capture base moved: expected 27f386c (refs/atlas/main head), canonical is a6c0c4d (refs/heads/main head)
```

Worse than a mismatch: had `refs/heads/main` sat at the expected base, the daemon would have **advanced `refs/heads/main`** — the write the 60-A invariant forbids. **CI never caught it** because the in-process harness constructs `BrokerService` with the right refs directly; the daemon env path was untested. Fix: `ATLAS_CANONICAL_REF` env override (canonical only; audit/trust fixed; blank = unset) + launcher pass-through + a `loadBrokerConfigFromEnv` regression test. **This is the single most important outcome of the drive** — it would have broken *every* adopted-vault deployment.

## Adopting a USER-OWNED vault — the ACL gaps `adopt-vault.sh` leaves (→ #307)

The broker (`atlas-broker`) and agent (`atlas-agent`) must operate git inside a repo owned by the login user. Each of these was a live failure, fixed by hand:

| Symptom | Cause | Fix |
|---|---|---|
| `canonical ref does not resolve` | `refs/atlas` locked `0700` owner-only → agent can't READ canonical to diff | `0750 atlas-broker:atlas-git` (broker sole writer, group read) |
| `insufficient permission … .git/objects` | broker can't write objects | `core.sharedRepository=group` + group-share `.git` to `atlas-git`, setgid dirs |
| `EACCES open '…/audit-anchor'` | block cleared the anchor; broker can't recreate it (parent `/usr/local/var/atlas` is `root:wheel 0755`) | recreate an empty **broker-owned** anchor |
| git dubious-ownership | service accts running git in a 501-owned repo | system `safe.directory` for the vault |

`refs/atlas` + `refs/audit` stay broker-write-only after the group-share (OQ#2 re-verified live: agent denied write, can read).

## Other gotchas (in the order they bit)

1. **Blank `pnpm` shim silently ships a STALE privileged binary.** `build-artifact.sh` calls bare `pnpm` (neutered global shim → `This: command not found`), produced nothing, left a Jul-19 **pre-p256** broker bundle. Installing it downgraded the broker → crash-loop `must be an "ed25519:" public key` on the SP-3 `signers.json` p256 entry. **Verify artifact freshness + content (`grep -c p256:`), never trust file existence.** Build with `npx pnpm@11.15.0` (or a PATH shim). [matches the stark-skills silent-no-op lesson]
2. **`atlas-agent` has NO login shell (`/usr/bin/false`).** `sudo -u atlas-agent -i …` exits non-zero with **zero output** — every tooling invocation must use `sudo -u atlas-agent /bin/sh -c …`, never `-i`. Cost an hour of "stuck / silent" debugging.
3. **Backup-AEAD key under sudo/launchd.** The §2.8 backup needs `cli-custody-v1`; a non-login sudo context has no login keychain → provision it into `System.keychain` (like the egress cap key). (→ #309)
4. **Non-note `.md` halts sync** (`README`, `.codex/instructions.md`, …) under the default `note_globs: ["**/*.md"]`. (→ #308)
5. **Zero-state adoption replays the FULL history** (~1016 commits here), scanning historical non-notes — slow + wasteful. Drive re-seeded `sync_cursors.last_absorbed_oid = head~1`. Adoption should baseline at head. (→ #308)
6. **No vault puller.** `sync` reads local `refs/heads/main`; `atlas-agent` is network-denied. The gate correctly refuses to enable the timer without a network-capable puller. (→ #309)
7. **Stale lock from a killed run** → `brain doctor --reclaim-locks` clears dead-holder locks.

## Process note

The drive was ~15 sequential sudo blocks (`~/Code/.scratch/phase6-live-drive.sh`), each failure diagnosed from the instance log's `causeName`/`causeMessage` before the next fix — never a blind edit on the real vault. `refs/heads/main` was never at risk (Atlas writes only `refs/atlas/main`; verified byte-identical after).

## Status

- **Auto-hook: proven.** Phase 6 (#268) is functionally complete and live-validated.
- **Owed for turnkey full-corpus continuous sync:** PR #306 (merge), #307 (adopt ACLs), #308 (note_globs + baseline-at-head), #309 (puller + keychain). The persistent launchd timer stays **disabled** until #309 lands (correct fail-closed posture).
- **#60 stays open** until #306 merges + the adoption follow-ups make full-corpus sync turnkey.
