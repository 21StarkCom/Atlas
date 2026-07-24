# s2p review record — atlas-v2-single-process-simplification

**Pipeline:** `/stark-spec-to-plan` (lead `claude`, wing `codex`) → plan at `docs/plans/2026-07-21-atlas-v2-single-process-simplification-plan.md`.

**Outcome: plan adopted from the lead's on-disk revised draft after two dispatcher failures; final wing-style pass done in-session. The formal adversarial gate is deferred to `/stark-review-plan`.**

## Run record (honest — this run did not complete cleanly)

| Run | Result |
|---|---|
| 1 | `aborted` — lead round-1 generate timed out twice at 900 s (1802 s total), zero draft |
| 2 (`--timeout 1800`) | lead **generated**; wing reviewed → `revise`; lead's revise call **wrote the revised draft to disk**, then its `claude` CLI exited 1 (`ANTHROPIC_API_KEY` precedence warning on stderr); the dispatcher died without emitting a receipt — **no rounds JSON, wing findings not persisted** |

The salvaged file (78 k, 432 lines, mtime mid-run-2) is the **post-wing-revision** draft — it explicitly incorporates wing round-1 findings (call-site-before-deletion ordering, the `link` schema field-count fix, the semantic grep gate). The wing's full findings list was lost with the dispatcher; its incorporated fixes are visible in the draft's own annotations.

## In-session wing pass (Claude, this session) — deltas applied to the draft

1. **Phase 5 gained the live drive as its own task (3), gating deprovision (now task 4)** — the repo's "test live" rule: destructive `db migrate` on the live DB (row counts recorded), `index eval` on the real corpus (≥ 0.85 / ≥ 0.70), live `link` + `enrich` via the Keychain-resolved key, the `git revert` + `brain sync` restore drill; recorded in the Phase-5 retro.
2. **Phase 6 gained issue hygiene (task 4)** — #60/#65/#297/#298 closed as retired with ADR-0003 + `v1-fortress` links (spec kill-list row, previously unassigned to any phase).
3. **Flag 6 resolved in-repo** — the in-process `BrokerService` path exists (`apps/cli/test/workflows-core.test.ts`); Phase 2's integrator collapses onto it, not a net-new path.

Verified against the converged spec with no further deltas: canonical mutation order · vault-lock scope + d/d2/d3 · key resolution (no launcher) · `link` 7-field schema + rows e–n · sync 6-field schema, `movedCount`, invisibility-first purge, rebuild-only orphan sweep · `status` 4 pending counts + exit contract · evidence ten-column destructive cutover + `sectionPath` · `source` registry · grep-gate scoping + deprovision allowlist (incl. the `atlas-gemini-api-key` negative assertion) · exit codes `{0,1,2,4,5}`+7 · ADR-0003 · macOS-only posture.

## Tooling findings (for the stark-skills backlog, not this repo)

- `plan_dispatch.ts` **hangs/dies without a receipt** when the lead's revise CLI exits non-zero — the round data (draft, wing findings) is lost unless the lead happened to write to disk. It should persist per-round artifacts eagerly and exit with a terminal verdict on a failed revise.
- Dispatched `claude` CLI children intermittently exit 1 in this environment with the `ANTHROPIC_API_KEY`-precedence warning (same signature killed the spec-review wing in round 2). Suspect the env-inherited API key vs claude.ai login interaction; needs a repro + either env scrubbing in the dispatcher or CLI pinning.
- Lead round-1 at 900 s is too tight for a ~350-line spec at max effort; run 2 succeeded at 1800 s.
