# Search-Index Full-Corpus Live Drive — Retro

**Date:** 2026-07-18 · **Drive executed:** 2026-07-17 · **Plan:** [`../plans/2026-07-17-search-index-live-build-plan.md`](../plans/2026-07-17-search-index-live-build-plan.md) · **Issues:** #151 (closed), #60, #156, #157

## Outcome

The retrieval index was built over the full graduated real vault and passed the graduation gate — **recall@10 = 0.878 (≥ 0.85), MRR = 0.784 (≥ 0.70)**, exit 0 — and `brain query "who runs the Cloud team"` returned a grounded, cited answer (#151 acceptance). Drive root: `~/Code/Vaults/atlas-graduation-2026-07-17/`.

| Step | Result |
|---|---|
| graduation apply (operator-signed, D20) | mode: applied · 210 notes · 0 refused · 0 quarantined · 3 renames |
| db rebuild | ok |
| index rebuild | 199 notes → 1,647 chunks · real Gemini embeddings · 85 s (10 empty title-only stubs correctly not activated) |
| index verify | consistent, 199 checked |
| **eval gate** | recall@10 0.878 · MRR 0.784 · exit 0 (vector-only config — see below) |
| rebuild-consistency (#60) | deterministic: rebuild ×2 → identical 199 / 1,647; verify consistent |
| main-vault HEAD | unchanged across the whole drive |

## What the plan's runbook got wrong (corrected steps)

The plan's Task 5 runbook was written from the 07-16 worked example and was factually wrong in six ways that each blocked the drive. **These corrections supersede the plan's Task 5 for any future drive.**

1. **The drive broker needs its own vault repo + fresh anchor — NOT the graduated copy.** The broker stores the audit chain in `refs/audit/runs` *inside* `ATLAS_VAULT_REPO_DIR`. The graduated copy (`grad-copy`) already carries the graduation run's audit events, so a fresh drive ledger (seq 0) collides with the broker's expected next-seq → `broker.audit_seq_nonmonotonic: seq 0 is not the next sequence 1`. The plan even claimed *"pointing straight at `$COPY` is equally valid"* — it is not. **Fix:** create a separate `drive-vault` (a fresh clone of `grad-copy` — `git clone` drops custom `refs/audit/*`), point the drive config `vault.path` **and** the broker `ATLAS_VAULT_REPO_DIR` at it, with a fresh `anchor-drive`.

2. **`graduation migrate --apply` leaves its output in the working tree + a `.bootstrap-backup/`.** The migrated notes (id-renamed, frontmatter-stamped) land in `grad-copy`'s **working tree, uncommitted**, alongside a `.bootstrap-backup/` dir of the pre-migration originals. So `drive-vault` must be cloned **after** committing the migration in `grad-copy`, and `.bootstrap-backup/` must be `git rm`'d from `drive-vault` — otherwise `db rebuild` reads ~209 frontmatter-less originals and fails `rebuild-failed` (refusing a partial snapshot).

3. **A fresh drive ledger needs `db migrate` before `db rebuild`.** The rebuild requires an already-migrated ledger and does not create one (`db-unavailable: no ledger database exists yet`).

4. **Every mint-bearing drive command needs `ATLAS_EGRESS_CAPABILITY_KEY` exported** (`index rebuild`, `index eval`, `query`). The CLI mints run-bound egress capabilities against the same shared secret the egress daemon verifies; without the env var the mint throws before the embed.

5. **Start the broker only after the scan has created the copy.** The broker validates `refs/audit/runs^{commit}` in `ATLAS_VAULT_REPO_DIR` at startup and exits 4 (`ENOENT`) if the repo doesn't exist yet.

6. **The apply challenge nonce has a short TTL.** A ~2 h gap between `--export-challenge` and `--apply --authorization` expired it (`BrokerRefusal: nonce expired`, surfaced as an unmapped `internal`/exit 4). Re-export → re-sign → apply must run promptly and close together.

## Retrieval quality: FTS is immature → vector-only gate config (#156)

> **UPDATE 2026-07-18 — RESOLVED by #159.** The root cause was that **no FTS index was ever built**: `fullTextSearch` brute-force-scanned with LanceDB's default (no-stem, no-stop-word) tokenizer, so common terms flooded top-K. #159 builds a real inverted index with an English analyzer (stemming + stop-word removal + ASCII folding) at rebuild/repair. The **default hybrid config now scores recall 0.911 / MRR 0.830** — FTS participating, no fallback. `retrieval.fts.enabled: false` is **no longer** the recommended default; hybrid is. The account below is the drive-time (pre-fix) state.

At drive time, the gate could only be passed on the contract's **§6 vector-only fallback** (`retrieval.fts.enabled: false`). Every FTS-weighted RRF config *collapsed* recall to ~0.49 — the brute-force FTS layer surfaced bad lexical matches that RRF fused in. Vector-only (recall 0.878 / MRR 0.784) was the only stable pass; vector-weighted hybrid (`vec=2`) also passed but with a thin MRR 0.718 margin. Only config-owned values were tuned (query-time; no re-embed). Tracked and fixed as **#156 → #159**.

## Divergences from the plan's code listings (already shipped correctly)

- **`strictBackup` dropped.** The plan's handler listing shows `runReadAudit(..., { strictBackup: true, runId })`; the shipped handler (final-review fix `948c45c`, PR #155) passes only `{ runId }`. On a best-effort `run.readonly` with empty `ledgerWrite`, `strictBackup: true` is a no-op on the coalesced path and could produce a false "not audited" report on the non-coalesced path — so it was removed to match the `status`/`inspect` pure-read pattern. The plan text is a point-in-time snapshot; main is correct.
- **Eval-set validation order** — `index eval` connects the egress broker before validating the local eval-set files, so a local file error needs a live broker to diagnose. Deferred, tracked as **#157**.

## Follow-ups

- **#156** — LanceDB FTS immaturity (the one substantive retrieval issue).
- **#157** — validate eval-set files before connecting egress (authoring ergonomics).
- **#60** — remaining slices stay open: workflow-runs/purge, `tools/scale-bench.ts`, ingest→index auto-hook.
