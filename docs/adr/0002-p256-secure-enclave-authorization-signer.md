# 0002 — Authorization signatures become alg-agile: a registered P-256/ECDSA signer class (Secure-Enclave-born, biometry-gated) alongside Ed25519

- **Status:** accepted
- **Date:** 2026-07-18
- **Spec:** [`docs/specs/2026-07-18-console-se-authorization-spec.md`](../specs/2026-07-18-console-se-authorization-spec.md) (Atlas Console SP-3)

## Context

Every privileged operation is authorized by the §7 challenge/response protocol
(security-broker-contract): `--export-challenge` → sign the exact
`signingPayload` bytes with a separately held key the agent cannot read →
`--authorization`. The contract pins the signature algorithm to **Ed25519**
(§8.1), and the shipped verifier (`packages/broker/src/crypto.ts`) accepts only
`ed25519:`-prefixed signatures over the payload.

Three facts collide with that single-algorithm pin:

1. **There is no production approver key.** Provisioning seeds
   `approval-verify.pub` **empty** (a placeholder the operator must fill);
   the only signer that has ever produced an authorization is the D20-gated
   `atlas-test-approver` fixture, which the broker hard-rejects outside
   `ATLAS_TEST_MODE`. The real-vault privileged surface (`graduation migrate
   --apply`, `purge`, `db restore`, `git approve/rollback`, trust ops) is
   human-gated in principle but has no enrolled human key in practice.
2. **The best local key custody on this hardware cannot do Ed25519.** The
   Apple Secure Enclave generates keys in-enclave, non-exportable,
   biometry-gatable — exactly the "separately held key the agent process
   cannot read" the design SSOT demands — but its classic asymmetric support
   is **NIST P-256 only** (`kSecAttrTokenIDSecureEnclave` docs; CryptoKit
   `SecureEnclave.P256`). No Ed25519, no RSA, no P-384. (macOS 26 added SE
   ML-DSA via CryptoKit; see *Alternatives*.)
3. **Atlas Console (SP-2/SP-3) makes privileged actions a click-path.** A
   GUI that can trigger `purge` must be backed by an authorization step a
   compromised agent cannot replay or synthesize — a per-approval human
   presence proof, not a file key on the same disk the agent reads.

## Decision

The **authorization envelope becomes algorithm-agile over a closed two-member
set**, discriminated where the algorithm already lives — in the signer
registry and the signature string prefix:

- `SignerRegistryEntry` (contracts `audit.ts`, mirrored in §9.2) gains
  `alg: "ed25519" | "p256"`, **absent ⇒ `"ed25519"`** — every existing
  entry and key-file-derived registry is unchanged byte-for-byte.
- `AuthorizationResponse.signature` accepts `ed25519:<base64url(64-byte raw)>`
  **or** `p256:<base64url(DER X9.62 ECDSA-SHA256 signature)>`. The prefix must
  match the enrolled signer's `alg`; any mismatch or malformed body is
  `authz.signature_invalid`. DER length is variable (70–72 bytes for P-256) —
  the verifier bounds it (≤ 72 raw bytes) instead of pinning it.
- **P-256 verification is pinned end-to-end:** the signer signs the UTF-8
  bytes of `signingPayload` with ECDSA/SHA-256 producing DER (Apple
  `.ecdsaSignatureMessageX962SHA256` / CryptoKit `signature(for:)
  .derRepresentation`); the broker verifies with Node
  `crypto.verify("sha256", payloadBytes, key, sig)` — DER is Node's
  `dsaEncoding` default, so the seam needs **zero transformation**.
- **Public-key interchange is SPKI PEM** for P-256 (CryptoKit
  `pemRepresentation` → Node `createPublicKey`), flowing through the existing
  `parsePublicKeyFlexible` PEM branch; the registry may also carry a
  `p256:<base64url(DER SPKI)>` native form symmetric with `ed25519:`.
- **Scope is authorization responses only.** The audit stream
  (`refs/audit/runs`), the WORM anchor, and every `SignedEnvelope` (§8.1)
  remain **Ed25519-only** — the attestation identity, chain verification, and
  anchor format are untouched. `atlas-jcs-v1` is untouched (canonicalization
  is orthogonal to which curve signs the canonical bytes, and
  `signingPayload` is the §8.2 newline-joined form, not JCS).
- The **D20 gate widens to a set**: test/fixture signer ids
  (`atlas-test-approver`, and the new software-P-256 fixture
  `atlas-test-approver-p256`) are hard-rejected unless `ATLAS_TEST_MODE=1`.
  No fixture signer of either algorithm can ever authorize in production.

