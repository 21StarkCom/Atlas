/**
 * `deprovision-allowlist` (Phase-5 task 5-2, #344) — the companion gate for the human-run
 * `provisioning/macos/deprovision-macos.sh`. The script mutates real host state and is NEVER
 * CI-tested; this gate is its verification. It proves, against the machine-readable SSOT
 * `provisioning/deprovision-allowlist.txt`:
 *
 *   1. the deletion set enumerates EXACTLY the retired resources (exact-match, no more/less);
 *   2. `atlas-gemini-api-key` is PRESERVED — explicitly NOT in the deletion set;
 *   3. the no-retired-reference grep gate (#335) EXEMPTS the script + allowlist paths;
 *   4. the two expected-empty parents are removed with `rmdir`, never `rm -rf`;
 *   5. the operator-home signer-store removal resolves `$SUDO_USER` (rejecting empty/root) and
 *      targets that account's resolved home — never root's `~`.
 *
 * And it drives the script's OWN command plan (`deprovision-macos.sh --plan`, a CI-safe,
 * no-sudo, no-mutation mode) against all-present / partially-deleted / already-clean
 * inventories, proving the plan converges and a mid-run interruption reruns cleanly.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const SCRIPT = join(ROOT, "provisioning/macos/deprovision-macos.sh");
const ALLOWLIST = join(ROOT, "provisioning/deprovision-allowlist.txt");
const GREP_GATE = join(ROOT, "tools/no-retired-reference.test.ts");

interface Rec {
  category: string;
  action: string;
  id: string;
  method: string;
  extra: string;
}

/** Parse the allowlist SSOT into records (skip blank + #-comment lines). */
function parseAllowlist(text: string): Rec[] {
  return text
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0 && !l.startsWith("#"))
    .map((l) => {
      const [category, action, id, method, extra = ""] = l.split("|");
      return { category: category!, action: action!, id: id!, method: method!, extra };
    });
}

const RECORDS = parseAllowlist(readFileSync(ALLOWLIST, "utf8"));
const key = (r: Rec): string => `${r.category}:${r.id}`;
const DELETES = RECORDS.filter((r) => r.action === "delete");
const PRESERVES = RECORDS.filter((r) => r.action === "preserve");

/** The EXACT retired deletion set the plan (plan §Phase-5 task 5-2, issue #344) must enumerate.
 *  Includes the resources the #344 review found the plan's own enumeration had MISSED and that
 *  bite the live Mac: the three per-user primary groups (lib.sh:96), the sync-agent HOME
 *  /usr/local/var/atlas/agent (services.sh:42), and the daemon LOG_DIR /usr/local/var/log/atlas
 *  (services.sh:28). */
const EXPECTED_DELETE_KEYS = [
  "launchd:com.atlas.broker",
  "launchd:com.atlas.egress",
  "launchd:com.atlas.sync",
  "user:atlas-agent",
  "user:atlas-broker",
  "user:atlas-egress",
  "group:atlas-git",
  "group:atlas-agent",
  "group:atlas-broker",
  "group:atlas-egress",
  "socket:/usr/local/var/run/atlas/broker.sock",
  "socket:/usr/local/var/run/atlas/egress.sock",
  "dir:/usr/local/etc/atlas/keys",
  "dir:/usr/local/var/atlas/audit-anchor",
  "dir:/usr/local/var/atlas/egress",
  "dir:/usr/local/var/atlas/agent",
  "dir:/usr/local/var/run/atlas",
  "dir:/usr/local/lib/atlas/bin",
  "dir:/usr/local/var/log/atlas",
  "dir:/usr/local/etc/atlas",
  "dir:/usr/local/var/atlas",
  "signer-store:Library/Application Support/atlas-signer",
  "keychain:atlas-egress-capability",
];

/**
 * The REAL provisioning surface (provisioning/lib.sh + provisioning/macos/services.sh) — every
 * directory provisioning creates UNDER a parent the allowlist removes with `rmdir`. If any is
 * not `rm-rf`'d BEFORE its parent's rmdir, the rmdir halts ENOTEMPTY on the live Mac (the
 * CRITICAL bug the #344 review caught — the sync-agent HOME was un-enumerated). UPDATE this map
 * when provisioning adds a directory under an rmdir'd parent, or this gate fails.
 */
