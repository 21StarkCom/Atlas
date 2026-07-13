/**
 * `quarantine.security.test` (Task 2.2 / #28) — the release-blocking security
 * gate for the CLI-side encrypted quarantine store.
 *
 * Asserts: ciphertext-only at rest INCLUDING sensitive metadata (origin/content
 * hashes, finding titles/offsets are sealed, not plaintext), AEAD integrity, parser/
 * model identities cannot read the key (ACL-matrix contract), filenames minimized,
 * key rotation + retained-old-key reads + typed revocation, retention (TTL + keep-N)
 * enforced on write and on purge without racing in-flight temps, list/purge validate
 * + fail closed on tampered/corrupt bundles, symlink path components are refused, a
 * temp-fsync failure fails closed, a crash mid-quarantine leaves NO plaintext, and
 * the REAL provisioned custody layout drives a guard refusal to exit 3.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrePersistenceGuard, SecretDetectedError, type SecretFinding } from "@atlas/scan";
import {
  QUARANTINE_KEY_BYTES,
  QuarantineIntegrityError,
  QuarantineKeyRevokedError,
  QuarantineKeyUnavailableError,
  QuarantineStore,
} from "../src/quarantine/store.js";
import { quarantineStoreFromContext, rotateQuarantineCustody } from "../src/quarantine/config.js";
import type { RunContext } from "../src/main.js";

const enc = (s: string) => new TextEncoder().encode(s);
const key = () => new Uint8Array(randomBytes(QUARANTINE_KEY_BYTES));
const sha256Hex = (d: Uint8Array | string) => createHash("sha256").update(d).digest("hex");

// A synthetic secret assembled at runtime (never a committed live-format credential).
const SECRET = `AKIA${"A".repeat(16)} plus body ${"Zz9".repeat(20)}`;
const FINDINGS: SecretFinding[] = [
  { ruleId: "aws-access-key-id", title: "AWS access key id", severity: "high", startOffset: 0, endOffset: 20, redactedPreview: "‹redacted:20 chars›" },
];

let base: string;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "atlas-quarantine-"));
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

function newStore(overrides: Partial<ConstructorParameters<typeof QuarantineStore>[0]> = {}) {
  return new QuarantineStore({ dir: join(base, "q"), key: key(), ...overrides });
}

describe("ciphertext-only at rest (AEAD integrity)", () => {
  it("no plaintext of the bytes, origin, content-hash, or finding titles appears on disk", () => {
    const store = newStore();
    store.quarantineItem({ bytes: enc(SECRET), origin: "/vault/notes/secret.md", findings: FINDINGS });
    const dir = join(base, "q");
    for (const name of readdirSync(dir)) {
      const raw = readFileSync(join(dir, name));
      const text = raw.toString("utf8");
      expect(raw.includes(Buffer.from(SECRET, "utf8"))).toBe(false); // the secret bytes
      expect(text).not.toContain("secret.md"); // origin string
      expect(text).not.toContain(sha256Hex("/vault/notes/secret.md")); // origin HASH (no equality oracle)
      expect(text).not.toContain(sha256Hex(enc(SECRET))); // content HASH (no dictionary oracle)
      expect(text).not.toContain("AWS access key id"); // finding TITLE (caller-supplied text)
      expect(text).not.toContain("aws-access-key-id"); // finding rule id
    }
  });

  it("round-trips: an authorized read decrypts back to the exact bytes + sealed metadata", () => {
    const k = key();
    const store = new QuarantineStore({ dir: join(base, "q"), key: k });
    const id = store.quarantineItem({ bytes: enc(SECRET), origin: "o", findings: FINDINGS });
    const got = store.read(id);
    expect(new TextDecoder().decode(got.bytes)).toBe(SECRET);
    expect(got.meta.findings[0]!.ruleId).toBe("aws-access-key-id");
    expect(got.meta.contentHash).toBe(sha256Hex(enc(SECRET)));
  });

  it("a tampered ciphertext fails AEAD authentication", () => {
    const store = new QuarantineStore({ dir: join(base, "q"), key: key() });
    const id = store.quarantineItem({ bytes: enc(SECRET), origin: "o", findings: FINDINGS });
    const path = join(base, "q", `q-${id}.aqz`);
    const bundle = JSON.parse(readFileSync(path, "utf8"));
    const ct = Buffer.from(bundle.ciphertext, "base64");
    ct[0] = ct[0]! ^ 0xff;
    bundle.ciphertext = ct.toString("base64");
    writeFileSync(path, JSON.stringify(bundle));
    expect(() => store.read(id)).toThrow(QuarantineIntegrityError);
  });

  it("a tampered header (AAD) fails authentication", () => {
    const store = new QuarantineStore({ dir: join(base, "q"), key: key() });
    const id = store.quarantineItem({ bytes: enc(SECRET), origin: "o", findings: FINDINGS });
    const path = join(base, "q", `q-${id}.aqz`);
    const bundle = JSON.parse(readFileSync(path, "utf8"));
    bundle.header.expiresAt = "2099-01-01T00:00:00Z"; // tamper a bound routing field
    writeFileSync(path, JSON.stringify(bundle));
    expect(() => store.read(id)).toThrow(QuarantineIntegrityError);
  });

  it("a different key cannot decrypt (key is required, never stored)", () => {
    const store = new QuarantineStore({ dir: join(base, "q"), key: key() });
    const id = store.quarantineItem({ bytes: enc(SECRET), origin: "o", findings: FINDINGS });
    const other = new QuarantineStore({ dir: join(base, "q"), key: key() });
    expect(() => other.read(id)).toThrow(QuarantineIntegrityError);
  });

  it("rejects a wrong-length key at construction", () => {
    expect(() => new QuarantineStore({ dir: join(base, "q"), key: new Uint8Array(16) })).toThrow(
      QuarantineIntegrityError,
    );
  });
});

describe("parser/model identities cannot read the key (ACL-matrix contract)", () => {
  function loadAcl() {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (;;) {
      const p = join(dir, "provisioning", "keys.acl.json");
      if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8"));
      const parent = dirname(dir);
      if (parent === dir) throw new Error("keys.acl.json not found");
      dir = parent;
    }
  }
  it("the quarantine-aead key is trusted-CLI-only + parser/model-denied, provisioned as agent/quarantine-aead.key", () => {
    const acl = loadAcl();
    const row = acl.keys.find((k: { key: string }) => k.key === "quarantine-aead");
    expect(row).toBeDefined();
    expect(row.readableBy).toEqual(["trusted-cli"]);
    expect(row.parserModelDenied).toBe(true);
    expect(row.mode).toBe("0600");
    expect(row.identity).toBe("agent"); // provisioning creates it under the agent identity dir
    expect(row.file).toBe("quarantine-aead.key"); // the custody lookup must match this exact file
    expect(acl.group.notMembers).toContain("atlas-egress"); // D18
  });
});

describe("filenames minimized", () => {
  it("committed items are opaque q-<hex>.aqz — no origin, no secret leaks into the name", () => {
    const store = newStore();
    store.quarantineItem({ bytes: enc(SECRET), origin: "/vault/notes/very-secret-thing.md", findings: FINDINGS });
    const names = readdirSync(join(base, "q"));
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^q-[0-9a-f]{32}\.aqz$/);
    expect(names[0]).not.toContain("secret");
    expect(names[0]).not.toContain("very");
  });

  it("creates the dir with mode 0700 (no group/other access)", () => {
    const store = newStore();
    store.quarantineItem({ bytes: enc(SECRET), origin: "o", findings: FINDINGS });
    const mode = statSync(join(base, "q")).mode & 0o777;
    expect(mode & 0o077).toBe(0);
  });

  it("refuses a symlinked quarantine dir leaf (a planted symlink must not redirect our 0700 writes)", () => {
    const realTarget = join(base, "real-target");
    mkdirSync(realTarget, { recursive: true });
    const link = join(base, "q"); // the quarantine dir path is itself a symlink
    symlinkSync(realTarget, link);
    const store = new QuarantineStore({ dir: link, key: key() });
    expect(() => store.quarantineItem({ bytes: enc(SECRET), origin: "o", findings: FINDINGS })).toThrow(
      QuarantineIntegrityError,
    );
  });
});

describe("key rotation + revocation (§7)", () => {
  it("reads a retained rotated-out key via the resolver (per-item keyId resolution)", () => {
    const dir = join(base, "q");
    const oldKey = key();
    const writer = new QuarantineStore({ dir, key: oldKey, keyId: "key-old" });
    const id = writer.quarantineItem({ bytes: enc(SECRET), origin: "o", findings: FINDINGS });

    // After rotation the store's CURRENT key is new, but the old key is retained.
    const reader = new QuarantineStore({
      dir,
      key: key(),
      keyId: "key-new",
      resolveKey: (kid) => {
        if (kid === "key-old") return oldKey;
        throw new Error(`no such key ${kid}`);
      },
    });
    expect(new TextDecoder().decode(reader.read(id).bytes)).toBe(SECRET);
    expect(reader.read(id).header.keyId).toBe("key-old"); // resolved per the item's stamped id
  });

  it("a revoked key id fails closed with a typed QuarantineKeyRevokedError", () => {
    const dir = join(base, "q");
    const oldKey = key();
    const writer = new QuarantineStore({ dir, key: oldKey, keyId: "key-old" });
    const id = writer.quarantineItem({ bytes: enc(SECRET), origin: "o", findings: FINDINGS });
    const reader = new QuarantineStore({
      dir,
      key: key(),
      keyId: "key-new",
      resolveKey: () => oldKey,
      revokedKeyIds: ["key-old"],
    });
    expect(() => reader.read(id)).toThrow(QuarantineKeyRevokedError);
  });

  it("an unresolvable (unknown) key id fails closed with QuarantineKeyUnavailableError", () => {
    const dir = join(base, "q");
    const writer = new QuarantineStore({ dir, key: key(), keyId: "key-old" });
    const id = writer.quarantineItem({ bytes: enc(SECRET), origin: "o", findings: FINDINGS });
    const reader = new QuarantineStore({ dir, key: key(), keyId: "key-new" }); // no resolver
    expect(() => reader.read(id)).toThrow(QuarantineKeyUnavailableError);
  });
});

describe("retention: TTL + keep-N (enforced on write and on purge)", () => {
  it("purge removes items past their TTL and keeps live ones", () => {
    let t = new Date("2026-01-01T00:00:00Z").getTime();
    const clock = () => new Date(t);
    const store = new QuarantineStore({ dir: join(base, "q"), key: key(), retentionDays: 7, autoRetention: false, clock });
    const oldId = store.quarantineItem({ bytes: enc("old"), origin: "a", findings: FINDINGS });
    t += 3 * 24 * 60 * 60 * 1000;
    const freshId = store.quarantineItem({ bytes: enc("fresh"), origin: "b", findings: FINDINGS });
    t += 5 * 24 * 60 * 60 * 1000; // +8d: first item (TTL 7d) expired; second (5d) lives
    const res = store.purge();
    expect(res.expired).toContain(oldId);
    expect(res.expired).not.toContain(freshId);
    expect(store.list().map((h) => h.itemId)).toEqual([freshId]);
  });

  it("explicit purge trims the oldest beyond keep-N", () => {
    let t = new Date("2026-02-01T00:00:00Z").getTime();
    const clock = () => new Date(t);
    const store = new QuarantineStore({ dir: join(base, "q"), key: key(), keep: 2, retentionDays: 3650, autoRetention: false, clock });
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      ids.push(store.quarantineItem({ bytes: enc(`item-${i}`), origin: `o${i}`, findings: FINDINGS }));
      t += 60_000;
    }
    const res = store.purge();
    expect(res.trimmed).toEqual([ids[0], ids[1]]);
    expect(store.list().map((h) => h.itemId).sort()).toEqual([ids[2], ids[3]].sort());
  });

  it("keep-N is enforced ON WRITE (not only via a manual purge)", () => {
    let t = new Date("2026-03-01T00:00:00Z").getTime();
    const clock = () => new Date(t);
    const store = new QuarantineStore({ dir: join(base, "q"), key: key(), keep: 2, retentionDays: 3650, clock }); // autoRetention default
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      ids.push(store.quarantineItem({ bytes: enc(`item-${i}`), origin: `o${i}`, findings: FINDINGS }));
      t += 60_000;
    }
    // No manual purge — retention ran on each write, leaving only the 2 most-recent.
    expect(store.list().map((h) => h.itemId).sort()).toEqual([ids[2], ids[3]].sort());
  });

  it("TTL expiry is enforced ON WRITE for older items", () => {
    let t = new Date("2026-04-01T00:00:00Z").getTime();
    const clock = () => new Date(t);
    const store = new QuarantineStore({ dir: join(base, "q"), key: key(), retentionDays: 7, clock });
    const oldId = store.quarantineItem({ bytes: enc("old"), origin: "a", findings: FINDINGS });
    t += 8 * 24 * 60 * 60 * 1000; // advance past the old item's TTL
    const freshId = store.quarantineItem({ bytes: enc("fresh"), origin: "b", findings: FINDINGS });
    // The write's retention pass expired the old item.
    expect(store.list().map((h) => h.itemId)).toEqual([freshId]);
    expect(oldId).not.toBe(freshId);
  });
});

describe("list/purge validate + fail closed on tampered/corrupt bundles", () => {
  it("a filename/itemId mismatch is not a valid item (rename/aliasing fails closed)", () => {
    const dir = join(base, "q");
    const store = new QuarantineStore({ dir, key: key() });
    const id = store.quarantineItem({ bytes: enc(SECRET), origin: "o", findings: FINDINGS });
    // Copy the bundle under a DIFFERENT item-id filename.
    const bundle = readFileSync(join(dir, `q-${id}.aqz`));
    const alias = "f".repeat(32);
    writeFileSync(join(dir, `q-${alias}.aqz`), bundle);
    const { items, corrupt } = store.listWithErrors();
    expect(items.map((h) => h.itemId)).toEqual([id]); // only the genuine one
    expect(corrupt.some((c) => c.name === `q-${alias}.aqz`)).toBe(true);
  });

  it("a tampered expiresAt cannot cause purge to delete a valid neighbour (fails closed)", () => {
    const dir = join(base, "q");
    const store = new QuarantineStore({ dir, key: key(), autoRetention: false });
    const victimId = store.quarantineItem({ bytes: enc("valid-item"), origin: "v", findings: FINDINGS });
    const tamperedId = store.quarantineItem({ bytes: enc(SECRET), origin: "t", findings: FINDINGS });
    // Backdate the tampered item's expiry far into the past (unauthenticated edit).
    const tp = join(dir, `q-${tamperedId}.aqz`);
    const b = JSON.parse(readFileSync(tp, "utf8"));
    b.header.expiresAt = "2000-01-01T00:00:00Z";
    writeFileSync(tp, JSON.stringify(b));

    const res = store.purge();
    // The tampered item does NOT authenticate → it is corrupt, never "expired".
    expect(res.expired).not.toContain(tamperedId);
    expect(res.corrupt.some((c) => c.name === `q-${tamperedId}.aqz`)).toBe(true);
    // The valid neighbour is untouched.
    expect(existsSync(join(dir, `q-${victimId}.aqz`))).toBe(true);
    expect(store.list().map((h) => h.itemId)).toContain(victimId);
  });

  it("a malformed (non-JSON) bundle does not crash purge and is reported corrupt", () => {
    const dir = join(base, "q");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const bogus = `q-${"a".repeat(32)}.aqz`;
    writeFileSync(join(dir, bogus), "}{ not json");
    const store = new QuarantineStore({ dir, key: key() });
    const id = store.quarantineItem({ bytes: enc("ok"), origin: "o", findings: FINDINGS });
    const res = store.purge();
    expect(res.corrupt.some((c) => c.name === bogus)).toBe(true);
    expect(store.list().map((h) => h.itemId)).toContain(id); // the valid one survives
  });
});

describe("crash-safety + durability", () => {
  it("a temp-fsync failure fails closed — no committed item, no undurable success", () => {
    const dir = join(base, "q");
    const store = new QuarantineStore({
      dir,
      key: key(),
      onTempFsync: () => {
        throw Object.assign(new Error("simulated EIO"), { code: "EIO" });
      },
    });
    expect(() => store.quarantineItem({ bytes: enc(SECRET), origin: "o", findings: FINDINGS })).toThrow(/EIO/);
    // Nothing committed, and the partial temp was cleaned up.
    expect(readdirSync(dir).some((n) => /^q-[0-9a-f]{32}\.aqz$/.test(n))).toBe(false);
    expect(readdirSync(dir).some((n) => n.startsWith(".qtmp-"))).toBe(false);
  });

  it("a fault between temp-write and rename leaves at most a ciphertext temp — never plaintext, never a committed item", () => {
    const dir = join(base, "q");
    let tempSeen: string | null = null;
    const store = new QuarantineStore({
      dir,
      key: key(),
      onAfterTempWrite: (p) => {
        tempSeen = p;
        throw new Error("simulated crash before rename");
      },
    });
    expect(() => store.quarantineItem({ bytes: enc(SECRET), origin: "o", findings: FINDINGS })).toThrow(/simulated crash/);
    expect(store.list()).toHaveLength(0);
    expect(readdirSync(dir).some((n) => /^q-[0-9a-f]{32}\.aqz$/.test(n))).toBe(false);
    expect(tempSeen).not.toBeNull();
    if (tempSeen && existsSync(tempSeen)) {
      const raw = readFileSync(tempSeen);
      expect(raw.includes(Buffer.from(SECRET, "utf8"))).toBe(false);
    }
  });

  it("purge sweeps a stale crash-leftover temp but not a fresh (in-flight) one", () => {
    const dir = join(base, "q");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const store = new QuarantineStore({ dir, key: key() }); // default 60s safety window

    // A FRESH temp (just created) must NOT be swept — it could be a concurrent write.
    const fresh = join(dir, ".qtmp-fresh");
    writeFileSync(fresh, "ciphertext-remnant");
    let res = store.purge();
    expect(res.tempsSwept).toBe(0);
    expect(existsSync(fresh)).toBe(true);

    // Backdate it well past the window → now it's a genuine crash leftover → swept.
    const old = (Date.now() - 5 * 60_000) / 1000;
    utimesSync(fresh, old, old);
    res = store.purge();
    expect(res.tempsSwept).toBe(1);
    expect(existsSync(fresh)).toBe(false);
  });
});

describe("real provisioned custody layout → guard refusal → exit 3", () => {
  it("resolves agent/quarantine-aead.key, quarantines the offending bytes, and aborts with exit 3", async () => {
    // Provision the REAL layout under a test keysDir root: <root>/agent/quarantine-aead.key (raw 32 bytes).
    const keysRoot = join(base, "keys");
    const agentDir = join(keysRoot, "agent");
    mkdirSync(agentDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(agentDir, "quarantine-aead.key"), Buffer.from(randomBytes(QUARANTINE_KEY_BYTES)), { mode: 0o600 });

    const repo = join(base, "repo");
    const vault = join(base, "vault");
    const qdir = join(base, "state", "quarantine"); // OUTSIDE repo + vault
    mkdirSync(repo, { recursive: true });

    const ctx = {
      cwd: repo,
      env: { ATLAS_TEST_MODE: "1", ATLAS_CUSTODY_TEST_DIR: keysRoot } as NodeJS.ProcessEnv,
      config: {
        config: {
          vault: { path: vault },
          quarantine: { dir: qdir, keep: 200, retention_days: 30, key_id: "cli-custody-v1", revoked_key_ids: [] },
        },
      },
    } as unknown as RunContext;

    const store = quarantineStoreFromContext(ctx);
    const guard = new PrePersistenceGuard(store);

    let thrown: unknown;
    try {
      await guard.assertClean({ bytes: enc(`key = AKIA${"A".repeat(16)}`), origin: "note.md", kind: "raw" });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(SecretDetectedError);
    expect((thrown as SecretDetectedError).exitCode).toBe(3); // CLI boundary maps this to process exit 3

    // The offending bytes were quarantined (ciphertext-only) in the outside-repo dir.
    const committed = readdirSync(qdir).filter((n) => /^q-[0-9a-f]{32}\.aqz$/.test(n));
    expect(committed).toHaveLength(1);
    const raw = readFileSync(join(qdir, committed[0]!));
    expect(raw.includes(Buffer.from("AKIA", "utf8"))).toBe(false);
  });

  it("rejects a configured quarantine dir inside the repo (outside-repository location required)", () => {
    const keysRoot = join(base, "keys");
    mkdirSync(join(keysRoot, "agent"), { recursive: true, mode: 0o700 });
    writeFileSync(join(keysRoot, "agent", "quarantine-aead.key"), Buffer.from(randomBytes(QUARANTINE_KEY_BYTES)));
    const repo = join(base, "repo");
    mkdirSync(repo, { recursive: true });
    const ctx = {
      cwd: repo,
      env: { ATLAS_TEST_MODE: "1", ATLAS_CUSTODY_TEST_DIR: keysRoot } as NodeJS.ProcessEnv,
      config: {
        config: {
          vault: { path: join(base, "vault") },
          quarantine: { dir: join(repo, ".atlas", "quarantine"), keep: 200, retention_days: 30, key_id: "cli-custody-v1", revoked_key_ids: [] },
        },
      },
    } as unknown as RunContext;
    expect(() => quarantineStoreFromContext(ctx)).toThrow(/inside the repository/);
  });

  it("rejects a quarantine dir that a symlink redirects INTO the vault (realpath containment)", () => {
    const keysRoot = join(base, "keys");
    mkdirSync(join(keysRoot, "agent"), { recursive: true, mode: 0o700 });
    writeFileSync(join(keysRoot, "agent", "quarantine-aead.key"), Buffer.from(randomBytes(QUARANTINE_KEY_BYTES)));
    const repo = join(base, "repo");
    const vault = join(base, "vault");
    mkdirSync(repo, { recursive: true });
    mkdirSync(vault, { recursive: true });
    // `linkdir` looks outside the vault, but is a symlink whose target is inside it.
    const link = join(base, "linkdir");
    symlinkSync(vault, link);
    const ctx = {
      cwd: repo,
      env: { ATLAS_TEST_MODE: "1", ATLAS_CUSTODY_TEST_DIR: keysRoot } as NodeJS.ProcessEnv,
      config: {
        config: {
          vault: { path: vault },
          quarantine: { dir: join(link, "q"), keep: 200, retention_days: 30, key_id: "cli-custody-v1", revoked_key_ids: [] },
        },
      },
    } as unknown as RunContext;
    expect(() => quarantineStoreFromContext(ctx)).toThrow(/inside the vault/);
  });
});

/** Provision the real custody layout under a test keysDir root; returns the agent dir. */
function provisionCustody(keysRoot: string): string {
  const agentDir = join(keysRoot, "agent");
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(agentDir, "quarantine-aead.key"), Buffer.from(randomBytes(QUARANTINE_KEY_BYTES)), { mode: 0o600 });
  return agentDir;
}

