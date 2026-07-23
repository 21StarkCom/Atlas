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

  it("pins a WRITABLE HOME — launchd supplies none and atlas-agent's is root-owned /var/empty", () => {
    // The CLI's default quarantine state dir hangs off HOME; an unwritable one wedges
    // the first cycle that quarantines anything.
    expect(plistValue("HOME")).toBe("/usr/local/var/atlas/agent");
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

describe("atlas-sync-wrapper.sh — v2 placeholders (#334)", () => {
  it("carries exactly the two surviving provisioning placeholders (the custody pair is retired)", () => {
    for (const ph of ["@ATLAS_BRAIN_BIN@", "@ATLAS_CONFIG_DIR@"]) {
      expect(WRAPPER).toContain(ph);
    }
    for (const dead of ["@ATLAS_KEYCHAIN@", "@ATLAS_SECURITY_BIN@", "ATLAS_EGRESS_CAPABILITY_KEY"]) {
      expect(WRAPPER).not.toContain(dead);
    }
  });
});
