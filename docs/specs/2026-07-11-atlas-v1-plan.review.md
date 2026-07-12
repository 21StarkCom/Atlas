# Plan review record — 2026-07-11-atlas-v1-plan.md

**Review:** `stark-review-plan` (lead codex `gpt-5.6-sol` xhigh, 5 domains: completeness, security,
sequencing, viability, ssot; wing opus-4-8 fixer), 2026-07-12, 4 rounds, 179 raw findings, 38 in the
final review-only pass (7 critical, 26 high, 5 medium).

**Disposition: the automated wing-fixed output was DISCARDED; findings were hand-triaged against the
clean `4b08fa6` base and only genuine defects applied** (as decisions D13–D20 + targeted task edits,
`4b08fa6` → this revision, +105 lines).

## Why the wing output was discarded

Same divergence as the spec-to-plan loop, one level up: the wing fixer patched findings surgically
without a global view and **invented machinery that was never in the plan** — a "trusted-CLI daemon",
a "trusted-ledger capability issuer", a "durable outbox", an "audit-append lock", a
`LedgerMutationDescriptor`. It misread the plan's `trusted-CLI-only` **ACL label** (meaning "the
trusted CLI process, not parser/model") as a *service*. Round 4's codex then correctly flagged those
**wing-introduced phantoms** as critical ("the durable outbox cannot be built", "the trusted-CLI
daemon has no implementation task"). The plan grew 1576→1749 lines and got *less* coherent. Verified
against `4b08fa6`: `trusted ledger`, `outbox`, `capability issuer`, `LedgerMutationDescriptor`,
`append-lock`, `peer-authenticated` all appear **0 times** in the original — 100% wing inventions.

## Findings triage

### REJECTED — wing-induced phantoms (dissolve against the original; ~9 of the critical/high set)
- "Required trusted ledger and trusted-CLI services have no implementation task" (crit)
- "The trusted ledger capability issuer has no implementable identity lifecycle" (crit)
- "The durable outbox cannot be built from the declared API" (crit)
- "The trusted-CLI daemon has no implementation task or binary" (crit)
- "SQLite permission model makes normal CLI writes impossible" (crit) — assumed a broker-only SQLite
  the plan never specified; **D13** makes the boundary explicit: SQLite is CLI-written, integrity via
  the broker-signed audit ref + WORM anchor, no store service.
- "The append lock is released before the fallible ledger commit" (high) — attacks the wing's added lock
- "Audit capability issuer has no implementation task" / "External anchor is outside the crash-recovery
  protocol" / "Restore hooks are registered in the wrong process" (high ×3) — all predicated on the
  phantom trusted-CLI daemon; §2.8's actual crash-recovery (both-direction, `(runId, seq)` idempotent)
  already covers the real anchor+ledger ordering.
- "Retained jobs migration is never registered" attacked the wing's `Task 2.1b` split — the real
  (milder) gap is fixed in **Task 2.7** (composition-root `registerJobsMigration`).

### ACCEPTED — genuine defects, fixed (14)
| Finding (domain) | Fix |
|---|---|
| Workspace packages depend on app-internal types → build cycle (completeness/high) | **D14** — DTOs (`VaultSnapshot`/`ParsedNote`/`SectionTree`/…) move to `@atlas/contracts`; `contracts.no-app-import.test`. |
| Normalized content persisted before scan (completeness/high) | **D15** — scanner runs **inside** the sandbox worker; `runInSandbox` returns an attested clean **stream**, not an `outputDir`; `scan-before-persist.test`. |
| Privileged launchers execute agent-controlled artifacts (security/crit) | **D16** — hash-verified privileged binaries installed to root-owned, non-agent-writable dirs; `provisioning.integrity.test`. |
| Network denial bypassable by avoiding the launcher (security/high) | **D17** — denial enforced at a dedicated non-login agent **UID** (netns/cgroup / per-UID pf), not the launcher; `egress.bypass.test` runs a direct-from-UID attempt. |
| Internet-facing egress identity can read the vault (security/high) | **D18** — `atlas-egress` removed from `atlas-git` + all vault ACLs; separation test asserts EACCES. |
| Egress RPCs permit unrestricted export/spend (security/high) | **D19** — run-bound egress capability `{runId, op, model, maxBytes/Tokens, costCeiling, allowedSensitivity}` + per-run budget; `egress.capability-budget.test`. |
| Per-transmission finalization vs terminal audit cardinality (viability/high) | **D6-clarified** — each transmission writes a `model_calls` ledger row (many/run), never a `run.*` terminal event. |
| Quarantine inspect/resolve not privileged (security/high) | Added to §2.5 privileged ops + **Task 5.3** challenge-bound; `quarantine.authorization.test`. |
| Graduation verification uses a signer the broker must reject (×4 dedup, completeness/security/sequencing/viability/high) | **D20** — test signer is `ATLAS_TEST_MODE`-only; Phase-5 real-copy uses the production authorizer (two-flow verification); `broker.rejects-test-signer-in-prod.test`. |
| Privilege classification has two registries (ssot/high) | Single owner = `commands.json` `privilege`; policies/broker read it (§2.5). |
| Graduation thresholds hardcoded / RRF authored twice (ssot/high+medium) | Config/contract-owned (D-inline; Tasks 3.0/5.0). |
| No production external checkpoint backend (completeness/high) | WORM anchor (D8) declared a **local** append-only file, accepted local-first V1 threat model; remote isolated host = V2 (stated). |
| Verification commands bypass launcher/config (completeness/high) | Verification blocks pass `--config`/`--vault` explicitly; no phantom shell wrapper. |
| Read commands amplify into storage DoS (security/medium) | Tier-0 read runs write ledger rows but **coalesce** backups (watermark-debounced), not one full backup per read (Task 1.9). |

### Deferred as genuine-but-V2 (noted, not fixed)
- Phase-2 egress `effectiveSensitivity` enforcement forward-refs Task 4.3 (Phase-2 uses the declared
  value until 4.3 lands) — acceptable since Phase-2 is extraction-only.
- Two medium sequencing nits (Phase-2 contract work ordering; a rollback verify command) were already
  guarded by the "commands that survive the revert" rule; no change needed.

## Net
14 genuine fixes applied as 8 binding decisions (D13–D20) + targeted task edits + 6 new
release-gate tests; 9 phantom findings rejected with reasoning. Plan is 1682 lines, coherent, and the
wing's 173-line divergent bloat is gone.
