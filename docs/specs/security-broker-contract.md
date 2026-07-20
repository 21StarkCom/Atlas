# Atlas — Security / authorization / broker contract (normative)

> **Status:** normative contract · **Version:** 1 · **Phase:** 0 (lands before any security/broker code).
> **Owner task:** 0.3 (`task-0-3-security-broker-contract`) · **Repo:** `21StarkCom/Atlas`
> **Consumes:** implementation-plan decisions **D1** (CI two-UID mechanism), **D6** (audit
> mapping for privileged ledger ops), **D8** (WORM anchor default path), **D9** (key custody per
> OS), **D10** (broker IPC), and **D13** (privilege-boundary scope), plus the design spec's
> *Integration guard*, *Egress guard*, and *Non-interactive authorization CLI contract* sections.
> References are **consumed** here, not duplicated — the plan §-anchors remain authoritative.
> **Produces:** the single source of truth for the privilege boundary. Tasks **1.0** (git/broker
> package), **1.1** (`contracts` Zod mirrors + `contracts.authorization.test`), **1.6** (audit
> ledger), **1.7** (erasure/`purge`), **4.9** and **4.10** consume this contract. Task 1.1 mirrors
> every JSON schema below as Zod and asserts the JSON examples here validate against those mirrors.

This document fixes the **privilege boundary** for Atlas: what the OS-level brokers protect, the
filesystem and key ACLs that enforce it, the challenge/response protocol that authorizes every
privileged operation, the audit-event payload, and the erasure protocol. It is normative. Where a
value has a per-OS default it is quoted from the decision that fixes it (D8/D9/D10) rather than
re-decided here.

---

## 1. What this is

The **single source of truth** for:

- the **protected-ref set** and the filesystem permission model that makes those refs broker-only-writable;
- the **per-key ACL matrix** — which OS identity may read each key;
- the **WORM audit-anchor format** at D8's path;
- the **challenge/response JSON schemas** (`AuthorizationChallenge`, `AuthorizationResponse`) and the **drift-rejection error catalog**;
- the **Ed25519 signing envelope + canonicalization** rule (byte-stable across processes);
- the **nonce store + expiry** and **signer registry** semantics;
- the **key rotation/revocation** procedure;
- the **audit-event payload schema** with **opaque salted IDs** and the **ledger mapping table**;
- the **D6 event-mapping** for privileged ledger ops;
- the **signed-tombstone audit-ref replacement protocol** for erasure.

## What this is not

- **Not** the deployment/provisioning runbook — user/group creation, launchd/systemd supervision,
  socket peer-auth, and installation gating live in `docs/specs/broker-deployment.md` (consumes D1/D9/D10).
- **Not** the SQLite schema — table/column definitions live in `docs/specs/sqlite-data-dictionary.md`.
  This contract references the ledger tables (`audit_events`, `audit_outbox`, `egress_outbox`,
  `audit_seq`, the nonce/replay store) but does not redefine their columns.
- **Not** the CLI surface — command names + privilege classification derive from the canonical
  `commands.json` registry (`docs/specs/cli-contract/`). This contract binds each **privileged
  variant** to its challenge/verification/error semantics; it does not enumerate the full CLI.
- **Not** the provider-interface contract — the model error taxonomy is defined there; this doc only
  fixes the egress broker's credential/network custody and its per-call audit events.

---

## 2. Privilege boundary scope (D13 — load-bearing)

The OS privilege boundary protects **exactly three asset classes**, and nothing else:

| # | Protected asset | Owning identity | Who may write | Who may read |
|---|-----------------|-----------------|---------------|--------------|
| (a) | **Protected git refs** — canonical branch, `refs/audit/runs`, the trust ledger ref | `atlas-broker` | broker only | `atlas-git` group (agents read to branch from canonical) |
| (b) | **WORM audit anchor** (§6) at D8's path | `atlas-broker` | broker only | broker only (`0600`) |
| (c) | **Provider credential + outbound network** | `atlas-egress` | egress broker only | egress broker only |

**The SQLite ledger DB is NOT broker-owned.** Per D13, the unprivileged CLI opens the ledger via
`better-sqlite3` **directly** and writes ledger + projection rows **in-process**. There is **no
store service / trusted-CLI daemon**. `finalizeLedgerWrite` runs its `write` closure in the CLI
process and only *calls* `broker.appendAuditEvent` for the git-ref side of an integration.
Tamper-evidence for the ledger comes from the **broker-signed `refs/audit/runs` cross-check + the
external WORM anchor** (§6), **not** from gating SQLite writes.

> Consequence for backups (see §4): the **backup AEAD key is trusted-CLI-readable** because the CLI
> process that writes the ledger encrypts/decrypts its own backup. The broker gates restore
> **authorization** via the `db.restore` challenge (§7), but the crypto runs CLI-side — no broker
> backup-IPC primitive exists.

There are **two brokers**, running as **separate privileged OS identities** (D1/D9/D10):

- the **integration broker** (`atlas-broker`) — owns (a) + (b), lands as a **Phase-1** gate;
- the **egress broker** (`atlas-egress`) — owns (c), lands as a **Phase-2** gate (first provider call).

Each is reached over a **Unix-domain-socket framed-JSON IPC** whose messages are validated by the
`contracts` schemas on both sides (D10). Socket paths + modes are D10's; this contract does not
re-decide them.

---

## 3. Protected refs + filesystem permission model

### 3.1 Protected-ref set

The following refs are **broker-only-writable** (writes rejected for any non-`atlas-broker` peer):

| Ref | Meaning | Writer | Readable by |
|-----|---------|--------|-------------|
| `refs/heads/<canonical>` | canonical integrated history | broker | `atlas-git` group |
| `refs/audit/runs` | append-only signed audit-event stream (§5) | broker | `atlas-git` group |
| `refs/trust/ledger` | source-trust promote/revoke ledger | broker | `atlas-git` group |

Agent-proposed work lands under **`refs/agent/*`**, which is **agent-owned** (the agent user, group
`atlas-git`) — the broker reads these to review/integrate, but agents write them freely.