/** A RunContext for the real custody path with a valid outside-repo quarantine dir. */
function custodyCtx(keysRoot: string, over: { repo?: string; qdir?: string; keyId?: string } = {}): RunContext {
  const repo = over.repo ?? join(base, "repo");
  mkdirSync(repo, { recursive: true });
  return {
    cwd: repo,
    env: { ATLAS_TEST_MODE: "1", ATLAS_CUSTODY_TEST_DIR: keysRoot } as NodeJS.ProcessEnv,
    config: {
      config: {
        vault: { path: join(base, "vault") },
        quarantine: {
          dir: over.qdir ?? join(base, "state", "quarantine"),
          keep: 200,
          retention_days: 30,
          key_id: over.keyId ?? "cli-custody-v1",
          revoked_key_ids: [],
        },
      },
    },
  } as unknown as RunContext;
}

describe("custody key posture: symlinked / world-readable keys are rejected", () => {
  it("rejects a SYMLINKED custody key (O_NOFOLLOW — a symlink cannot satisfy trusted-CLI custody)", () => {
    const keysRoot = join(base, "keys");
    const agentDir = join(keysRoot, "agent");
    mkdirSync(agentDir, { recursive: true, mode: 0o700 });
    // The key path is a symlink to real key material elsewhere.
    const realKey = join(base, "elsewhere-key");
    writeFileSync(realKey, Buffer.from(randomBytes(QUARANTINE_KEY_BYTES)), { mode: 0o600 });
    symlinkSync(realKey, join(agentDir, "quarantine-aead.key"));
    expect(() => quarantineStoreFromContext(custodyCtx(keysRoot))).toThrow(/symlink/);
  });

  it("rejects a world/group-readable (0644) custody key", () => {
    const keysRoot = join(base, "keys");
    const agentDir = join(keysRoot, "agent");
    mkdirSync(agentDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(agentDir, "quarantine-aead.key"), Buffer.from(randomBytes(QUARANTINE_KEY_BYTES)), { mode: 0o644 });
    // Force the mode past any restrictive umask so the group/other bits are really set.
    chmodSync(join(agentDir, "quarantine-aead.key"), 0o644);
    expect(() => quarantineStoreFromContext(custodyCtx(keysRoot))).toThrow(/group\/other-accessible|0600/);
  });

  it("rejects a group/other-accessible custody PARENT dir (0755)", () => {
    const keysRoot = join(base, "keys");
    const agentDir = join(keysRoot, "agent");
    mkdirSync(agentDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(agentDir, "quarantine-aead.key"), Buffer.from(randomBytes(QUARANTINE_KEY_BYTES)), { mode: 0o600 });
    chmodSync(agentDir, 0o755);
    expect(() => quarantineStoreFromContext(custodyCtx(keysRoot))).toThrow(/parent dir.*group\/other-accessible/);
  });
});

