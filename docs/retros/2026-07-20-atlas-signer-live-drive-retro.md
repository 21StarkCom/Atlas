# SP-3 `atlas-signer` live drive (P6) — retro

**Date:** 2026-07-20 (ran into 07-21) · **Epic:** #290 · **PR:** #292 (merged `adc7c85`) · **Closes:** #286

## Verdict

**SP-3 works. The broker verified a real Secure-Enclave P-256 signature and applied the effect, end to end, on the live deployment.** ADR-0002 is no longer theoretical.

The drive also surfaced **four defects that CI structurally could not catch** — two of them significant, neither caused by SP-3. That is the drive earning its keep: every one was found by *actually doing the thing* rather than by testing the thing.

| | |
|---|---|
| p256/SE authorization proven live | ✅ promote → revoke, both Touch-ID'd, broker-verified |
| Vault left exactly as found | ✅ `trust_state` back to `untrusted` |
| Defects filed | #297, #298 (and #296 — **retracted**, see below) |
| Console GUI round trip | ❌ blocked — #298, structural |
| Quarantine `os-presence` round trip | ⏸️ deliberately deferred |

## What was proven

The full ceremony ran against the **live launchd broker** and the **real adopted vault** (`/var/lib/atlas/vault`, 249 notes):

```
export challenge (exit 6)  →  atlas-signer sign (Touch ID, exit 0)  →  --authorization (exit 0)
```