### 3.2 Filesystem permission model (fixes R3-F2)

Applied by provisioning (D1); asserted by `brain doctor` / `brain git verify`.

| Path class | Owner | Group | Dir mode | File mode | Rationale |
|------------|-------|-------|----------|-----------|-----------|
| Protected refs + ref-dirs `refs/heads`, `refs/audit`, `refs/trust`, packed-refs | `atlas-broker` | `atlas-git` | `0750` | `0640` | **group-readable** so agents read canonical to branch from it; **broker-only writes** |
| Git **object store** (`objects/`) | `atlas-broker` | `atlas-git` | `2770` (setgid) | `0664` | **group-writable**: agents MUST write blobs/trees/commits for their `refs/agent/*` work (an object is inert until a protected ref references it — safety comes from ref-gating, not object-gating). New objects inherit group `atlas-git` via setgid. |
| `refs/agent/*` (agent proposals) | agent user | `atlas-git` | `0770` | `0640` | agent-owned; broker reads for review |
| WORM audit anchor (D8 path) | `atlas-broker` | `atlas-broker` | `0700` (parent) | `0600` | broker-only; agent-unreadable |

- Group-readable canonical is deliberate: an agent **MUST** be able to read the canonical tip to
  create a `refs/agent/*` branch from it, but **MUST NOT** be able to write any protected ref. The
  `0640` file mode + `0750` dir mode + ownership give exactly that (read for group, write for owner only).
- A compromised agent **cannot** integrate a Tier-3 change without a broker-verified signature (§7),
  because it **physically cannot write the protected ref** — file permissions, not policy, enforce this.
  It *can* write objects (harmless: unreferenced) and `refs/agent/*` (its own proposals); only the
  broker advances canonical/`refs/audit`/`refs/trust`.

### 3.3 Tier-1 capture scope (`integrateSourceCapture`)

Tier-1 captures are the one non-signature path that advances canonical (fast-forward CAS only; see
`workflow-risk-contract.md` for the tier semantics). Safety comes from a **broker-enforced path
scope** checked over the **whole `base..capture` range** — every commit the capture adds, not just
the tip — so a multi-commit capture cannot smuggle a forbidden path through an earlier commit while
the tip stays clean. The capture RPC's optional `scope` field selects the scope (default
`"sources"`); any violation refuses `broker.capture_scope_violation` and canonical does not move.