describe("dir containment: nested cwd + ancestor paths (bidirectional, real repo root)", () => {
  it("rejects a quarantine dir elsewhere in the repo even when invoked from a SUBDIRECTORY", () => {
    const keysRoot = join(base, "keys");
    provisionCustody(keysRoot);
    const repo = join(base, "repo");
    const sub = join(repo, "packages", "deep");
    mkdirSync(join(repo, ".git"), { recursive: true }); // mark the real repo root
    mkdirSync(sub, { recursive: true });
    // Configured dir is inside the repo but NOT inside the cwd subdirectory.
    const ctx = custodyCtx(keysRoot, { repo: sub, qdir: join(repo, "other", "q") });
    expect(() => quarantineStoreFromContext(ctx)).toThrow(/inside the repository/);
  });

  it("rejects a quarantine dir that is an ANCESTOR of the repo/vault (ensureDir would chmod it 0700)", () => {
    const keysRoot = join(base, "keys");
    provisionCustody(keysRoot);
    const repo = join(base, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    // `base` is the parent of both repo and vault → configuring it as the store dir
    // would let ensureDir chmod the shared ancestor to 0700.
    const ctx = custodyCtx(keysRoot, { repo, qdir: base });
    expect(() => quarantineStoreFromContext(ctx)).toThrow(/ancestor of the (repository|vault)/);
  });
});

describe("crash-safe purge: a directory-fsync fault fails closed", () => {
  it("a deletion whose directory fsync throws propagates (no silently-'successful' resurrectable delete)", () => {
    const dir = join(base, "q");
    const store = new QuarantineStore({
      dir,
      key: key(),
      autoRetention: false,
      onDeleteDirFsync: () => {
        throw Object.assign(new Error("simulated dir-fsync EIO"), { code: "EIO" });
      },
    });
    const id = store.quarantineItem({ bytes: enc(SECRET), origin: "o", findings: FINDINGS });
    // discard must not report success when the directory sync cannot be made durable.
    expect(() => store.discard(id)).toThrow(/EIO/);
    // A purge that removes entries must likewise surface the fault.
    const store2 = new QuarantineStore({
      dir,
      key: key(),
      keep: 0,
      retentionDays: 3650,
      autoRetention: false,
      onDeleteDirFsync: () => {
        throw Object.assign(new Error("simulated dir-fsync EIO"), { code: "EIO" });
      },
    });
    store2.quarantineItem({ bytes: enc("another"), origin: "o2", findings: FINDINGS });
    expect(() => store2.purge()).toThrow(/EIO/);
  });
});

describe("atomic custody rotation through quarantineStoreFromContext (§7)", () => {
  it("write-old, rotate, restart, read-old, write-new — all via real custody files", () => {
    const keysRoot = join(base, "keys");
    provisionCustody(keysRoot);
    const repo = join(base, "repo");
    const qdir = join(base, "state", "quarantine");

    // 1) write an item under the OLD current key.
    const ctxOld = custodyCtx(keysRoot, { repo, qdir, keyId: "cli-custody-v1" });
    const s1 = quarantineStoreFromContext(ctxOld);
    const oldId = s1.quarantineItem({ bytes: enc(SECRET), origin: "o", findings: FINDINGS });

    // 2) rotate custody: retains quarantine-aead.cli-custody-v1.key, installs a new base key.
    const res = rotateQuarantineCustody(ctxOld, { newKeyId: "cli-custody-v2" });
    expect(existsSync(res.retainedPath)).toBe(true);
    expect(res.retainedPath).toMatch(/quarantine-aead\.cli-custody-v1\.key$/);
    // The retained + new key files keep 0600 (rename preserves; new is chmod'd).
    expect(statSync(res.retainedPath).mode & 0o077).toBe(0);
    expect(statSync(res.currentPath).mode & 0o077).toBe(0);

    // 3) "restart" on the NEW key id — a fresh store from a fresh context.
    const ctxNew = custodyCtx(keysRoot, { repo, qdir, keyId: "cli-custody-v2" });
    const s2 = quarantineStoreFromContext(ctxNew);

    // 4) read-old: the old item (stamped cli-custody-v1) decrypts via the retained key.
    expect(new TextDecoder().decode(s2.read(oldId).bytes)).toBe(SECRET);
    expect(s2.read(oldId).header.keyId).toBe("cli-custody-v1");

    // 5) write-new: sealed under the new current key, reads back.
    const newId = s2.quarantineItem({ bytes: enc("fresh-under-v2"), origin: "o2", findings: FINDINGS });
    expect(new TextDecoder().decode(s2.read(newId).bytes)).toBe("fresh-under-v2");
    expect(s2.read(newId).header.keyId).toBe("cli-custody-v2");
  });

  it("refuses to rotate to the same key id", () => {
    const keysRoot = join(base, "keys");
    provisionCustody(keysRoot);
    const ctx = custodyCtx(keysRoot, { keyId: "cli-custody-v1" });
    expect(() => rotateQuarantineCustody(ctx, { newKeyId: "cli-custody-v1" })).toThrow(/differ/);
  });
});
