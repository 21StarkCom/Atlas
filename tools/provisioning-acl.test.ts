import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Provisioning ACL-matrix contract (Task 1.0 / #16). Non-sudo checks that the
 * machine-readable ACL matrix (`provisioning/keys.acl.json`) is well-formed and upholds
 * the security-broker-contract invariants, and that the provisioning scripts exist +
 * are executable. The live separation/integrity suites (which need real OS users) land
 * with the broker (#22) and gate on ATLAS_PROVISIONED.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const acl = JSON.parse(readFileSync(join(root, "provisioning/keys.acl.json"), "utf8"));

describe("keys.acl.json — structure", () => {
  it("has a version and a non-empty keys array", () => {
    expect(acl.schemaVersion).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(acl.keys) && acl.keys.length > 0).toBe(true);
  });

  it("every key names readableBy, mode, identity, and a file", () => {
    for (const k of acl.keys) {
      expect(k.key, `key entry: ${JSON.stringify(k)}`).toBeTruthy();
      expect(Array.isArray(k.readableBy) && k.readableBy.length > 0).toBe(true);
      expect(k.mode).toMatch(/^0[0-7]{3}$/);
      expect(typeof k.identity).toBe("string");
      expect(typeof k.file).toBe("string");
    }
  });
});

describe("keys.acl.json — security invariants", () => {
  const byKey = Object.fromEntries(acl.keys.map((k: any) => [k.key, k]));

  it("the provider credential is egress-broker-only (D18/§4)", () => {
    expect(byKey["atlas.gemini.key"].readableBy).toEqual(["atlas-egress"]);
  });

  it("the audit-attestation PRIVATE key is broker-only; only the pub is agent-readable", () => {
    expect(byKey["audit-attestation"].readableBy).toEqual(["atlas-broker"]);
    expect(byKey["audit-attestation-pub"].readableBy).toEqual(
      expect.arrayContaining(["atlas-broker", "agent"]),
    );
  });

  it("backup + quarantine AEAD are trusted-CLI only (never broker/egress)", () => {
    for (const key of ["backup-aead", "quarantine-aead"]) {
      expect(byKey[key].readableBy).toEqual(["trusted-cli"]);
      expect(byKey[key].readableBy).not.toContain("atlas-egress");
    }
    expect(byKey["quarantine-aead"].parserModelDenied).toBe(true);
  });

  it("the test approver is flagged test-mode-only (D20)", () => {
    expect(byKey["atlas-test-approver"].testModeOnly).toBe(true);
  });

  it("atlas-egress is excluded from the atlas-git group (D18)", () => {
    expect(acl.group.members).not.toContain("atlas-egress");
    expect(acl.group.notMembers).toContain("atlas-egress");
    expect(acl.group.members).toEqual(expect.arrayContaining(["agent", "atlas-broker"]));
  });

  it("no key is readable by more identities than its row lists (single-holder secrets)", () => {
    for (const key of ["atlas.gemini.key", "quarantine-aead", "audit-attestation"]) {
      expect(byKey[key].readableBy.length).toBe(1);
    }
  });
});

describe("provisioning scripts exist + are executable", () => {
  const scripts = [
    "provisioning/lib.sh",
    "provisioning/dev/setup.sh",
    "provisioning/dev/teardown.sh",
    "provisioning/ci/setup.sh",
    "provisioning/install-artifact.sh",
    "provisioning/install-console-launcher.sh",
    "provisioning/enroll-signer.sh",
    "provisioning/bin/broker-launcher.sh",
    "provisioning/bin/egress-launcher.sh",
    "provisioning/bin/brain-as-agent.sh",
    "provisioning/macos/services.sh",
    "tools/build-artifact.sh",
    "provisioning/linux/netns.sh",
    "provisioning/linux/agent-cgroup.sh",
  ];
  for (const s of scripts) {
    it(`${s} is present and +x`, () => {
      const p = join(root, s);
      expect(existsSync(p)).toBe(true);
      // owner-executable bit set
      expect(statSync(p).mode & 0o100).toBe(0o100);
    });
  }
});