| Scope | Allowed changes |
|-------|-----------------|
| `"sources"` (default) | any path under `sources/**` + capture manifests (`manifest.json`/`.yaml`/`.yml`) — adds AND updates (recaptures rewrite the observation manifest in place) |
| `"note"` (#262 — authored-note ingest) | **additions only** (git status `A`) of `*.md` paths outside `sources/` — **status-checked** over the same whole range, so an authored-note capture can never modify, delete, or rename existing content |
| `"sync"` (#60/#266 — continuous-vault-sync absorb) | **adds, modifications, deletions, and renames/copies** (git statuses `A`/`M`/`D`/`R*`/`C*`, rename/copy scores stripped) of `*.md` paths outside `sources/` — **status-checked** over the same whole range, with **both** paths of a rename/copy validated (a rename into OR out of `sources/` is refused on whichever side lands there). Any **other** status (`T` typechange, `U`, `X`, `B`, or unrecognized) **fails closed** with `broker.capture_scope_violation`, as does an **empty** change set |

`scope` is a **policy selector, not trusted input**: the broker re-derives the verdict entirely from the **broker-observed** committed diff (name-status over the whole range, read via NUL-terminated `-z` so non-ASCII paths are never mangled) — the flag only chooses which self-verifying policy runs. `"note"` is additions-only and `"sources"` only rewrites `sources/**` manifests, so neither lets a caller (even a fully-compromised agent reaching the socket) modify or delete another note. `"sync"` deliberately CAN mutate and remove notes — mirroring upstream vault edits is its purpose — but only `*.md` outside `sources/`, so a sync absorb can never touch captured source material, manifests, or any non-markdown byte on canonical. Path checks are **case-insensitive** and reject any `.git` component, `..`/absolute segment — the enforcement boundary is here, not the CLI's advisory `deriveDestPath`. A note-add integration is **distinguishable in the permanent record**: the canonical commit the signed `run.integrated` event binds to carries the message `note add <id>` (vs `capture <id>`), so an auditor walking the chain sees exactly which integrations were authored-note ingests.

---

## 4. Per-key ACL matrix

Every key names the **exact OS identities** that may read it (D9 custody: macOS per-identity login
keychains / Linux root-provisioned `/etc/atlas/keys/<identity>/` dirs at `0700`). "trusted-CLI"
means the unprivileged CLI process that opens the ledger (per D13 there is no separate daemon).

| Key | Purpose | Readable by | Held where | Notes |
|-----|---------|-------------|------------|-------|
| **approval-verify** (Ed25519 **public**) | broker verifies approval/authorization signatures | `atlas-broker` | broker keychain/dir | public verify key only; signer registry (§9) maps `signerId` → this |
| **audit-attestation** (Ed25519) | signs `refs/audit/runs` events + WORM anchor | `atlas-broker` | broker keychain/dir | broker-only signer of the audit stream |
| **audit-attestation-pub** (public) | agents verify the audit stream they read | `atlas-git` (agent-readable **by design**) | group-readable | read-only verification; agents cannot forge events |
| **backup AEAD** (symmetric) | encrypt/decrypt encrypted ledger backup | **trusted-CLI** | CLI keychain/dir | CLI writes ledger → CLI owns backup crypto (D13); broker gates restore *authorization* only |
| **quarantine AEAD** (symmetric) | encrypt/decrypt quarantined untrusted content | **trusted-CLI only** | CLI keychain/dir | **parser/model-denied** — never loaded into a parser or model process |
| **`atlas.gemini.key`** (provider credential) | Gemini API auth | **egress-broker-only** | egress keychain/dir | sole holder is `atlas-egress`; never in agent/parser/workflow |

**Invariant:** no key is readable by more identities than its row lists. `atlas.gemini.key`,
quarantine AEAD, and the audit-attestation **private** key are each held by exactly one identity.

---

## 5. Audit-event payload schema

Audit events are appended to **`refs/audit/runs`** (git-ref stream) and mirrored to the ledger's
`audit_events` table. Each event is an Ed25519 envelope (§8) whose `payload` is:

```json
{
  "schemaVersion": 1,
  "eventId": "01J9Z8Q3H4K5M6N7P8R9S0T1V2",
  "kind": "run.integrated",
  "seq": 4213,
  "occurredAt": "2026-07-12T09:14:22.581Z",
  "runId": "01J9Z8Q0000000000000000000",
  "subjects": [
    { "type": "note", "opaqueId": "n_9f2c1a8e0b3d4f56", "saltVersion": 1 },
    { "type": "source", "opaqueId": "s_71ad0c93e4f2bb18", "saltVersion": 1 }
  ],
  "canonicalCommit": "b7e23c9d4a1f6082e5c3d90a1b2c3d4e5f607182",
  "prevAuditHead": "9a1c2b3d4e5f60718293a4b5c6d7e8f901234567",
  "detail": { "tier": 3, "effectiveRisk": "tier-3", "authorizationRef": "authz_01J9Z8Q3" }
}
```

- **`eventId`** — ULID, stable, monotonic-ish. **`seq`** — the monotonic event count matched against
  the WORM anchor (§6); a gap or regression is a truncation and fails verification.
- **`subjects[].opaqueId`** — **opaque salted IDs** (§5.1). No note/source natural identifier, path,
  title, or content ever appears in an audit payload. This is what lets ordinary erasure need **no
  ref rewrite** (§10).
- **`kind`** — one of the versioned event kinds; the privileged-ledger-op kinds are fixed by D6 (§11).
- **`prevAuditHead`** — the prior audit head hash, chaining the stream so any excision is detectable
  against the anchor.

### 5.1 Opaque salted IDs + ledger mapping table

An opaque ID is `"<prefix>_" + hex(HMAC-SHA256(salt[saltVersion], entityKind + "\\x00" + naturalId))[:16bytes]`,
where `\x00` is a single **NUL byte** used as an unambiguous domain separator — written here as an
explicit escape so this contract stays a text file and the HMAC input `<entityKind> 0x00 <naturalId>`
(UTF-8, no surrounding quotes) is byte-stable across processes.

- The **salt** is a per-deployment secret held with the trusted-CLI key material (never in the vault,
  never agent-readable). `saltVersion` names which salt was used, so salt rotation stays verifiable.
- The **ledger mapping table** `audit_id_map` (defined in the data dictionary) is the **only** place
  the `opaqueId ↔ naturalId` correspondence is stored, and it lives in the SQLite ledger (CLI-owned,
  D13) — **never** in the git-ref stream. Erasing a note deletes its `audit_id_map` row, after which
  the `refs/audit/runs` events referencing that `opaqueId` become **unlinkable** without rewriting
  the append-only stream.

```json
{
  "opaqueId": "n_9f2c1a8e0b3d4f56",
  "entityKind": "note",
  "naturalId": "note/2026/atlas-privilege-model",
  "saltVersion": 1
}
```

> Acceptance-relevant: the ledger mapping is a table, not a payload field — the audit payload carries
> only the opaque side.

---

## 6. WORM audit-anchor format (D8)

The broker records the `refs/audit/runs` head into an **append-only / WORM location outside the
agent-writable repository**, at **D8's path**:

- Linux: `/var/lib/atlas/audit-anchor` · macOS: `/usr/local/var/atlas/audit-anchor`
- broker-owned `0600`, parent dir `0700`, **outside** the vault and repo (fixes R3-F3).

Each anchor record is an append-only line (never rewritten), an Ed25519 envelope (§8) over:

```json
{
  "schemaVersion": 1,
  "anchoredAt": "2026-07-12T09:14:22.913Z",
  "auditHead": "b3d7e8f901234567b3d7e8f901234567b3d7e8f9",
  "eventCount": 4213,
  "signerId": "atlas-audit-attestation-v1"
}
```

- **`eventCount`** is monotonically increasing. On startup and in `brain doctor` / `brain git
  verify`, the current audit head is checked against the latest anchor: **any truncation or rewrite
  of a valid audit suffix is detectable** even after SQLite loss, because the anchor's `eventCount`
  exceeds what a truncated ref carries. Disagreement forces **fail-closed**.
- Agents cannot write the anchor (`0600`, broker-owned).

---

## 7. Authorization: challenge / response

Every **privileged operation** is authorized by **exactly one of two broker-verifiable mechanisms,
and nothing else** (design spec *Integration guard*): an **OS-mediated presence assertion bound to
the exact broker challenge** (interactive), or the **non-interactive external signing flow**
(`--export-challenge` → sign with a separately held key the agent process cannot read →
`--authorization`). A typed `"yes"` / `--yes` is a **cosmetic prompt bypass only and NEVER
authorization**.

The privileged subset derives from the canonical `commands.json` registry (**sole authority** for
privilege classification). Every command the registry marks `privilege: "privileged"` is authorized
here, plus the one privileged **variant** of a shared command that the plan defines (`db backup
--force-unblock`, D6). The registry-privileged set is (registry names): `db restore`, `git approve`,
`git rollback`, `graduation migrate`, `purge`, `quarantine inspect`, `quarantine
resolve`, `source trust promote`, `source trust revoke`. Note that `git reject` and `git refresh`
are **shared, not privileged** (rejecting a proposal writes no protected ref; refresh only
regenerates a review-pending proposal's agent branch — no canonical/trust/erase mutation — the
operator must still approve it at the review gate) and are therefore **not** in this set.

The machine-readable **§7.5 `authzContract` block** is the SSOT for the op→challenge→verification→
error mapping; the `contract-lint` gate asserts it covers **exactly** the registry-privileged set
(bijection over non-variant ops) so this contract can never silently drift from `commands.json`. The
prose tables below (§7.3, §7.4) mirror that block for readability.

### 7.1 `AuthorizationChallenge` (emitted by `--export-challenge`)

```json
{
  "schemaVersion": 1,
  "op": "git approve",
  "runId": "01J9Z8Q0000000000000000000",
  "targetCommit": "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
  "canonicalBaseCommit": "b7e23c9d4a1f6082e5c3d90a1b2c3d4e5f607182",
  "intendedEffect": {
    "kind": "integrate",
    "tier": 3,
    "changePlanDigest": "sha256:3f9a...c012"
  },
  "nonce": "9c1f7b2e4d6a8c0e1f3b5d7a9c1e2f40",
  "expiresAt": "2026-07-12T09:19:22.581Z",
  "payloadCanonicalization": "atlas-jcs-v1",
  "signingPayload": "atlas.authz.v1\ngit approve\n01J9Z8Q0000000000000000000\na1b2c3d4e5f60718293a4b5c6d7e8f9012345678\nb7e23c9d4a1f6082e5c3d90a1b2c3d4e5f607182\n9c1f7b2e4d6a8c0e1f3b5d7a9c1e2f40"
}
```

- The `op` value is the **canonical registry command name** (`git approve`, `graduation migrate`, …)
  or, for the one privileged variant, `db backup --force-unblock`.
- `runId`, `targetCommit` are **optional per op** (absent for ops with no run/commit target, e.g.
  `db backup --force-unblock`). `canonicalBaseCommit`, `intendedEffect`, `nonce`, `expiresAt`,
  `payloadCanonicalization`, `signingPayload` are **required**.
- `intendedEffect` is **op-specific** (see §7.4). For `rollback` it includes the
  **deterministically derived intended revert commit** (`revertCommit`); for `db restore` it
  includes the **backup ref + its content hash**; for `backup-force-unblock` it is bound to the
  latest ledger sequence + accepted-RPO-gap.
- `signingPayload` is the **exact canonical byte string to sign** (§8) — the signer authorizes a
  concrete effect, never an abstraction.

### 7.2 `AuthorizationResponse` (submitted by `--authorization <file>`)

```json
{
  "schemaVersion": 1,
  "challenge": {
    "schemaVersion": 1,
    "op": "git approve",
    "runId": "01J9Z8Q0000000000000000000",
    "targetCommit": "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
    "canonicalBaseCommit": "b7e23c9d4a1f6082e5c3d90a1b2c3d4e5f607182",
    "intendedEffect": { "kind": "integrate", "tier": 3, "changePlanDigest": "sha256:3f9a...c012" },
    "nonce": "9c1f7b2e4d6a8c0e1f3b5d7a9c1e2f40",
    "expiresAt": "2026-07-12T09:19:22.581Z",
    "payloadCanonicalization": "atlas-jcs-v1",
    "signingPayload": "atlas.authz.v1\ngit approve\n01J9Z8Q0000000000000000000\na1b2c3d4e5f60718293a4b5c6d7e8f9012345678\nb7e23c9d4a1f6082e5c3d90a1b2c3d4e5f607182\n9c1f7b2e4d6a8c0e1f3b5d7a9c1e2f40"
  },
  "signature": "ed25519:1f8a3c...a0",
  "signerId": "atlas-approver-hsm-01"
}
```

The **execute step re-derives the challenge from current state and rejects any drift** with the
stable error codes of §7.3 **before the broker acts**. The full challenge is echoed back so the
broker verifies the signature over the exact bytes the signer saw.

### 7.3 Drift-rejection error catalog (stable codes)

Every code is stable across versions. `exitCode` maps to §2.5 of the plan (`0` ok · `1` validation ·
`2` config/vault · `3` secret-scan · `4` internal · `5` user/usage · `6` action-required).

| Code | Meaning | Exit |
|------|---------|------|
| `authz.ok` | signature/presence valid, no drift, op authorized | `0` |
| `authz.canonical_moved` | `canonicalBaseCommit` no longer the canonical tip | `6` |
| `authz.target_mismatch` | `targetCommit`/`runId` differs from re-derived challenge | `6` |
| `authz.revert_mismatch` | derived `revertCommit` differs (`git rollback`) | `6` |
| `authz.backup_hash_mismatch` | `db restore` backup content hash changed | `6` |
| `authz.generation_mismatch` | `graduation migrate` current generation ≠ challenge `fromGeneration` | `6` |
| `authz.migration_plan_mismatch` | `graduation migrate` re-derived plan digest differs | `6` |
| `authz.trust_level_mismatch` | trust `promote`/`revoke` current level ≠ `fromLevel` | `6` |
| `authz.rpo_gap_unaccepted` | `db backup --force-unblock` accepted-RPO-gap stale | `6` |
| `authz.quarantine_item_unknown` | quarantine item opaque id not found / not quarantined | `1` |
| `authz.quarantine_key_denied` | quarantine AEAD key not readable by this trusted-CLI identity | `2` |
| `authz.nonce_unknown` | nonce not issued by this broker | `1` |
| `authz.nonce_expired` | `expiresAt` passed (§8.2) | `6` |
| `authz.nonce_replayed` | nonce already consumed | `1` |
| `authz.signer_unknown` | `signerId` not in the signer registry (§9) | `1` |
| `authz.signer_revoked` | signer revoked (§10) | `1` |
| `authz.signer_not_permitted` | signer not permitted for this `op` | `1` |
| `authz.signature_invalid` | Ed25519 verification failed | `1` |
| `authz.payload_mismatch` | `signingPayload` ≠ broker-recomputed canonical bytes | `1` |
| `authz.schema_invalid` | challenge/response fails the `contracts` schema | `1` |
| `authz.canonicalization_unsupported` | unknown `payloadCanonicalization` id | `1` |
| `authz.presence_unverified` | interactive/presence path: OS presence assertion absent/unbound | `6` |

Idempotency: re-submitting an already-consumed authorization for an op whose effect is already
present returns `authz.ok` with a `noop: true` detail (safe replay of a *completed* op), whereas a
fresh submission of a spent nonce for an *incomplete* op is `authz.nonce_replayed`.

### 7.4 Per-privileged-op mapping (challenge fields → verification → codes)

Two authorization **mechanisms** appear (§7 intro): `broker-signature` (the non-interactive Ed25519
challenge/response, or its OS-presence interactive equivalent bound to the same challenge) and
`os-presence` (the trusted-CLI local presence assertion for the quarantine-AEAD ops, which never
touch a protected ref and so are not broker-signed). `nonce_*` = `nonce_unknown` / `nonce_expired` /
`nonce_replayed`; `signer_*` = `signer_unknown` / `signer_revoked` / `signer_not_permitted`.

| Op (registry name) | Mechanism | Required challenge fields | Verification steps | Drift codes |
|--------------------|-----------|---------------------------|--------------------|-------------|
| `git approve` | broker-signature | `op,runId,targetCommit,canonicalBaseCommit,intendedEffect{integrate,tier,changePlanDigest},nonce,expiresAt` | canonical tip == base; target unchanged; broker re-parses tree, recomputes `effectiveRisk`, matches `changePlanDigest`; signer permitted | `canonical_moved`,`target_mismatch`,`signature_invalid`,`payload_mismatch`,`signer_*`,`nonce_*` |
| `git rollback` | broker-signature | `+ intendedEffect.revertCommit` (broker-derived) | derive revert commit from target run + canonical; compare; verify signature over payload incl. `revertCommit` | `revert_mismatch`,`canonical_moved`,`signature_invalid`,`payload_mismatch`,`signer_*`,`nonce_*` |
| `purge` | broker-signature | `op,intendedEffect{erase,oldHead,replacementHead,scope},nonce,expiresAt` | derive replacement head deterministically; match `replacementHead`; authorize the signed non-fast-forward canonical-ref replacement (§12.2) | `target_mismatch`,`canonical_moved`,`signature_invalid`,`payload_mismatch`,`signer_*`,`nonce_*` |
| `db restore` | broker-signature | `op,intendedEffect{restore,backupRef,backupContentHash},nonce,expiresAt` | backup ref exists; content hash matches; authorize restore (crypto runs CLI-side, §2) | `backup_hash_mismatch`,`signature_invalid`,`payload_mismatch`,`signer_*`,`nonce_*` |
| `graduation migrate` | broker-signature | `op,intendedEffect{graduate,fromGeneration,toGeneration,migrationPlanDigest},nonce,expiresAt` | current generation == `fromGeneration`; re-derive migration plan digest and match; signer permitted | `generation_mismatch`,`migration_plan_mismatch`,`signature_invalid`,`payload_mismatch`,`signer_*`,`nonce_*` |
| `sync reset` | broker-signature | `op,canonicalBaseCommit,intendedEffect{integrate,tier,changePlanDigest},nonce,expiresAt` | canonical tip == `canonicalBaseCommit` (a concurrent capture is refused ⇒ `canonical_moved`); re-derived `intendedEffect.changePlanDigest` == the challenge's (a changed upstream tree, note-glob set, or reconciliation plan yields a different digest ⇒ `target_mismatch`); the reconciled commit is a fast-forward child of canonical head; signer permitted. Binds the reconciliation via the deterministic plan **digest** (NOT a `targetCommit` — the reconciled child sha is only known post-commit). Re-converges the canonical ref to the upstream TREE (60-B OQ#5 escape hatch) via the same signed fast-forward advance as `git approve`, accepting an audited history gap; not a non-fast-forward rewrite. | `canonical_moved`,`target_mismatch`,`signature_invalid`,`payload_mismatch`,`signer_*`,`nonce_*` |
| `source trust promote` / `source trust revoke` | broker-signature | `op,intendedEffect{trust,sourceOpaqueId,fromLevel,toLevel},nonce,expiresAt` | current trust level == `fromLevel`; signer permitted; append to `refs/trust/ledger` | `trust_level_mismatch`,`signature_invalid`,`payload_mismatch`,`signer_*`,`nonce_*` |
| `db backup --force-unblock` (variant) | broker-signature | `op,intendedEffect{forceUnblock,latestLedgerSeq,acceptedRpoGap},nonce,expiresAt` | latest ledger seq unchanged; accepted-RPO-gap current | `rpo_gap_unaccepted`,`signature_invalid`,`payload_mismatch`,`signer_*`,`nonce_*` |
| `quarantine inspect` | os-presence | `op,intendedEffect{quarantineInspect,quarantineItemOpaqueId},nonce,expiresAt` | item exists and is quarantined; OS presence assertion bound to challenge; quarantine AEAD readable by this trusted-CLI identity | `quarantine_item_unknown`,`quarantine_key_denied`,`presence_unverified`,`nonce_*` |
| `quarantine resolve` | os-presence | `op,intendedEffect{quarantineResolve,quarantineItemOpaqueId,resolution},nonce,expiresAt` | item exists and is quarantined; `resolution ∈ {release,discard}`; OS presence assertion bound; quarantine AEAD readable | `quarantine_item_unknown`,`quarantine_key_denied`,`presence_unverified`,`target_mismatch`,`nonce_*` |

Every privileged op therefore maps to **challenge fields + verification steps + stable error codes**
(acceptance criterion 1). The machine-readable §7.5 block below is the SSOT; `contract-lint` asserts
it covers exactly the registry-privileged set.

### 7.5 `authzContract` (machine-readable — the lint SSOT)

The `contract-lint` gate parses this block and asserts: (a) `privilegedOps` covers **exactly** the
`commands.json` privileged set (bijection over non-`variant` ops); (b) every op names a non-empty
`challengeFields`, `verificationSteps`, and `driftCodes`; (c) every `driftCode` is a member of
`errorCatalog`; (d) every `errorCatalog.exitCode` is in the plan §2.5 set `0..6`. It therefore
mechanically enforces acceptance criterion 1 and can never drift from the registry.

```json authzContract
{
  "version": 1,
  "canonicalization": "atlas-jcs-v1",
  "errorCatalog": [
    { "code": "authz.ok", "exitCode": 0 },
    { "code": "authz.canonical_moved", "exitCode": 6 },
    { "code": "authz.target_mismatch", "exitCode": 6 },
    { "code": "authz.revert_mismatch", "exitCode": 6 },
    { "code": "authz.backup_hash_mismatch", "exitCode": 6 },
    { "code": "authz.generation_mismatch", "exitCode": 6 },
    { "code": "authz.migration_plan_mismatch", "exitCode": 6 },
    { "code": "authz.trust_level_mismatch", "exitCode": 6 },
    { "code": "authz.rpo_gap_unaccepted", "exitCode": 6 },
    { "code": "authz.quarantine_item_unknown", "exitCode": 1 },
    { "code": "authz.quarantine_key_denied", "exitCode": 2 },
    { "code": "authz.nonce_unknown", "exitCode": 1 },
    { "code": "authz.nonce_expired", "exitCode": 6 },
    { "code": "authz.nonce_replayed", "exitCode": 1 },
    { "code": "authz.signer_unknown", "exitCode": 1 },
    { "code": "authz.signer_revoked", "exitCode": 1 },
    { "code": "authz.signer_not_permitted", "exitCode": 1 },
    { "code": "authz.signature_invalid", "exitCode": 1 },
    { "code": "authz.payload_mismatch", "exitCode": 1 },
    { "code": "authz.schema_invalid", "exitCode": 1 },
    { "code": "authz.canonicalization_unsupported", "exitCode": 1 },
    { "code": "authz.presence_unverified", "exitCode": 6 },
    { "code": "diverged:non-ancestral", "exitCode": 2 },
    { "code": "diverged:cursor-unreachable", "exitCode": 2 }
  ],
  "privilegedOps": [
    {
      "op": "git approve",
      "command": "git approve",
      "mechanism": "broker-signature",
      "challengeFields": ["op", "runId", "targetCommit", "canonicalBaseCommit", "intendedEffect", "nonce", "expiresAt"],
      "verificationSteps": [
        "canonical tip equals canonicalBaseCommit",
        "targetCommit unchanged from the run's proposed commit",
        "broker re-parses the tree and recomputes effectiveRisk, matching intendedEffect.changePlanDigest",
        "signerId is enrolled, active, and permitted for this op",
        "Ed25519 signature verifies over the recomputed signingPayload"
      ],
      "driftCodes": ["authz.canonical_moved", "authz.target_mismatch", "authz.signature_invalid", "authz.payload_mismatch", "authz.signer_unknown", "authz.signer_revoked", "authz.signer_not_permitted", "authz.nonce_unknown", "authz.nonce_expired", "authz.nonce_replayed"]
    },
    {
      "op": "sync reset",
      "command": "sync reset",
      "mechanism": "broker-signature",
      "challengeFields": ["op", "canonicalBaseCommit", "intendedEffect", "nonce", "expiresAt"],
      "verificationSteps": [
        "canonical tip equals canonicalBaseCommit (the pre-reset canonical head; a concurrent capture moving it is refused)",
        "the re-derived intendedEffect.changePlanDigest equals the challenge's (a different upstream tree, note-glob set, or reconciliation plan yields a different digest — the reconciliation binding; NO targetCommit is bound, the reconciled child sha being known only post-commit)",
        "the reconciled commit is a fast-forward child of the current canonical head",
        "signerId is enrolled, active, and permitted for this op",
        "Ed25519 signature verifies over the recomputed signingPayload"
      ],
      "driftCodes": ["authz.canonical_moved", "authz.target_mismatch", "authz.signature_invalid", "authz.payload_mismatch", "authz.signer_unknown", "authz.signer_revoked", "authz.signer_not_permitted", "authz.nonce_unknown", "authz.nonce_expired", "authz.nonce_replayed"]
    },
    {
      "op": "git rollback",
      "command": "git rollback",
      "mechanism": "broker-signature",
      "challengeFields": ["op", "runId", "targetCommit", "canonicalBaseCommit", "intendedEffect", "nonce", "expiresAt"],
      "verificationSteps": [
        "derive the revert commit from the target run and canonical, matching intendedEffect.revertCommit",
        "canonical tip equals canonicalBaseCommit",
        "signerId is enrolled, active, and permitted for this op",
        "Ed25519 signature verifies over the recomputed signingPayload including revertCommit"
      ],
      "driftCodes": ["authz.revert_mismatch", "authz.canonical_moved", "authz.signature_invalid", "authz.payload_mismatch", "authz.signer_unknown", "authz.signer_revoked", "authz.signer_not_permitted", "authz.nonce_unknown", "authz.nonce_expired", "authz.nonce_replayed"]
    },
    {
      "op": "purge",
      "command": "purge",
      "mechanism": "broker-signature",
      "challengeFields": ["op", "intendedEffect", "nonce", "expiresAt"],
      "verificationSteps": [
        "derive the replacement head deterministically and match intendedEffect.replacementHead",
        "intendedEffect.oldHead equals the canonical tip",
        "signerId is enrolled, active, and permitted for this op",
        "authorize the signed non-fast-forward canonical-ref replacement (see §12.2)"
      ],
      "driftCodes": ["authz.target_mismatch", "authz.canonical_moved", "authz.signature_invalid", "authz.payload_mismatch", "authz.signer_unknown", "authz.signer_revoked", "authz.signer_not_permitted", "authz.nonce_unknown", "authz.nonce_expired", "authz.nonce_replayed"]
    },
    {
      "op": "db restore",
      "command": "db restore",
      "mechanism": "broker-signature",
      "challengeFields": ["op", "intendedEffect", "nonce", "expiresAt"],
      "verificationSteps": [
        "backup ref exists",
        "backup content hash matches intendedEffect.backupContentHash",
        "signerId is enrolled, active, and permitted for this op",
        "authorize restore only (AEAD decrypt runs CLI-side per §2)"
      ],
      "driftCodes": ["authz.backup_hash_mismatch", "authz.signature_invalid", "authz.payload_mismatch", "authz.signer_unknown", "authz.signer_revoked", "authz.signer_not_permitted", "authz.nonce_unknown", "authz.nonce_expired", "authz.nonce_replayed"]
    },
    {
      "op": "graduation migrate",
      "command": "graduation migrate",
      "mechanism": "broker-signature",
      "challengeFields": ["op", "intendedEffect", "nonce", "expiresAt"],
      "verificationSteps": [
        "current generation equals intendedEffect.fromGeneration",
        "re-derive the migration plan digest and match intendedEffect.migrationPlanDigest",
        "signerId is enrolled, active, and permitted for this op",
        "Ed25519 signature verifies over the recomputed signingPayload"
      ],
      "driftCodes": ["authz.generation_mismatch", "authz.migration_plan_mismatch", "authz.signature_invalid", "authz.payload_mismatch", "authz.signer_unknown", "authz.signer_revoked", "authz.signer_not_permitted", "authz.nonce_unknown", "authz.nonce_expired", "authz.nonce_replayed"]
    },
    {
      "op": "source trust promote",
      "command": "source trust promote",
      "mechanism": "broker-signature",
      "challengeFields": ["op", "intendedEffect", "nonce", "expiresAt"],
      "verificationSteps": [
        "current trust level equals intendedEffect.fromLevel",
        "signerId is enrolled, active, and permitted for this op",
        "append the promote record to refs/trust/ledger"
      ],
      "driftCodes": ["authz.trust_level_mismatch", "authz.signature_invalid", "authz.payload_mismatch", "authz.signer_unknown", "authz.signer_revoked", "authz.signer_not_permitted", "authz.nonce_unknown", "authz.nonce_expired", "authz.nonce_replayed"]
    },
    {
      "op": "source trust revoke",
      "command": "source trust revoke",
      "mechanism": "broker-signature",
      "challengeFields": ["op", "intendedEffect", "nonce", "expiresAt"],
      "verificationSteps": [
        "current trust level equals intendedEffect.fromLevel",
        "signerId is enrolled, active, and permitted for this op",
        "append the revoke record to refs/trust/ledger"
      ],
      "driftCodes": ["authz.trust_level_mismatch", "authz.signature_invalid", "authz.payload_mismatch", "authz.signer_unknown", "authz.signer_revoked", "authz.signer_not_permitted", "authz.nonce_unknown", "authz.nonce_expired", "authz.nonce_replayed"]
    },
    {
      "op": "db backup --force-unblock",
      "command": "db backup",
      "variant": true,
      "mechanism": "broker-signature",
      "challengeFields": ["op", "intendedEffect", "nonce", "expiresAt"],
      "verificationSteps": [
        "latest ledger seq unchanged from intendedEffect.latestLedgerSeq",
        "accepted-RPO-gap is current",
        "signerId is enrolled, active, and permitted for this op",
        "Ed25519 signature verifies over the recomputed signingPayload"
      ],
      "driftCodes": ["authz.rpo_gap_unaccepted", "authz.signature_invalid", "authz.payload_mismatch", "authz.signer_unknown", "authz.signer_revoked", "authz.signer_not_permitted", "authz.nonce_unknown", "authz.nonce_expired", "authz.nonce_replayed"]
    },
    {
      "op": "quarantine inspect",
      "command": "quarantine inspect",
      "mechanism": "os-presence",
      "challengeFields": ["op", "intendedEffect", "nonce", "expiresAt"],
      "verificationSteps": [
        "quarantine item opaque id exists and is quarantined",
        "OS presence assertion is present and bound to this challenge",
        "quarantine AEAD key is readable by this trusted-CLI identity"
      ],
      "driftCodes": ["authz.quarantine_item_unknown", "authz.quarantine_key_denied", "authz.presence_unverified", "authz.nonce_unknown", "authz.nonce_expired", "authz.nonce_replayed"]
    },
    {
      "op": "quarantine resolve",
      "command": "quarantine resolve",
      "mechanism": "os-presence",
      "challengeFields": ["op", "intendedEffect", "nonce", "expiresAt"],
      "verificationSteps": [
        "quarantine item opaque id exists and is quarantined",
        "intendedEffect.resolution is one of release or discard",
        "OS presence assertion is present and bound to this challenge",
        "quarantine AEAD key is readable by this trusted-CLI identity"
      ],
      "driftCodes": ["authz.quarantine_item_unknown", "authz.quarantine_key_denied", "authz.presence_unverified", "authz.target_mismatch", "authz.nonce_unknown", "authz.nonce_expired", "authz.nonce_replayed"]
    }
  ]
}
```

---

## 8. Ed25519 envelope + canonicalization

### 8.1 Envelope

Every signed object (audit event §5, WORM anchor §6, authorization response §7) is:

```json
{
  "payload": { "…": "the object being signed" },
  "signature": "ed25519:<base64url(64-byte signature)>",
  "signerId": "atlas-audit-attestation-v1",
  "canonicalization": "atlas-jcs-v1"
}
```

- **Algorithm:** Ed25519 (RFC 8032). Signature bytes base64url, no padding, prefixed `ed25519:`.
- The signature covers the **canonical byte string** of `payload` under the named `canonicalization`.

### 8.2 Canonicalization (`atlas-jcs-v1`) — byte-stable across processes

`atlas-jcs-v1` is **RFC 8785 JSON Canonicalization Scheme (JCS)** with these fixed rules, so any two
processes produce **identical bytes**:

1. UTF-8, no BOM. Object keys sorted by UTF-16 code-unit order (JCS).
2. No insignificant whitespace. Strings use JCS minimal escaping.
3. Numbers per JCS (ECMAScript `Number` shortest round-trip). **Timestamps are RFC 3339 UTC strings
   with millisecond precision ending `Z`** — never numeric — to avoid float ambiguity.
4. `undefined`/absent keys are omitted (never serialized as `null` unless `null` is meaningful).
5. The **`signature` and `canonicalization` fields are excluded** from the signed bytes (you cannot
   sign the signature).

The **`signingPayload`** in an `AuthorizationChallenge` (§7.1) is a distinct, simpler canonical form:
the literal newline-joined string `atlas.authz.v1\n<op>\n<runId|->\n<targetCommit|->\n<canonicalBaseCommit>\n<nonce>`
followed by op-specific lines for `intendedEffect`-derived commitments (e.g. `revertCommit`,
`backupContentHash`). It is emitted verbatim in the challenge so the signer signs the exact bytes and
the broker recomputes + compares (`authz.payload_mismatch` on mismatch).

---

## 9. Nonce store + expiry; signer registry

### 9.1 Nonce store

- The broker issues a **128-bit random nonce** per challenge and records `{ nonce, op, issuedAt,
  expiresAt, consumedAt? }` in the broker-owned **authorization nonce/replay store** (broker primary
  state, reconciled on startup — see design spec *Recovery contract*).
- **Expiry:** default TTL **5 minutes** (`expiresAt = issuedAt + 300s`); configurable per op but
  never unbounded. An expired nonce → `authz.nonce_expired`.
- **Single-use:** consuming a nonce sets `consumedAt`; re-use → `authz.nonce_replayed`. The store is
  the sole replay-protection authority; it is **not** in the vault or agent-readable.

### 9.2 Signer registry

- `signers` maps `signerId → { publicKey (Ed25519), permittedOps[], status: active|revoked,
  enrolledAt, revokedAt? }`. Held with the broker's key material (agent-unreadable).
- Verification looks up `signerId`; `authz.signer_unknown` if absent, `authz.signer_revoked` if
  `status=revoked`, `authz.signer_not_permitted` if `op ∉ permittedOps`.
- The **approval-verify** public keys (§4) live here; the audit-attestation signer is a distinct
  registry entry used only for §5/§6.

```json
{
  "signerId": "atlas-approver-hsm-01",
  "publicKey": "ed25519:MCowBQYDK2VwAyEA...",
  "permittedOps": ["git approve", "git rollback", "purge", "db restore", "graduation migrate", "source trust promote", "source trust revoke", "db backup --force-unblock"],
  "status": "active",
  "enrolledAt": "2026-07-01T00:00:00.000Z"
}
```

---

## 10. Key rotation / revocation

- **Rotation (signer or attestation key):** enroll the new key as a new `signerId` (versioned suffix,
  e.g. `-v2`) with `enrolledAt`; the old entry stays `active` during an overlap window so in-flight
  challenges verify, then is set `status=revoked` with `revokedAt`. Attestation-key rotation bumps
  the `signerId` recorded in **new** WORM anchor + audit records; historical records keep verifying
  against the old public key retained in the registry (never deleted, only revoked).
- **Revocation:** set `status=revoked` + `revokedAt`. Effective immediately: subsequent
  authorizations from that signer → `authz.signer_revoked`. Revocation does **not** invalidate past
  audit history (the public key is retained for historical verification).
- **Salt rotation** (§5.1): bump `saltVersion`; new opaque IDs use the new salt; old `audit_id_map`
  rows retain their `saltVersion` so historical linkage stays verifiable.

---

## 11. D6 event-mapping (privileged ledger ops)

Per **D6**: `db backup` / `db restore` / `db backup --force-unblock` write **ledger** audit rows in
`audit_events` (ledger-internal event kinds `db.backup` / `db.restore` / `db.force_unblock`) and emit
**no `run.*` git-ref event of their own** — the git-ref stream covers the run classes of the
observability matrix. The **post-restore projection rebuild** emits its own `run.projection` like any
executed projection-only command.

| Privileged ledger op | Ledger event kind (`audit_events`) | Git-ref `run.*` event? | Broker involvement |
|----------------------|------------------------------------|------------------------|--------------------|
| `db backup` | `db.backup` | none | none (CLI-side crypto, D13) |
| `db restore` | `db.restore` | none (rebuild later emits `run.projection`) | restore **authorization** only (§7) |
| `db backup --force-unblock` | `db.force_unblock` | none | authorization only (§7) |

These are **ledger-internal** kinds; they are **not** part of the `refs/audit/runs` `run.*`/`egress.*`
enumeration and are not chained into the WORM anchor's event count (which counts git-ref audit events).

---

## 12. Signed-tombstone erasure protocol

Two erasure classes, per the opaque-ID design (§5.1):

### 12.1 Ordinary erasure — no ref rewrite (the common case)

Because audit payloads carry only **opaque salted IDs** and the `opaqueId ↔ naturalId` mapping lives
solely in the CLI-owned ledger (`audit_id_map`, D13), erasing a note/source is:

1. Delete the entity's vault + projection rows (CLI, in-process).
2. Delete its `audit_id_map` row(s).
3. Append a **signed tombstone** audit event (`kind: "erase.tombstone"`) recording the erased
   `opaqueId`, the data-category, the authorization ref, and the timestamp — signed by the
   audit-attestation key like any audit event.

After step 2 the `refs/audit/runs` events referencing that `opaqueId` are **unlinkable** to a natural
identity — **no append-only-history rewrite is required** for ordinary GDPR-class erasure.

```json
{
  "schemaVersion": 1,
  "kind": "erase.tombstone",
  "erasedOpaqueId": "n_9f2c1a8e0b3d4f56",
  "dataCategory": "note",
  "authorizationRef": "authz_01J9Z8Q3",
  "erasedAt": "2026-07-12T10:02:11.004Z"
}
```

### 12.2 Content-in-history erasure — `purge` (broker-only signed non-fast-forward)

When the erasable content is **in canonical git history** (not just an opaque reference), `brain
purge` performs the **single defined exception** to descend-from-base + append-only object rules
(design spec *Purge history-rewrite exception*):

1. Authorize `purge` (§7.4) — Tier-3-equivalent, bound to `op=purge`, `oldHead`, and the
   deterministically derived `replacementHead`.
2. The broker performs a **signed non-fast-forward canonical-ref replacement**, then **securely
   garbage-collects the superseded objects** (moved into an erasable storage class for this op).
3. The broker **externally checkpoints both the old and replacement heads in the WORM anchor** (§6).
4. Post-purge verification confirms **no erased object remains reachable**.

The audit stream records the purge as an `erase.purge` event (subjects opaque, per §5). Ordinary
(non-purge) integration retains the strict descend-from-base + append-only guarantees.
