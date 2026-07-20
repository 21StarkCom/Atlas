# `@atlas/broker` — the privilege-separated security kernel

Two OS identities (`atlas-broker`, `atlas-egress`), two Unix-socket daemons, **one npm
package** (`package.json` ships both `bin/atlas-broker` and `bin/atlas-egress`). This is
the security kernel: the **sole mutator** of the protected git refs and the **sole holder**
of the provider credential + outbound network. Everything else runs unprivileged and asks
the broker.

Normative SSOT: [`docs/specs/security-broker-contract.md`](../../docs/specs/security-broker-contract.md)
(privilege boundary) + [`docs/specs/provider-interface.md`](../../docs/specs/provider-interface.md)
(egress ops). One ADR: [`0001-egress-response-scan-released-bytes.md`](../../docs/adr/0001-egress-response-scan-released-bytes.md).

## Two brokers, one package

- **Integration broker (`atlas-broker`)** — owns protected-ref writes (D13 assets a+b):
  challenge mint/verify (Ed25519), protected-ref CAS advance (ancestry + signature + audit
  re-verify), Tier-1 source-capture integration, signed audit-ref append (monotonic seq + WORM
  anchor), read-only audit-chain health verdict. Phase-1 gate (#66).
- **Egress broker (`atlas-egress`)** — owns the provider credential + outbound network (asset c):
  verifies the run-bound capability, scans the exact serialized bytes both directions, enforces a
  per-run byte/token/cost budget, transmits via the Gemini adapter, returns a receipt.
  **No SQLite, no vault, no git handle** (D18). Phase-2 gate (#76).

## How it fits the monorepo

- **Deps** (`package.json`): `@atlas/contracts`, `@atlas/git`, `@atlas/scan`, `zod`. Nothing else.
- **Hard acyclic seam (§2.8):** this package **NEVER imports `@atlas/sqlite-store`**. The
  ledger→broker dependency is one-directional — the CLI opens the ledger in-process; the broker
  signs the git-ref side and hands back receipts. Enforced by `test/broker.no-ledger-dep.test.ts`
  (fails on any `@atlas/sqlite-store` import under `src/`/`bin/`, and on a package.json dep).
- **Dependents:** `apps/cli` drives both daemons through the typed clients (`src/client.ts`,
  `src/egress/client.ts`); `@atlas/models` is the typed egress IPC client only — the Gemini
  adapter lives HERE, not there.

## Key files

### Integration broker (`src/`)
- `service.ts` — `BrokerService`: the in-process authority wiring authorizer + audit log + WORM
  anchor + protected-ref writer over one vault repo. Holds a **service-wide mutation lock**
  (`runExclusive`, a serial promise tail — line 122) so audit append + ref CAS never interleave
  across connections. Tracks broker-observed `canonicalTip` (refreshed at `start()` + after every
  canonical move); binds canonical-bound LEDGER ops (`db restore`, `db backup --force-unblock`)
  to broker state, not caller values. `signAndAdvanceProtectedRef` (line 224) is the one lock-held
  sign-and-advance step (added #112).
- `authorize.ts` — `Authorizer` mint/verify. Fixed fail-closed order: schema → canonicalization →
  payload recompute → nonce validate → signer registry → D20 test-signer gate → signature → state
  drift → **nonce consume LAST**. `buildSigningPayload` = the `atlas.authz.v1` newline-joined
  canonical byte string; `effectDrift`/`effectCommitmentLines` map each `IntendedEffect` kind to its
  §7.4 drift code + signed commitment lines.
- `nonce.ts` — `NonceStore`: 128-bit hex, op-bound, `DEFAULT_NONCE_TTL_SECONDS = 300`. In-memory
  only (out of Phase-1 scope, fail-closed on restart). `validate()` split from `consume()` so a bad
  request never burns a live challenge.
- `refs.ts` — `ProtectedRefWriter` + `isCaptureAllowedPath`/`isNoteAddAllowedPath` (`CaptureScope =
  "sources" | "note"`): FF-only CAS, Tier-1 capture scope over the WHOLE `base..capture` range
  (`changedPathsInRange`; `"note"` = additions-only `*.md` outside `sources/` via
  `changedPathStatusesInRange`), `bindAuditEventToOperation`. Refuses `advanceProtectedRef` on the
  audit ref (dedicated append path only).
- `audit-append.ts` — `AuditLog`: append to `refs/audit/runs` as commits whose message is the
  on-wire signed envelope. Signed-only, gapless seq, chained heads, content-keyed idempotency on
  `(runId,seq)`, full-chain re-verify at `init()`, WORM anchor every append. `CANONICAL_INSTALLING_KINDS
  = {run.integrated, run.rolled_back}` (SSOT, imported by `refs.ts`). `PublicKeyResolver` is
  `@deprecated` — audit binds to the dedicated attestation identity, not registry lookup.
- `anchor.ts` — `WormAnchor`: append-only Ed25519 lines at D8 path (`0600`), monotonic `eventCount`;
  `verifyChain` binds the anchored head to its exact POSITION (`commits[eventCount-1] === auditHead`).
- `protocol.ts` — IPC wire contract: 9 methods (`BROKER_METHODS`), newline-framed JSON, per-method
  Zod param AND result schemas (both sides validate). `server.ts`/`client.ts` — Unix socket (`0660`),
  typed refusal round-trip; any non-`BrokerRefusal` throw coerced to `broker.internal` (no raw stack
  crosses the seam).
- `keys.ts` — env config + signer-registry derivation from provisioned key files;
  `DEFAULT_PROTECTED_REFS`, `SIGNATURE_AUTHORIZABLE_OPS` (9 ops), default signer ids, `defaultAnchorPath()`.
  **SP-3:** an explicit `signers.json` (written by `provisioning/enroll-signer.sh`) wins over derivation; the
  broker parses each entry's `publicKey` per its `alg` (ed25519 flexible / `parseP256PublicKeyFlexible`). The
  software-P256 fixture (`atlas-test-approver-p256`) is registered **unconditionally** from the shared
  descriptor so D20 yields `d20`, not `signer_unknown`. `presence:true` signers (only `p256`) may carry the two
  quarantine os-presence ops (§7.1).
- **SP-3 alg-agility (ADR-0002):** `crypto.ts` gains `verifyP256Bytes`/`parseP256PublicKeyFlexible`/
  `signP256Bytes`/`generateP256` (DER X9.62 ECDSA-SHA256, ≤72-byte bound, default DER `dsaEncoding`,
  curve-checked + canonical-DER round-trip, fail-closed, verify-never-byte-compare). `authorize.ts` dispatches
  the signature step on the enrolled signer's `alg` (absent ⇒ ed25519; verify ORDER unchanged); D20 widened to a
  set via the single `TEST_SIGNER_DESCRIPTOR` (`TEST_SIGNER_IDS`). No new error codes — a prefix/alg mismatch is
  `authz.signature_invalid`. The `atlas-signer` SE signer + enrollment live in [`console/signer/`](../../console/signer/CLAUDE.md) + [`provisioning/`](../../provisioning/CLAUDE.md).
- `git.ts` — `BrokerGit`: privileged plumbing via `execFile` argv (never a shell). **Deterministic
  authorship** `Aryeh Stark <aryeh@21stark.com>` + fixed dates — load-bearing for reproducible audit
  SHAs. Package-internal, never re-exported. `crypto.ts` — Ed25519 + `atlas-jcs-v1`; native `ed25519:`
  AND OpenSSL-PEM. `errors.ts` — `BrokerRefusal` + `AUTHZ_ERROR_CATALOG` (mirrors §7.3) + `BROKER_ERROR_CATALOG`.
- `bin/atlas-broker.ts` — daemon entry; exits `4` on startup failure; **never sets `ATLAS_TEST_MODE`** (D20).

### Egress broker (`src/egress/`)
- `server.ts` — `EgressService.invoke` (8-step pipeline) + `startEgressServer`. Per-connection
  AbortController for `cancel`/disconnect; **refuses to start over a LIVE socket** (singleton guard).
- `capability.ts` — `mintEgressCapability`/`verifyCapability`: HMAC-SHA256 over canonical claims
  (runId/operation/model/maxBytes/maxTokens/costCeiling/allowedSensitivity/…), keyId-tagged,
  constant-time compare, TTL 300s. `SENSITIVITY_ORDER` public<internal<confidential<restricted.
- `scan.ts` — `scanEgressPayload`: runs `@atlas/scan` `scanBytes`, quarantines on dirty, throws
  `egress.secret_detected` carrying only ruleIds (INVARIANT 2 / ADR-0001).
- `gemini.ts` — `GeminiAdapter` (sole credential holder): `serialize`→`transmit`→`parse` three-phase
  so the server scans EXACT bytes. Fixed per-op model allowlists + conservative pricing;
  `redirect:"error"` (never leak the key).
- `budget.ts`/`budget-store.ts` — `RunBudget` atomic reserve→reconcile/release; `FileBudgetStore`
  persistent tally (temp-then-rename `0600`, `O_CREAT|O_EXCL` lock with stale-steal). Corrupt file
  THROWS (never silently zeroes allowances).
- `spool-quarantine.ts` — `SealedSpoolQuarantineSink`: X25519 sealed-box, ciphertext-only, daemon
  holds only the CLI's PUBLIC key. `types.ts` — `ModelCallReceipt` (allowlisted fields, never a raw payload).
- `protocol.ts`/`client.ts`/`errors.ts`/`{provider-error,prompt-registry,schema-registry}.ts`.
- `bin/atlas-egress.ts` — daemon entry; constructs adapter + sealed-spool sink + persistent budget store.

## IPC surface & signing entry points

**Integration `BROKER_METHODS` (9):** `appendAuditEvent`, `signAndAppendAuditEvent`,
`getAuditChainStatus`, `advanceProtectedRef`, `integrateSourceCapture`,
`signAndIntegrateSourceCapture`, `signAndAdvanceProtectedRef`, `mintChallenge`, `execAuthorized`.
**Egress:** exactly one — `invoke` (+ out-of-band `cancel` frame).

**Why so many `sign*` methods (F4):** the unprivileged CLI cannot hold the attestation key, and
`signAndAppendAuditEvent` **refuses canonical-installing kinds** (the purpose-bound gate). So the
broker signs `run.integrated`/`run.rolled_back` INTERNALLY inside the ref-move under the mutation
lock — `signAndIntegrateSourceCapture` (Tier-1 capture, #77) and `signAndAdvanceProtectedRef`
(general-scope synthesis/approve/rollback, #112). Do **not** add a client-side signing shortcut.

**Config env (production, `loadBrokerConfigFromEnv`):** `ATLAS_BROKER_KEYS_DIR`,
`ATLAS_VAULT_REPO_DIR`, `ATLAS_BROKER_SOCKET`, `ATLAS_AUDIT_ANCHOR_PATH` (defaults per-OS:
`/usr/local/var/atlas/audit-anchor` darwin, `/var/lib/atlas/audit-anchor` linux), `ATLAS_TEST_MODE`.
**Egress:** `ATLAS_EGRESS_SOCKET`, `ATLAS_EGRESS_KEYS_DIR` (holds `atlas.gemini.key` only),
`ATLAS_EGRESS_CAPABILITY_KEY` (shared/CLI-readable) **or** `ATLAS_EGRESS_CAPABILITY_KEY_FD`
(command-scoped fd, #60 Phase 6) — both resolved by the one `src/egress/capability-custody.ts`
that the CLI mint path also uses, fail-closed, fd wins, fd never bootstraps —
`ATLAS_EGRESS_QUARANTINE_PUBKEY`,
`ATLAS_EGRESS_QUARANTINE_SPOOL`, `ATLAS_EGRESS_BUDGET_STATE`. **Refs:** canonical ref is **config-supplied** (`git.canonical_ref`, default `refs/atlas/main` for adopted vaults, `refs/heads/main` for plain vaults) — the broker reads it from config, never hardcodes it. Audit: `refs/audit/runs`; trust: `refs/trust/ledger`. Exit codes `0..6`; `egress.secret_detected` = 3,
`egress.capability_invalid` = 1.

## Invariants & guardrails

1. **Broker is the SOLE protected-ref mutator** — enforced by file permissions, not policy (refs
   `0640` owner-write, object store `2770` setgid, §3.2). An object is inert until a protected ref points at it.
2. **Acyclic seam:** never imports `@atlas/sqlite-store` (`test/broker.no-ledger-dep.test.ts`).
3. **Service-wide mutation lock:** audit append + ref CAS never interleave (`runExclusive`).
4. **Only the attestation identity signs the audit stream.** A valid approval signer is rejected on
   the audit path fail-closed; `signAndAppend` refuses installing kinds (`test/audit-signing-oracle.test.ts`).
5. **Audit chain:** signed-only, gapless seq (prev+1), chained `prevAuditHead`, content-keyed
   idempotency on `(runId,seq)` (sig+prevHead excluded → crash re-drive is byte-stable; a *different*
   event on the same key ⇒ `broker.audit_idempotency_conflict`). Full re-verify at `init()`.
6. **WORM anti-truncation/rewrite:** anchored head must sit at its exact position; live count <
   anchored ⇒ truncation; a missing anchor while events exist is a fault (`verifyLiveChain`).
7. **Authorization binds a CONCRETE op+effect** — an authorization for op A can never authorize op B
   (per-field drift refusal); embedded `\r`/`\n` ⇒ `authz.payload_mismatch` (injective encoding).
8. **Nonce single-use, TTL-bounded, consumed LAST**; cross-op reuse ⇒ `authz.nonce_unknown`.
9. **Canonical-bound LEDGER ops re-derive the base from broker state** — a caller can't smuggle an
   all-zero base past the drift gate.
10. **Capture scope:** a Tier-1 capture touches ONLY `sources/**` + `manifest.*`, over the WHOLE `base..capture` range; the `"note"` scope (#262, selected by the capture RPC's optional `scope` field) instead requires additions-only (`A`) `*.md` outside `sources/`, status-checked over the same range; the `"sync"` scope (#266, the 60-B absorb cycle) allows A/M/D/R (and C) of `*.md` outside `sources/` — both sides of a rename validated, unknown statuses (T/U/X/B) and empty change-sets refused fail-closed — so a sync commit can mirror upstream note changes but can never touch the capture namespace, non-markdown, or `.git`.
11. **D20 test-signer gate:** `atlas-test-approver` is hard-rejected unless `ATLAS_TEST_MODE=1`
    (`test/broker.rejects-test-signer-in-prod.test.ts`); the launcher never sets it.
12. **Egress scans the EXACT bytes:** request = exact serialized HTTP body; error/retry bodies raw;
    **final 2xx = the canonical serialization of the RELEASED result** (ADR-0001).
13. **Per-run budget is the real spend boundary:** atomic reserve → reconcile to actual; unpriced
    model refused (never charged at zero); persistent store survives restart (no ceiling reset on replay).
14. **Egress custody:** daemon holds ONLY the provider key + capability-MAC secret + the quarantine
    PUBLIC key — never the AEAD key (trusted-CLI-only, §4). Quarantine is ciphertext-only (X25519).
15. **No raw stack crosses either seam** (`broker.internal` / `egress.internal`).

## Gotchas & sharp edges

- **The broker validates `refs/audit/runs` at STARTUP** (`AuditLog.init` full re-verify + anchor
  bind) — start it only AFTER the vault copy exists. A live-drive broker needs its OWN vault repo +
  a FRESH anchor: a fresh **clone** of grad-copy drops the custom `refs/audit/*`, so a fresh ledger's
  seq 0 no longer collides with graduation's (`seq 0 is not next 1`). Point `ATLAS_VAULT_REPO_DIR` +
  config `vault.path` at that clone, separate anchor. See
  [`docs/retros/2026-07-18-search-index-live-drive-retro.md`](../../docs/retros/2026-07-18-search-index-live-drive-retro.md) §1.
- **Nonce store is in-memory** and the apply challenge nonce has a **5-min default TTL** — a broker
  restart or a slow operator invalidates it (a ~2h gap expired it on the 2026-07-17 drive). Sign +
  apply promptly.
- **Export `ATLAS_EGRESS_CAPABILITY_KEY` for EVERY mint-bearing command** (`index rebuild`, `index
  eval`, `query`) — the CLI mints capabilities against the same secret the daemon verifies; without
  it every `invoke` fails `egress.capability_invalid`.
- **Gemini `thoughtSignature` false positive (ADR-0001, #146/#148):** the raw-envelope response scan
  flagged Gemini 3.5's high-entropy reasoning signature as a secret and refused EVERY `generateText`.
  Scan now runs on RELEASED bytes; discarded envelope fields never re-enter the host; `thought:true`
  parts are dropped in `parse` (#149). Do not revert the scan to raw response bytes.
- **Pricing is conservative-by-design (≥ published rate).** The earlier low figures under-reserved
  10–30×, making the ceiling meaningless — do not "correct" prices down.
- **Deterministic git authorship in `src/git.ts`** (fixed name/email/date) is load-bearing for
  reproducible audit-chain SHAs — changing it churns fixtures. Socket `0660` chmod is best-effort
  (provisioning owns the final mode; startup never fails on chmod).
- **`SIGNATURE_AUTHORIZABLE_OPS` ≠ every privileged op** — `quarantine inspect/resolve` are
  `os-presence` (not signature-authorizable), and `git reject` is shared. Don't add ops there without
  a matching authorization path.
- **Second-daemon overrun:** `startEgressServer` refuses a LIVE socket; the budget store's
  cross-process lock guards the residual race of two daemons on DIFFERENT socket paths for one run.

## History (real PR numbers — exactly 7 commits touch this package)

- **#61** — Phase-0 scaffold (empty `index.ts`).
- **#66** — Phase-1 broker trio (#22/#23/#25): the entire integration broker + 17 test files, with
  8 real security defects fixed in-PR. Where the round-2/round-3 findings landed: mutation lock,
  attestation-only audit signer, WORM position-bind, canonical-bound-op re-derivation, capture-scope
  range, nonce validate/consume split, D20 gate, injective encoding.
- **#76** — egress broker + `@atlas/models` + operation gate + the D17 sandbox-escape fix: the whole
  `src/egress/**` tree. Origin of the concurrent-daemon guard, persistent budget, sealed-spool
  quarantine, transmit-hook response scan (fixed plaintext spool, restart budget reset, unscanned
  error/retry bodies, model allowlist, redirect credential leak).
- **#77** — ingest capture pipeline: `signAndIntegrateSourceCapture` + broker-side signing for the
  unprivileged-CLI capture path.
- **#112** — `signAndAdvanceProtectedRef` (#53, Task 1.6/4.9): general-scope broker sign-and-advance
  for synthesis/approve/rollback.
- **#148** — egress response scan on RELEASED bytes, not the raw envelope (ADR-0001, #146).
- **#149** — Gemini `parse` drops thought parts; reasoning traces never release.

Recurring themes: bind every authorization/audit event to broker-OBSERVED state (never
caller-supplied); fail-closed everywhere (unknown nonce, missing anchor, corrupt budget, unpriced
model); the attestation key is the single audit trust root; close every race with a lock (mutation
lock, budget CAS, socket singleton); scan the EXACT bytes, and only the bytes that cross a boundary.

## Open items

- **Nonce persistence is out of Phase-1 scope** (`src/nonce.ts`) — in-memory, fail-closed on restart;
  a durable store is future work.
- **Capability threat model is local-first V1** (`src/egress/capability.ts` header) — the CLI holds
  the mint secret, so the capability BOUNDS a compromised agent's export/spend but is NOT unforgeable
  against a fully-compromised CLI. A remote isolated issuer is V2; the real boundary is egress-side
  enforcement (capability + budget + scan).
- **`effectiveSensitivity` uses the DECLARED value** (Phase-2, `server.ts` step 4 / `capability.ts`)
  — real derivation from taint/tier is deferred.
- **Repo-wide open issues touch broker-adjacent flows but land elsewhere:** **#65** (ledger/backup
  hardening) — the seq-allocator-rewind-after-older-cut-restore finding is broker-file-scoped
  (`src/audit-append.ts`), the rest are in `@atlas/sqlite-store`. **#60** (graduation E2E) — remaining
  slices exercise the PRODUCTION authorizer (Flow B) + D20 test-signer rejection, but land in `apps/cli`.