The first (and expected only) production `p256` signer is the **Secure-Enclave
approver key** enrolled per device by the SP-3 provisioning flow: enclave-born
via CryptoKit, persisted as a self-managed `dataRepresentation` blob file
(never the data-protection keychain — that path needs profile-backed
entitlements; the blob path needs none), access-controlled
`.privateKeyUsage + .biometryCurrentSet` (Touch ID), used by the standalone
`atlas-signer` tool that displays the challenge before invoking biometry.

## Rationale

- **Discriminate where the trust decision already is.** Verification already
  resolves `signerId` → registry entry before touching the signature; hanging
  the algorithm off the entry (with the prefix as a cross-check) adds no new
  trust input and no negotiation surface. There is no client-chosen
  algorithm field — a signer *is* its algorithm.
- **A closed set, not crypto-agility.** Two algorithms, both pinned to exact
  encodings, no parameters. The failure mode of "agile" protocols
  (downgrade/negotiation confusion) requires a negotiation; this has none.
- **DER + SPKI PEM are the zero-transformation encodings.** Verified live on
  this machine: Apple Security/CryptoKit DER output validates under Node's
  default `dsaEncoding: "der"` with SPKI PEM keys, byte-for-byte, no
  re-encoding at the seam. Raw r‖s (`ieee-p1363`) would work but forces a
  conversion on the Swift side and a non-default option on the Node side.
- **Ed25519 stays.** The attestation key, the test signer, OpenSSL-file-based
  approvers on Linux hosts, and all existing envelopes keep working; `p256`
  is additive. Retiring Ed25519 authorization was considered and rejected —
  it would orphan CI and any non-Mac deployment for zero security gain.

## Alternatives considered

- **Ed25519 in a software keychain item** — keeps one algorithm, but the key
  becomes agent-adjacent file/keychain material again; no hardware binding,
  no per-use biometry. Rejects the point of the exercise.
- **SE ML-DSA (macOS 26 CryptoKit)** — post-quantum and SE-resident, but
  Node-side verification is not yet a stable platform primitive, and the
  threat model (local approval binding) gains nothing from PQ today.
  Re-visit when `node:crypto` ships ML-DSA verify; the registry's `alg` field
  is exactly where `"mldsa65"` would slot in.
- **A generic `alg`/JOSE-style envelope** (signature as `{alg, sig}` object)
  — more "correct", but it changes the response schema shape for existing
  Ed25519 flows and buys nothing over the prefix discriminator already in
  use across the codebase (`ed25519:` strings are the established idiom).
- **Keychain-persisted SE key** (`kSecAttrIsPermanent`) — requires
  `keychain-access-groups` authorized by a provisioning profile, i.e. an
  app-like bundle signed with an Apple-issued identity; ties key custody to
  a paid signing identity and breaks the build-from-source install. The
  CryptoKit blob file needs none of that (proven in the wild by
  age-plugin-se). Rejected for V1 custody.

## Consequences

- `contracts` (`audit.ts` registry entry, `authorization.ts` response
  signature), `broker` (`crypto.ts` verify dispatch, `keys.ts` registry
  load, `authorize.ts` D20 set), `tools/test-signer.ts` (`--alg p256`), and
  `security-broker-contract.md` §7.2/§7.3/§7.4/§8.1/§9.2/§10 prose all
  change together in the SP-3 implementation (every Ed25519-pinned sentence
  in the authorization path is reworded alg-neutrally). In the §7.5
  machine-readable `authzContract` block the **ops, drift codes, and exit
  codes are unchanged** — so `contract-lint`'s privileged-op bijection and
  catalog checks are unaffected — while its four "Ed25519 signature
  verifies…" `verificationSteps` strings are reworded alg-neutrally (the
  lint requires the steps be non-empty, not any particular text).
- The error catalog gains **no new codes**: wrong prefix for the enrolled
  signer, malformed body, or failed ECDSA verify are all
  `authz.signature_invalid`; unknown/revoked/unpermitted signers keep their
  existing codes.
- Signature bytes stop being fixed-length and deterministic: ECDSA is
  randomized (and Apple does not document low-S normalization), so nothing
  may ever byte-compare or dedupe on authorization signatures — verification
  is the only equality. (Nothing in the codebase does today; this pins that
  it never starts.)
- Biometry re-enrollment **invalidates** a `.biometryCurrentSet` SE key
  (Apple-documented); the recovery is the §10 rotation procedure the
  contract already defines — enroll `…-v(N+1)`, revoke the old id. Key loss
  is an enrollment event, not a DR event.
- CI cannot exercise the Secure Enclave (GitHub macOS runners are
  Virtualization.framework VMs — no SEP, no biometry): the broker's `p256`
  verify path is CI-covered via the software fixture signer; the SE + Touch
  ID path is live-verified on the operator's Mac only. That asymmetry is
  permanent and stated in the SP-3 test plan.
