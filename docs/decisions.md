# Decisions

Decomposition + decision run-log (appended by `/stark-plan:stark-plan-to-tasks`). Architectural decisions themselves live in `docs/adr/`; this file is the trail of when a plan was decomposed into tracked issues.

## 2026-07-22 — Atlas v2: Single-Process Simplification

- **Date:** 2026-07-22
- **Status:** Decomposed → issues created
- **Plan:** `docs/plans/2026-07-21-atlas-v2-single-process-simplification-plan.md`
- **Tracking:** phase issues #311 (Decision record + safety net), #312 (In-process cutover), #313 (Demolition + command surface), #314 (Persistence strip), #315 (Point at main-vault + deprovision), #316 (Docs rewrite)
- **Story Points:** 145 total (33 tasks across 6 phases)
- **Summary:** Retire the entire Atlas security architecture — brokers, egress/scan, provisioning, console/signer, ledger/backup, trust tiers — and collapse to a single-process note engine where `brain` opens the working tree + SQLite + LanceDB, commits to git, and exits. Safety collapses to git history + a `v1-fortress` revival tag; there is no rollback machinery to build. Ordering is non-negotiable: cutover (Phase 2, in-process behind the three injected seams, zero provisioning) → demolish (Phase 3, remove semantics + shrink the command surface + delete retired trees) → strip persistence (Phase 4) → point at the real vault + deprovision (Phase 5, human-gated) → docs (Phase 6). Key lead resolutions carried into the tasks: the ported Gemini adapter homes in `@atlas/models` with lazy key resolution; `note_links` gets a table-rebuild migration (`0013`) landing with `link`; evidence becomes vault-derived (folded from note frontmatter on sync/rebuild) with a `sourceNoteHash` staleness guard; the destructive DB cutover is forward-only with a verified pre-migration SQLite snapshot as the sole data undo.
- **Knowledge extracted to:** ADR-0003 (authored as Phase-1 deliverable #317, not here) + the v2 spec; this run-log entry.