- **Promote:** `source trust promote` → `{"trustState":"trusted"}`, `trust_state` row written (was 0 rows — this was the instance's first-ever trust entry).
- **Revoke:** same ceremony in reverse → `untrusted`. The approval sheet correctly rendered `trusted → untrusted`, proving re-derive-and-refuse on a *different* effect.
- **Signature:** `p256:MEQCIHsJ…` — base64url DER, 94-byte body, `challenge echoed verbatim: true`.
- **Signer:** `approver-se-aryehs-macbook-pro-v1`, `accessPolicy: biometryCurrentSet`, blob dir `0700` / files `0600` in the operator's home.
- **Registry:** `alg: p256`, `presence: true`, **11 `permittedOps`** (the 9 signature ops + the two quarantine ops that `--presence` grants). The attestation entry survived the merge; a repeat enroll hit the idempotent path (*"already enrolled identically — no change"*), proving the re-enroll guard for free.
- **Channel contract:** stdout carried only the response JSON; **empty on every failure**; summary + diagnostics on stderr. Verified across four runs.
- **Exit table:** `0` signed, `4` cancelled (observed three times). `3` (expired) never fired — the export+sign-in-one-script pattern removed the TTL race entirely.

## Findings (all filed)

| # | Finding | Severity |
|---|---|---|
| ~~#296~~ | ~~`source trust` read surface hardcoded to `untrusted`.~~ **RETRACTED — false finding.** Already fixed on `main` by **#218** (`6ed6b85`, PR #288); `source.ts` reads `trust_state` via `readTrustRecord`, with a promote→read round-trip test. The live symptom was a **stale binary**: the drive ran the SP-3 *feature-branch* brain (based at the SP-2 merge, pre-#218), not `main`. The `trust_state` write was always correct. Closed as already-fixed. **Lesson: drive live with a main-based binary, never a feature branch behind main** — the same class as the "re-read from disk after a review loop" rule. | not a bug |
| **#298** | **The Console cannot reach the broker on a spec-compliant install.** The cockpit spec says it runs as the *operator* and is "exactly as privileged as the operator's terminal"; `install.md:103` says `atlas-git` is `atlas-agent` + `atlas-broker` **only**. Both are reasonable; together they are unsatisfiable — the operator's terminal *also* cannot run `brain`. | architectural contradiction |
| **#297** | Signer swallows the actionable cause of exit 4 (see below); `doctor`'s `signer-registry` reports a **vacuous `ok`** ("no broker keys dir resolved — nothing to verify"); `doctor` and `db status` **disagree** on backup health (`degraded` vs `healthy: true`). | polish, cost real time |
| open Q | `trustLedgerHead` returned all-zero and `refs/trust/ledger` does not exist in the live vault, though `trust/promote.ts` documents advancing it. On `main` the projection is written by `execAuthorized` (authorize-only in Phase 1), so the all-zero head is likely the intended Phase-1 sentinel rather than a bug — but unconfirmed. Not re-filed after the #296 retraction; note for whoever wires the git-side trust ledger. | unknown |

**None are SP-3 regressions.** SP-3 changed only the signature algorithm, and that part worked on the first non-clamshell attempt.

## The 40-minute detour: "Authentication canceled."

Signing failed three times with:

```
atlas-signer: authentication cancelled or failed: Authentication canceled.
```

which reads unambiguously as *the operator dismissed the prompt*. **No prompt was ever displayed.** Two plausible hypotheses were reasoned out and both were **wrong**:

1. ~~The non-interactive shell can't present biometric UI~~ — wrong.
2. ~~The ad-hoc/linker-signed binary lacks the identity to present LA UI~~ — wrong.

A 30-line `LAContext` probe settled it in one run:

```
LAError = systemCancel (-4)
NSDebugDescription: "Touch ID is not available in closed clamshell mode."
Subcode: 10
```

**The laptop lid was closed** (external display). Opening it made everything work immediately.

Two lessons, both worth more than the fix:

- **Measure, don't reason.** Two confident architectural hypotheses died to one probe that printed the actual error code. When a system gives you a wrapped error, unwrap it *first* — before theorising about code signing.
- **`mapNSError` throws away the answer.** It maps every non-`biometryNotEnrolled/NotAvailable/invalidContext` `LAError` through `default:` using only `localizedDescription`, discarding `NSDebugDescription` and `Subcode` — the only fields that said what was wrong. Filed in #297. A one-line hint would have turned 40 minutes into 5 seconds.

## Runbook corrections — the PR #292 runbook was wrong in six places

Anyone repeating this should use **this section**, not the PR comment.

1. **The live broker was pre-SP-3 and nobody noticed.** The runbook said "drive against the live broker"; the deployed binary was the 19-Jul build with no p256 verify. A prod upgrade is a **required first step**:
   `tools/build-artifact.sh` → `sudo provisioning/install-artifact.sh <dir>` → `sudo launchctl kickstart -k system/com.atlas.{broker,egress}`. Verify by comparing `shasum -a 256` of the installed binary against the artifact.
2. **`brain` must run as `atlas-agent`, not as you.** The socket dir is `drwxrws--- atlas-egress:atlas-git` and the operator is normatively not in `atlas-git`. Every bare `brain …` line in the runbook fails on a provisioned host. Use `sudo -u atlas-agent env HOME=/Users/Shared/atlas-agent-home ATLAS_ROOT=… node <checkout>/apps/cli/dist/bin.js …`.
3. **`source trust promote` has no `--to tier1`.** The schema is a single positional `<sourceId>` plus the three flow flags; promotion targets `trusted`.
4. **The source identity is the `contentId`** (`sha256:<hash>:text/markdown`) — not `s_…`, not the `source-<hex>` note id.
5. **`enroll-signer.sh --dry-run` does not exist** (exit 5). The dry-run path is gated by `ATLAS_ENROLL_TEST_MODE=1` and is absent from the usage text.
6. **`keygen` does not fire Touch ID.** `.privateKeyUsage|.biometryCurrentSet` gates *usage*, not creation; `install.sh`'s "keygen (Touch ID prompt proves the gate)" oversells it. The gate proves itself at `sign`.

Plus the one that cost the most: **Touch ID is unavailable in closed-clamshell mode.** Open the lid before driving anything biometric.

## What made it go well

- **Export-and-sign in one script.** The 300 s nonce TTL never came close to biting after the first attempt, because the challenge was exported and signed in a single invocation. Recommended as the default pattern; it removes an entire failure class.
- **Passwordless `sudo -n -u atlas-agent`** (`/etc/sudoers.d/atlas-agent-dev`) let the agent half be driven programmatically while only the genuinely human acts (Touch ID, root) needed a person. Worth keeping on dev hosts.
- **`/Users/aryeh/Code/Vaults/atlas-live/`** is the de-facto SSOT for the live rig — `brain.config.yaml`, `.atlas/atlas.db` (agent-owned), and `recover-audit-chain.sh`. It is not referenced from any doc; it should be. Finding it is what unblocked the whole drive.
- **Verifying the artifact before installing it.** `grep`-ing the bundled binary for `verifyP256Bytes` caught nothing wrong, but it is what made the prod upgrade a 2-minute step instead of a leap of faith.

## Residuals

- **Console GUI round trip — not done, blocked by #298.** A shim (`ATLAS_BRAIN_PATH` → a wrapper re-exec'ing brain as `atlas-agent`) made `brain` reachable and the probes pass, but the assembled `.app` then **produced no window, no process, no log lines, and no crash report** when exec'd outside LaunchServices. Three distinct failure modes in one leg; not worth further chasing until #298 is decided, since the shim is papering over a gap that should not exist.
- **Quarantine `os-presence` round trip — deliberately skipped.** There are zero quarantine items on the instance, and seeding one means deliberately triggering a scan violation. The `--presence` grant is therefore **enrolled and registry-verified but never exercised live**; the gate remains unit-tested only. Worth doing when a quarantine item next appears naturally.
- The broker log retains two historical `seq 0 breaks continuity` lines from the 19-Jul duplicate-genesis incident. Harmless — the daemon starts clean — but they cost a few minutes of doubt during the upgrade. `recover-audit-chain.sh` already fixed the underlying state.

## Bottom line

The signing half of the Console arc is real and proven against production. The GUI half is blocked on an architectural contradiction that predates SP-3 and needs a decision (#298). SP-3 itself needs nothing further. The one thing I got wrong — a false #296, caused by driving with a stale feature-branch binary — is the drive's sharpest process lesson: **a live drive is only as honest as the binary it runs; build from `main`.** (The prod broker was itself reinstalled from a main-based artifact post-drive for the same reason.)
