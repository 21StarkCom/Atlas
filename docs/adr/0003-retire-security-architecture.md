# 0003 — Retire the security architecture: Atlas becomes a single-process note engine

- **Status:** accepted
- **Date:** 2026-07-22
- **Spec:** [`docs/specs/2026-07-21-atlas-v2-single-process-simplification-spec.md`](../specs/2026-07-21-atlas-v2-single-process-simplification-spec.md) (Atlas v2)
- **Plan:** [`docs/plans/2026-07-21-atlas-v2-single-process-simplification-plan.md`](../plans/2026-07-21-atlas-v2-single-process-simplification-plan.md)
- **Supersedes:** [ADR-0001](0001-egress-response-scan-released-bytes.md) (egress-response-scan), [ADR-0002](0002-p256-secure-enclave-authorization-signer.md) (P-256 Secure-Enclave signer)

## Context

Atlas V1 was built **security-first, contract-first, fail-closed**: two privilege-separated brokers on two OS identities, scan-before-persist at every boundary, a WORM-anchored signed audit ledger, biometric authorization signing, trust tiers with taint-floor propagation, quarantine, and a graduation pipeline that scanned full git history before adopting a vault. That architecture was the reason the repo existed — and it became the reason the *actual product* couldn't move.

The product Atlas is meant to be is small (owner's words, 2026-07-21): **"a single process on top of my vault and vector db — getting notes, fetching notes, rewriting notes, enhancing notes, creating relationships between notes."** The security layer was blocking the agentic layer — the part actually under test. The fortress guards a single-operator, single-machine playground against a threat model (hostile multi-tenant egress, untrusted contributors, credential exfiltration) that does not exist here. The cost — every feature threading brokers, capabilities, ledger writes, and authorization challenges — is real and paid on every change.

ADR-0001 and ADR-0002 are both amendments *within* that security model: 0001 moved the egress scan boundary to released bytes; 0002 made the authorization signer algorithm-agile for a Secure-Enclave key. Retiring the model retires the surfaces they govern.

## Decision

Retire the **entire** security architecture in place. Atlas v2 is a **single process** (`brain`) that opens the vault working tree, the SQLite projection, and the LanceDB index, mutates notes, commits to git, and exits. **The only privilege boundary that remains is git itself** — one commit per applied ChangePlan is the audit trail and the undo mechanism.

Demolished (per the v2 spec/plan): the integration + egress brokers, the daemons, all three OS identities (`atlas-agent`, `atlas-broker`, `atlas-egress`) and their provisioning, `@atlas/scan` in its entirety (no secret scan anywhere), trust tiers + taint, quarantine, the graduation pipeline, the signed/WORM audit ledger + §2.8 cross-store write protocol + AEAD backup, authorization challenges + capabilities + per-run budgets, the absorb-cycle sync, and the Atlas Console + `atlas-signer` + `brain watch` (a new UI comes later). Exit codes `3` (secret-scan) and `6` (action-required) retire. The command surface drops 55 → 24.

Kept: the note model + the 15-op ChangePlan, the plain SQLite projection, the LanceDB retrieval layer + eval gate, the synthesis and evidence machinery (part of the agentic layer under test), the Gemini adapter (now a direct client, no egress broker), and a minimal jobs queue.

**Before any demolition lands, `main` is tagged `v1-fortress`** (Phase 1). That tag is the sole revival path (see below).

## Rejected alternatives

1. **Dev-mode bypass — keep the architecture, add an env flag that short-circuits the brokers/scan/authz in "playground mode."**
   Rejected. It keeps every line of the fortress in the tree and on the maintenance ledger while making it untested (the bypassed path rots, the guarded path is never exercised). A bypass flag is also a standing footgun — one misconfiguration re-arms a fail-closed wall in front of a single-user tool, or worse, leaves a believed-active guard silently disabled. The complexity we are paying for stays; only its value disappears.

2. **Fork a fresh repo — start a clean single-process engine, leave V1 frozen as an archive.**
   Rejected. It splits history, orphans the issue trail, and duplicates the substantial machinery worth keeping (note model, ChangePlan, SQLite/LanceDB layers, synthesis + evidence, jobs). In-place demolition with a `v1-fortress` tag gives the same "clean archive" property — the fortress is one `git checkout` away — without abandoning the ~96-commit history, the CLI-contract harness, or the survivor packages that carry forward unchanged.

## Accepted residual risks

The playground tier (single operator, single machine, personal vault) makes these acceptable; a real multi-tenant deployment would not.

- **Direct writes to the real brain.** `brain` runs as the operator and commits straight to the canonical vault ref — no broker mediates protected-ref mutation, no authorization challenge gates a privileged command, no audit ledger signs the change. **The mitigation is git:** every applied ChangePlan is exactly one commit, so `git revert <sha>` followed by `brain sync` is the undo, and `git log`/`git blame` is the audit trail. A bad or buggy write is recoverable from history rather than prevented by a wall.

- **Unsandboxed ingest.** Source parsing (md/txt/pdf/html) no longer runs inside the Seatbelt/userns jail, and ingested bytes are **not** secret-scanned before they land in a note. A malicious or malformed document is parsed in-process with the operator's privileges, and a secret pasted into an ingested source persists unredacted. **This is a deliberately accepted, unmitigated risk, not one the tier makes disappear.** The v2 threat model is explicit that externally sourced PDF/HTML bytes remain untrusted and that a parser exploit can reach the operator's filesystem and the Gemini key — the sandbox and scan that used to contain exactly this are gone. The only control left is a practical one: the operator chooses what to ingest, on their own machine, for their own vault. No technical boundary backstops that choice at this tier.

## Revival from the tag

Every retired subsystem is revivable by checking out the **`v1-fortress`** annotated tag, which peels to the tip of `main` immediately before the first demolition PR. That tag is the constitutional anchor of this decision: Phases 3–5 (the deletions) are hard-gated on it existing, and the four issues this closes (#60, #65, #297, #298) each link ADR-0003 + the tag as their revival path.

**Scope of the tag: code + provisioning only — not migrated data.** The tag restores every deleted source file, package, and provisioning script. It does **not** restore database contents: Phase 4/5's destructive migrations (`0014_evidence_v2`, `0015_source_registry`) discard v1 claims/evidence/provenance/cursor/ledger rows unrecoverably. Those rows are recoverable **solely** from the verified pre-migration SQLite snapshot taken in Phase 5 (via the backup API + `integrity_check`), never from the tag.

The tag alone is not, by itself, a working installation. **`v1-fortress` restores V1 code and provisioning only** — checking it out over a database that Phase 4/5 already migrated leaves V1 code pointed at an incompatible v2 schema, which will not run. Two distinct restore paths follow from that:

- **Restoring an operational existing V1 installation** requires checking out `v1-fortress` **and** restoring the verified pre-migration snapshot together, so V1 code meets the V1 schema and data it expects.
- **A fresh V1 deployment** (no prior data to recover) requires checking out `v1-fortress` and then running V1 provisioning + initialization from scratch — the tag supplies the scripts, not an initialized store.

## Consequences

- The agentic layer (synthesis, evidence, relationship-building) can be developed and tested without threading brokers, capabilities, or ledger writes.
- ADR-0001 and ADR-0002 are superseded — the boundaries they amend (egress scan; authorization signing) no longer exist. They are **not edited** (ADRs are immutable); this ADR marks them superseded.
- The V1 design SSOT and the security/ledger/sandbox contract specs are marked superseded by the v2 spec + this ADR (Phase 6), not rewritten.
- The security guarantees V1 advertised — fail-closed scanning, privilege separation, tamper-evident audit — are **gone by design**. Anyone who needs them reaches for the `v1-fortress` tag; they are not available in v2 and will not be re-added piecemeal.
