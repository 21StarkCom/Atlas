/**
 * `com.atlas.sync.plist` + its provisioning gate (#60 Phase 6, Task 6.3).
 *
 * The 300 s timer is the piece that runs unattended, so the ways it can be WRONG are
 * all silent: a secret in a world-readable plist, a bare `brain` that dies at command
 * resolution under launchd's minimal PATH, or a timer bootstrapped before its
 * prerequisites hold — which looks perfectly healthy in `launchctl` while fail-closing
 * every single cycle. Each of those is asserted here.
 *
 * NOTE (as-built deviation): the plan sketched `provisioning/test/sync-plist.test.ts`,
 * but `provisioning/` is not a pnpm workspace — its tests live in `tools/` alongside
 * `provisioning-acl.test.ts` and `enroll-signer.test.ts`.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PLIST = readFileSync(join(ROOT, "provisioning/macos/com.atlas.sync.plist"), "utf8");
const SERVICES = readFileSync(join(ROOT, "provisioning/macos/services.sh"), "utf8");
const INSTALL = readFileSync(join(ROOT, "provisioning/install-artifact.sh"), "utf8");
const WRAPPER = readFileSync(join(ROOT, "provisioning/macos/atlas-sync-wrapper.sh"), "utf8");

/** Minimal plist reader — `<key>K</key><type>V</type>` / `<true/>` / `<false/>`. */
function plistValue(key: string): string {
  const m = new RegExp(`<key>${key}</key>\\s*(?:<(string|integer)>([^<]*)</\\1>|<(true|false)/>)`).exec(PLIST);
  if (m === null) throw new Error(`plist key ${key} not found`);
  return m[2] ?? m[3] ?? "";
}

describe("com.atlas.sync.plist — shape", () => {
  it("is labelled com.atlas.sync and fires every 300 s", () => {
    expect(plistValue("Label")).toBe("com.atlas.sync");
    expect(plistValue("StartInterval")).toBe("300");
  });

  it("runs as the unprivileged atlas-agent identity (D17), not root and not a daemon UID", () => {
    expect(plistValue("UserName")).toBe("atlas-agent");
    expect(PLIST).not.toContain("atlas-broker");
    expect(PLIST).not.toContain("atlas-egress");
  });

  it("runs the installed wrapper by absolute (substituted) path — never a bare `brain`", () => {
    expect(PLIST).toContain("@ATLAS_INSTALL_BIN@/atlas-sync-wrapper.sh");
    expect(PLIST).not.toMatch(/<string>brain<\/string>/);
  });

  it("carries NO secret in EnvironmentVariables — a plist is world-readable", () => {
    const env = /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(PLIST)?.[1] ?? "";
    expect(env).toContain("PATH");
    expect(env).not.toContain("ATLAS_EGRESS_CAPABILITY_KEY");
    expect(env).not.toContain("CAPABILITY");
    // The whole file, not just that dict.
    expect(PLIST).not.toContain("ATLAS_EGRESS_CAPABILITY_KEY");
  });

  it("does not RunAtLoad — the timer must not fire before `enable-sync` gates it", () => {
    expect(plistValue("RunAtLoad")).toBe("false");
  });

  it("has no KeepAlive — it is a periodic timer, not a resident daemon", () => {
    expect(PLIST).not.toContain("KeepAlive");
  });
});

describe("services.sh — the timer is installed DISABLED", () => {
  it("keeps com.atlas.sync out of the always-bootstrapped SERVICES list", () => {
    const services = /^SERVICES=\((.*)\)$/m.exec(SERVICES)?.[1] ?? "";
    expect(services).not.toContain("com.atlas.sync");
    expect(services).toContain("com.atlas.broker");
    expect(/^GATED_SERVICES=\((.*)\)$/m.exec(SERVICES)?.[1]).toContain("com.atlas.sync");
  });

  it("exposes sync-gate / enable-sync / disable-sync, and disable-sync is the documented rollback", () => {
    for (const verb of ["sync-gate)", "enable-sync)", "disable-sync)"]) {
      expect(SERVICES).toContain(verb);
    }
    expect(SERVICES).toMatch(/usage: services\.sh install\|uninstall\|status\|sync-gate/);
  });

  it("enable-sync runs the gate BEFORE bootstrapping (never the other way round)", () => {
    const block = /enable-sync\)([\s\S]*?);;/.exec(SERVICES)?.[1] ?? "";
    expect(block).toContain("sync_gate");
    expect(block).toContain("launchctl bootstrap");
    expect(block.indexOf("sync_gate")).toBeLessThan(block.indexOf("launchctl bootstrap"));
  });

  it("the gate exits non-zero on any failed prerequisite", () => {
    expect(SERVICES).toMatch(/sync gate FAILED[\s\S]*?exit 2/);
  });
});

describe("services.sh — the five gates", () => {
  const gate = /^sync_gate\(\) \{([\s\S]*?)^\}/m.exec(SERVICES)?.[1] ?? "";

  it("probes the wrapper's absolute brain path and rejects an unsubstituted placeholder", () => {
    expect(gate).toContain("@ATLAS_BRAIN_BIN@");
    expect(gate).toMatch(/not absolute/);
  });

  it("runs a REAL read-only git probe as atlas-agent against the vault", () => {
    expect(gate).toMatch(/sudo -n -u "\$ATLAS_AGENT_USER" git -C "\$vault" rev-parse/);
  });

  it("adds a REPOSITORY-SPECIFIC safe.directory entry, never the `*` wildcard", () => {
    expect(gate).toContain("git config --global --add safe.directory");
    expect(gate).not.toMatch(/safe\.directory\s+['"]?\*/);
  });

  it("probes the Keychain AS atlas-agent (the OQ#1 keychain-unlock prerequisite)", () => {
    expect(gate).toMatch(/sudo -n -u "\$ATLAS_AGENT_USER" \/usr\/bin\/security find-generic-password/);
  });

  it("requires the upstream puller — atlas-agent is network-denied and cannot fetch", () => {
    expect(gate).toContain("ATLAS_UPSTREAM_PULLER_LABEL");
    expect(gate).toMatch(/launchctl print "system\/\$puller"/);
  });
});

describe("install-artifact.sh — wrapper rendering", () => {
  it("substitutes BOTH placeholders and installs the wrapper root-owned 0755", () => {
    expect(INSTALL).toContain("s|@ATLAS_BRAIN_BIN@|$BRAIN_BIN|g");
    expect(INSTALL).toContain("s|@ATLAS_SECURITY_BIN@|/usr/bin/security|g");
    expect(INSTALL).toMatch(/install -m 0755 -o root -g "\$ATLAS_ROOT_GROUP" "\$rendered_wrapper"/);
  });

  it("refuses to install when no absolute brain can be resolved (fail closed, exit 2)", () => {
    expect(INSTALL).toContain("ATLAS_BRAIN_BIN");
    expect(INSTALL).toMatch(/cannot resolve an absolute[\s\S]*?exit 2/);
  });

  it("guards the macOS-only wrapper install behind the Darwin check", () => {
    expect(INSTALL).toMatch(/if \[ "\$ATLAS_OS" = "Darwin" \]; then[\s\S]*?atlas-sync-wrapper\.sh/);
  });

  it("the installed wrapper is the SAME artifact the auto-hook test drives", () => {
    expect(WRAPPER).toContain("@ATLAS_BRAIN_BIN@");
    expect(WRAPPER).toContain("@ATLAS_SECURITY_BIN@");
  });
});
