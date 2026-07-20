// enroll-signer-merge.mjs — the JSON-merge core of `provisioning/enroll-signer.sh`
// (SP-3 §7). Kept in Node because the identity rules are cryptographic: keys are
// compared by DER-SPKI FINGERPRINT (so a PEM and a `p256:<DER>` of one key compare
// equal), and the derived registry must be MATERIALIZED before the first explicit
// merge (an explicit signers.json replaces derivation, so we must not silently
// drop the attestation/test signers). Imports @atlas/broker's own derive +
// key-parse so the enrolled file is exactly what `loadSignerRegistry` will read.
//
// Usage:
//   node enroll-signer-merge.mjs <keysDir> enroll --signer-id <id> --alg <ed25519|p256> --pubkey <pem> [--presence] [--now <iso>]
//   node enroll-signer-merge.mjs <keysDir> revoke --signer-id <id> [--now <iso>]
//
// Writes <keysDir>/signers.json. Exits 0 on success/idempotent no-op; nonzero
// (with a message on stderr) on any refusal, mutating nothing.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const broker = await import(join(ROOT, "packages/broker/dist/src/index.js"));
const {
  deriveSignerRegistryFromKeyFiles,
  parsePublicKeyFlexible,
  parseP256PublicKeyFlexible,
  serializePublicKey,
  serializeP256PublicKey,
  SIGNATURE_AUTHORIZABLE_OPS,
} = broker;

const QUARANTINE_OPS = ["quarantine inspect", "quarantine resolve"];

