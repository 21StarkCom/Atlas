# Atlas Console (SP-2) — Live-Drive Retro

**Date:** 2026-07-20 · **Plan:** [`../plans/2026-07-19-console-cockpit-plan.md`](../plans/2026-07-19-console-cockpit-plan.md) (P6-Task-5) · **Spec:** [`../specs/2026-07-19-console-cockpit-spec.md`](../specs/2026-07-19-console-cockpit-spec.md) · **Issues:** #257 (this drive), #251–#256 (closed), #284–#287 (filed here) · **PR:** #273

## Outcome

Every **process contract the Console depends on** was driven against the **live launchd-services deployment** (`atlas-broker` pid 608, `atlas-egress` pid 610; instance state `~/Code/Vaults/atlas-live/.atlas`) and behaves exactly as the Console's decoders, reducers, executor, and privileged-flow state machine assume. The **`.app` bundle assembles, ad-hoc-codesigns, satisfies its designated requirement, and launches** as a live process. The Console's own suite is **374/374 green** and CI is green on both legs (`ubuntu-latest` + `macos-15`).

**Honest scope boundary.** The Console is a SwiftUI GUI whose remaining checklist steps (surface parity read against the live cockpit, daemon-transition banner timing, the full Touch-ID round trip, the VoiceOver/Full-Keyboard-Access passes) require **a human at the machine driving the rendered app** and a **shipped SP-3 signer** — neither is automatable from an agent session. Those are the [manual accessibility checklist](../specs/2026-07-19-console-accessibility-manual-checklist.md) (#254) and the human-led remainder of #257, unchanged. What an agent *can* prove — that the real system emits exactly what the Console parses, and that the privileged flow drives correctly up to the broker's fail-closed boundary — is proven here.

## What was driven live (against the real deployment)

Driven via a `sudo -u atlas-agent` shim (the deployment's CLI identity is `atlas-agent` per D17; the instance state + sockets are closed to the operator UID — the sanctioned delegation is the NOPASSWD `atlas-agent-dev` sudoers rule), using the worktree-built `apps/cli/dist/bin.js` so the contract bundle anchors on this branch's checkout.

| Console dependency | Command driven | Result |
|---|---|---|
| Binary probe (P1 `db status`, pure) | `brain db status --json` | exit 0, schema-valid (31 tables, `backup.healthy:true`) |
| Watch attach (P4 once-hello) | `brain watch --json --once` | exit 0, one `watch.hello`, attached, full `snapshot` + `resume.auditHeadSeq:131` + `daemons{broker,egress reachable}` — decodes against `watch.schema.json` |
| Read-on-focus (P6 `ReadCommandExecutor`) | `jobs list`, `git status` `--json` | both schema-valid `{command, …, pagination{…}}` — the executor's strict-parse contract holds live |
| Audited/read (trust surface) | `source list`, `source trust show <id>` `--json` | valid; 4 untrusted sources; picked a **pre-promotion** fixture (valid twin-op baseline) |
| Privileged mint (P5 Export) | `source trust promote <id> --export-challenge --json` | **exit 6**, a valid `AuthorizationChallenge` (schemaVersion 1, `op`, `intendedEffect{trust untrusted→trusted}`, `nonce`, `expiresAt`, `signingPayload`, `payloadCanonicalization:atlas-jcs-v1`) — passes `SignerContractValidator` + the flow's consistency gate |
| Sign (P5 Sign) | `atlas-signer sign` (drive shim) | exit 0, a schema-valid `AuthorizationResponse` echoing the frozen challenge |
| Authorize (P5 Authorize) | `source trust promote <id> --authorization <path> --json` | **fail-closed refusal** (un-enrolled signer); `source trust show` confirms trust state **unchanged** — the exact fail-closed evidence the spec's §security demands |
| App artifact (P1 assemble) | `scripts/assemble-app.sh` → `open` | `.app` assembles, `codesign --verify` passes, launches as a live process |

## The one blocked step, and why it is not a Console defect

`brain query "…"` (the egress-minting action, checklist step 6) **blocked at the backup-AEAD keychain custody**: `key-unavailable — atlas-ledger-backup:trusted-cli/cli-custody-v1 not found`. `query` is an `audited-read` that fires a post-run ledger backup, which needs the `cli-custody-v1` AEAD key from the **operator's login keychain**. A `sudo -u atlas-agent` shell has no unlocked login keychain, so the key is unreachable — an artifact of *how the drive shells the CLI*, not of the Console. The Console's own egress path (key scoping, transient handling, `ATLAS_EGRESS_CAPABILITY_KEY` injection for exactly the two minting commands) is proven by `EgressKeyScopingTests`/`FailingQueryRedactionTests`; the capability key itself **is** readable by `atlas-agent` (confirmed: `/usr/local/etc/atlas/keys/shared/egress-capability.key`, group `atlas-git`). A real query completes when the Console runs as the logged-in operator with the login keychain unlocked (the intended launch context).

## SP-3 is spec'd but not shipped — the honest privileged-flow boundary

There is **no `atlas-signer` binary and no `p256` verify path in the broker** (ADR-0002 + the SE-authorization spec are merged as *design*; #164/#166 landed docs only). So a genuine Touch-ID round trip that mutates trust is impossible today, and the drive used a throwaway-key signer shim adapting `tools/test-signer.ts` to the SP-3 CLI channel contract. Its output is correctly **refused fail-closed** by the broker (unknown signer) — trust never changed, and **D20 is not bypassed**. This is the right live evidence for the current world: the Console's export→sign→authorize state machine drives end-to-end and lands on the broker's refusal exactly as designed. The full green round trip is gated on SP-3 shipping an enrolled SE signer — tracked as the human-led remainder of #257.

## Review (2 rounds, per the process cap)

- **Round 1** — a 5-dimension multi-agent workflow (concurrency, contract-binding, security, accessibility, test-adequacy); every reviewer proved `swift test` green before reviewing. **15 findings** survived 3-lens adversarial verification (7 major, 8 minor); 9 candidates refuted and dropped. The Claude monthly spend limit tripped mid-run and killed 26 verifier agents — the 9 orphaned findings were then verified inline against the code (all 9 confirmed real). All 15 fixed on-branch; all posted inline on PR #273 (review 4732979457). Load-bearing ones: the `ArgvClassifier` `name`-only key read (dead value-flag redaction on every privileged spawn), the `ProcessRunner` launch-failure hang, the settings-cutover gate reading the lagged mirror instead of the flow actor, and the `ControlSafeText` enumerated-blocklist gap (TAG-block hidden-suffix spoof).
- **Round 2** — a focused re-review of the fix diff (regression + residual hunt). _[outcome recorded on merge — see PR #273 thread.]_

## Follow-ups filed

- **#284** — Console live-drive automation: a headless harness that drives the real process contracts (the table above) as a CI-adjacent smoke, so the parts that don't need a GUI stay covered without a human.
- **#285** — `query` under a service-identity drive needs the backup-AEAD key reachable without a login keychain (drive ergonomics; blocks the automatable half of step 6).
- **#286** — the manual GUI/VoiceOver checklist (#254) + the SP-3-gated Touch-ID round trip remain the human-led remainder of #257; revisit when SP-3 ships an enrolled signer.
- **#287** — `AttachCoordinator.handleHello` stopping-latch guard (R1 fix) has no deterministic interleave test (needs a suspension hook inside `handleHello`); the guard is structural and covered indirectly. Add the hook + test.

## What the plan's checklist got right (no corrections needed)

Unlike the search-index drive, the P6-Task-5 checklist needed **no factual corrections** — it correctly names the launchd-services prerequisite, the pre-promotion trust fixture, the unconditional twin-op cleanup, and the short nonce TTL. The only additions are the two environmental realities above (SP-3 not shipped; keychain custody under a service-identity shell), which are properties of *today's deployment*, not errors in the checklist.