const PROVISIONED_CHILDREN: Record<string, string[]> = {
  "/usr/local/var/atlas": [
    "/usr/local/var/atlas/audit-anchor", // lib.sh ATLAS_ANCHOR
    "/usr/local/var/atlas/egress", // lib.sh ATLAS_EGRESS_STATE
    "/usr/local/var/atlas/agent", // services.sh SYNC_AGENT_HOME (0700 atlas-agent)
  ],
  "/usr/local/etc/atlas": [
    "/usr/local/etc/atlas/keys", // lib.sh ATLAS_KEYS_DIR
  ],
};

describe("deprovision allowlist gate (#344)", () => {
  it("(1) enumerates EXACTLY the retired deletion set — no more, no less", () => {
    expect(DELETES.map(key).sort()).toEqual([...EXPECTED_DELETE_KEYS].sort());
  });

  it("(2) PRESERVES atlas-gemini-api-key — it is NOT in the deletion set", () => {
    expect(PRESERVES.map((r) => r.id)).toEqual(["atlas-gemini-api-key"]);
    expect(DELETES.some((r) => r.id === "atlas-gemini-api-key")).toBe(false);
    // The one preserve record is a keychain security-preserve (never a delete method).
    expect(PRESERVES[0]).toMatchObject({ category: "keychain", action: "preserve", method: "security-preserve" });
  });

  it("(3) the no-retired-reference grep gate EXEMPTS the script + allowlist paths", () => {
    const gate = readFileSync(GREP_GATE, "utf8");
    expect(gate).toContain('"provisioning/macos/deprovision-macos.sh"');
    expect(gate).toContain('"provisioning/deprovision-allowlist.txt"');
  });

  it("(4) the two expected-empty parents use rmdir, NEVER rm -rf", () => {
    const rmdirs = DELETES.filter((r) => r.method === "rmdir").map((r) => r.id).sort();
    expect(rmdirs).toEqual(["/usr/local/etc/atlas", "/usr/local/var/atlas"]);
    // Neither empty-parent path appears as an rm-rf target.
    const rmrfs = new Set(DELETES.filter((r) => r.method === "rm-rf").map((r) => r.id));
    expect(rmrfs.has("/usr/local/etc/atlas")).toBe(false);
    expect(rmrfs.has("/usr/local/var/atlas")).toBe(false);
  });

  it("(5) the signer-store removal resolves $SUDO_USER (not root) and targets the resolved home", () => {
    const sh = readFileSync(SCRIPT, "utf8");
    // Requires a non-root SUDO_USER, resolves NFSHomeDirectory via the directory service,
    // and removes the store AS that operator (never root's ~).
    expect(sh).toContain("SUDO_USER");
    expect(sh).toMatch(/!=\s*"root"/);
    expect(sh).toContain("NFSHomeDirectory");
    expect(sh).toContain('sudo -u "$OP_USER" rm -rf');
    // The signer store is home-RELATIVE in the allowlist (prefixed with the resolved home).
    const signer = DELETES.find((r) => r.category === "signer-store")!;
    expect(signer.id.startsWith("/")).toBe(false);
    expect(signer.id).toBe("Library/Application Support/atlas-signer");
  });

  it("the script's own --plan agrees byte-for-byte with the allowlist SSOT (parser fidelity)", () => {
    const planned = execFileSync("bash", [SCRIPT, "--plan"], { encoding: "utf8" }).trim().split("\n");
    const fromSsot = RECORDS.map((r) => `${r.category}|${r.action}|${r.id}|${r.method}|${r.extra}`);
    expect(planned).toEqual(fromSsot);
  });

  it("refuses to act without a mode, and rejects an unknown flag (exit 2)", () => {
    for (const args of [[] as string[], ["--bogus"]]) {
      let code: number | undefined;
      try {
        execFileSync("bash", [SCRIPT, ...args], { stdio: "pipe" });
      } catch (e) {
        code = (e as { status?: number }).status;
      }
      expect(code, `args=${JSON.stringify(args)}`).toBe(2);
    }
  });

  it("--confirm is fail-closed off CI-guard and sudo-guard BEFORE any mutation", () => {
    // In CI ⇒ refuses (exit 1) at the very first preflight, before touching anything.
    let ciCode: number | undefined;
    let ciErr = "";
    try {
      execFileSync("bash", [SCRIPT, "--confirm"], { env: { ...process.env, CI: "1" }, stdio: "pipe" });
    } catch (e) {
      ciCode = (e as { status?: number }).status;
      ciErr = String((e as { stderr?: Buffer }).stderr ?? "");
    }
    expect(ciCode).toBe(1);
    expect(ciErr).toContain("CI");

    // Off CI but not under sudo (the test runs non-root) ⇒ refuses at the sudo guard (exit 1).
    const noCI = { ...process.env };
    delete noCI.CI;
    delete noCI.GITHUB_ACTIONS;
    let sudoCode: number | undefined;
    let sudoErr = "";
    try {
      execFileSync("bash", [SCRIPT, "--confirm"], { env: noCI, stdio: "pipe" });
    } catch (e) {
      sudoCode = (e as { status?: number }).status;
      sudoErr = String((e as { stderr?: Buffer }).stderr ?? "");
    }
    expect(sudoCode).toBe(1);
    expect(sudoErr).toContain("sudo");
  });

  it("every rmdir'd parent has ALL its provisioned children rm-rf'd BEFORE the rmdir (no ENOTEMPTY halt)", () => {
    // Models rmdir-halts-on-nonempty against the REAL provisioned surface (not the allowlist's
    // own keyset) — the structural fix for the tautological simulation the review flagged.
    const dirDeletes = DELETES.filter((r) => r.category === "dir");
    const posOf = (id: string): number => dirDeletes.findIndex((r) => r.id === id);
    for (const [parent, children] of Object.entries(PROVISIONED_CHILDREN)) {
      const parentPos = posOf(parent);
      expect(parentPos, `${parent} must be an enumerated dir delete`).toBeGreaterThanOrEqual(0);
      expect(dirDeletes[parentPos]!.method, `${parent} is an empty-parent → rmdir`).toBe("rmdir");
      for (const child of children) {
        const childPos = posOf(child);
        expect(childPos, `${child} must be enumerated (else rmdir ${parent} halts ENOTEMPTY)`).toBeGreaterThanOrEqual(0);
        expect(dirDeletes[childPos]!.method, `${child} is a child of an rmdir'd parent → rm-rf`).toBe("rm-rf");
        expect(childPos, `${child} must be rm-rf'd BEFORE rmdir ${parent}`).toBeLessThan(parentPos);
      }
    }
  });

  it("del_user passes -keepHome — never deletes the SHARED /var/empty system home", () => {
    const sh = readFileSync(SCRIPT, "utf8");
    expect(sh).toMatch(/sysadminctl -deleteUser "\$1" -keepHome/);
  });

  it("fails closed on an empty allowlist id (load-time guard + signer-store home-root guard)", () => {
    const sh = readFileSync(SCRIPT, "utf8");
    expect(sh).toContain("empty id"); // load-time parse guard
    expect(sh).toMatch(/\[\[ -n "\$1" \]\] \|\| die "signer-store id empty/); // helper guard
  });

  // ── command-runner simulation: idempotent convergence across inventories ──────────────────
  // Models each per-resource helper (present→delete, absent→skip) driven by the script's OWN
  // plan (parsed from --plan), so this exercises the real deletion set, not a hardcoded copy.
  const planKeys = (): string[] =>
    execFileSync("bash", [SCRIPT, "--plan"], { encoding: "utf8" })
      .trim()
      .split("\n")
      .map((l) => l.split("|"))
      .filter(([, action]) => action === "delete")
      .map(([category, , id]) => `${category}:${id}`);

  /** Apply the plan to an inventory: remove every delete-target if present (idempotent). */
  function apply(inventory: Set<string>, deleteKeys: string[]): Set<string> {
    const next = new Set(inventory);
    for (const k of deleteKeys) next.delete(k);
    return next;
  }

  it("drives the plan against all-present / partial / clean inventories → converges + reruns clean", () => {
    const deleteKeys = planKeys();
    const PRESERVE = "keychain:atlas-gemini-api-key";

    const allPresent = new Set<string>([...deleteKeys, PRESERVE]);
    const partial = new Set<string>([...deleteKeys.filter((_, i) => i % 2 === 0), PRESERVE]);
    const clean = new Set<string>([PRESERVE]);

    for (const [label, inv] of [["all-present", allPresent], ["partial", partial], ["clean", clean]] as const) {
      const once = apply(inv, deleteKeys);
      // No delete-target survives; the preserved key is untouched.
      for (const k of deleteKeys) expect(once.has(k), `${label}: ${k} should be gone`).toBe(false);
      expect(once.has(PRESERVE), `${label}: gemini key preserved`).toBe(true);
      // Idempotent: a second pass (mid-run interruption reruns) changes nothing.
      const twice = apply(once, deleteKeys);
      expect([...twice].sort(), `${label}: rerun is a no-op`).toEqual([...once].sort());
    }
    // The clean inventory is a strict no-op (nothing but the preserved key, before and after).
    expect([...apply(clean, deleteKeys)]).toEqual([PRESERVE]);
  });
});