function die(msg) {
  process.stderr.write(`enroll-signer: ${msg}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const [keysDir, action, ...rest] = argv;
  if (!keysDir || !action) die("usage: <keysDir> <enroll|revoke> …");
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--presence") opts.presence = true;
    else if (a === "--signer-id") opts.signerId = rest[++i];
    else if (a === "--alg") opts.alg = rest[++i];
    else if (a === "--pubkey") opts.pubkey = rest[++i];
    else if (a === "--now") opts.now = rest[++i];
    else die(`unknown arg "${a}"`);
  }
  return { keysDir, action, opts };
}

/** Parse a registry entry's public key per its alg → KeyObject (fail-closed). */
function parseKey(publicKey, alg) {
  return (alg ?? "ed25519") === "p256" ? parseP256PublicKeyFlexible(publicKey) : parsePublicKeyFlexible(publicKey);
}

/** DER-SPKI sha256 fingerprint — the identity of a key across encodings. */
function fingerprint(publicKey, alg) {
  const der = parseKey(publicKey, alg).export({ format: "der", type: "spki" });
  return createHash("sha256").update(der).digest("hex");
}

/** Load current entries: an explicit signers.json wins; else materialize the derived registry. */
function loadEntries(keysDir) {
  const path = join(keysDir, "signers.json");
  if (existsSync(path)) {
    return { path, entries: JSON.parse(readFileSync(path, "utf8")), fromExplicit: true };
  }
  // Materialize the derived registry (attestation + approver + fixtures) so an
  // explicit file never silently drops them (§7 / §11).
  return { path, entries: deriveSignerRegistryFromKeyFiles(keysDir), fromExplicit: false };
}

function writeEntries(path, entries) {
  writeFileSync(path, JSON.stringify(entries, null, 2) + "\n");
}

function sameSet(a, b) {
  if (a.length !== b.length) return false;
  const sb = new Set(b);
  return a.every((x) => sb.has(x));
}

function enroll(keysDir, opts) {
  const { signerId, alg, pubkey, presence = false } = opts;
  if (!signerId || !alg || !pubkey) die("enroll requires --signer-id, --alg, --pubkey");
  if (alg !== "ed25519" && alg !== "p256") die(`--alg must be ed25519 or p256 (got "${alg}")`);
  if (presence && alg !== "p256") die("--presence requires --alg p256 (a file key proves custody, not presence)");
  if (!existsSync(pubkey)) die(`pubkey file not found: ${pubkey}`);

  // Parse + validate the PEM as the named algorithm's SPKI (fail-closed), and
  // normalize to the package-native form for storage.
  let pem = readFileSync(pubkey, "utf8").trim();
  let publicKey, keyObj;
  try {
    keyObj = parseKey(pem, alg);
    publicKey = alg === "p256" ? serializeP256PublicKey(keyObj) : serializePublicKey(keyObj);
  } catch (e) {
    die(`--pubkey does not parse as a ${alg} SPKI public key: ${e.message}`);
  }
  const fp = fingerprint(publicKey, alg);
  const permittedOps = [...SIGNATURE_AUTHORIZABLE_OPS, ...(presence ? QUARANTINE_OPS : [])];
  const now = opts.now ?? new Date().toISOString().replace(/(\.\d{3})\d*Z$/, "$1Z");

  const { path, entries } = loadEntries(keysDir);

  // Fingerprint must be globally unique across ACTIVE entries — a key already
  // active under a DIFFERENT id is refused (no aliasing to inherit rights).
  for (const e of entries) {
    if (e.status !== "active") continue;
    if (e.signerId === signerId) continue;
    let efp;
    try { efp = fingerprint(e.publicKey, e.alg); } catch { continue; }
    if (efp === fp) {
      die(`this key is already enrolled under active signerId "${e.signerId}" — aliasing refused (a second id could inherit its rights)`);
    }
  }

  const idx = entries.findIndex((e) => e.signerId === signerId);
  if (idx >= 0) {
    const cur = entries[idx];
    let curFp;
    try { curFp = fingerprint(cur.publicKey, cur.alg); } catch { curFp = null; }
    if (curFp !== fp) {
      die(`signerId "${signerId}" already exists with a DIFFERENT key — never a silent key swap. Rotate instead: enroll -v(N+1), then --revoke "${signerId}".`);
    }
    // Same id + same key: idempotent ONLY if presence/permittedOps/status/alg agree.
    const same =
      (cur.alg ?? "ed25519") === alg &&
      Boolean(cur.presence) === Boolean(presence) &&
      cur.status === "active" &&
      sameSet(cur.permittedOps ?? [], permittedOps);
    if (same) {
      writeEntries(path, entries); // materialize-if-derived; otherwise a no-op rewrite
      process.stderr.write(`enroll-signer: "${signerId}" already enrolled identically — no change.\n`);
      return;
    }
    die(`signerId "${signerId}" already active with different presence/ops/status — never a silent rights change under a live id. Rotate instead: enroll -v(N+1), then --revoke "${signerId}".`);
  }

  const entry = {
    signerId,
    ...(alg === "p256" ? { alg: "p256" } : {}),
    ...(presence ? { presence: true } : {}),
    publicKey,
    permittedOps,
    status: "active",
    enrolledAt: now,
  };
  entries.push(entry);
  writeEntries(path, entries);
  process.stderr.write(`enroll-signer: enrolled "${signerId}" (${alg}${presence ? ", presence" : ""}), ${entries.length} active+historical signers.\n`);
}

function revoke(keysDir, opts) {
  const { signerId } = opts;
  if (!signerId) die("revoke requires --signer-id");
  const { path, entries } = loadEntries(keysDir);
  const idx = entries.findIndex((e) => e.signerId === signerId);
  if (idx < 0) {
    // Unknown id: fail nonzero, mutate NOTHING (do not materialize a derived file).
    die(`unknown signerId "${signerId}" — nothing revoked.`);
  }
  const cur = entries[idx];
  if (cur.status === "revoked") {
    writeEntries(path, entries); // preserve the original revokedAt; materialize if derived
    process.stderr.write(`enroll-signer: "${signerId}" already revoked — revokedAt preserved.\n`);
    return;
  }
  const now = opts.now ?? new Date().toISOString().replace(/(\.\d{3})\d*Z$/, "$1Z");
  entries[idx] = { ...cur, status: "revoked", revokedAt: now };
  writeEntries(path, entries);
  process.stderr.write(`enroll-signer: revoked "${signerId}".\n`);
}

const { keysDir, action, opts } = parseArgs(process.argv.slice(2));
if (action === "enroll") enroll(keysDir, opts);
else if (action === "revoke") revoke(keysDir, opts);
else die(`unknown action "${action}" (expected enroll|revoke)`);
