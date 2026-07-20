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

  it("pins a WRITABLE HOME — launchd supplies none and atlas-agent's is root-owned /var/empty", () => {
    // The CLI's default quarantine state dir hangs off HOME; an unwritable one wedges
    // the first cycle that quarantines anything.
    expect(plistValue("HOME")).toBe("/usr/local/var/atlas/agent");
    // services.sh must provision exactly that path, and gate on it.
    expect(SERVICES).toContain('SYNC_AGENT_HOME="/usr/local/var/atlas/agent"');
    expect(SERVICES).toMatch(/ensure_dir "\$SYNC_AGENT_HOME" "\$ATLAS_AGENT_USER"/);
    expect(SERVICES).toMatch(/test -w "\$SYNC_AGENT_HOME"/);
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

describe("services.sh — the gates", () => {
  const gate = /^sync_gate\(\) \{([\s\S]*?)^\}/m.exec(SERVICES)?.[1] ?? "";

  it("probes the wrapper's absolute brain path and rejects an unsubstituted placeholder", () => {
    expect(gate).toContain("@ATLAS_BRAIN_BIN@");
    expect(gate).toMatch(/not absolute/);
  });

  it("probes the baked-in CONFIG DIR — launchd's cwd is `/` and brain reads <cwd>/brain.config.yaml", () => {
    expect(gate).toContain("@ATLAS_CONFIG_DIR@");
    expect(gate).toMatch(/sudo -n -u "\$ATLAS_AGENT_USER" test -r "\$config_dir\/brain\.config\.yaml"/);
  });

  it("runs a REAL read-only git probe as atlas-agent against the vault", () => {
    expect(gate).toMatch(/sudo -n -u "\$ATLAS_AGENT_USER" git -C "\$vault" rev-parse/);
  });

  it("writes safe.directory to the SYSTEM config, not the home-less agent's --global", () => {
    // atlas-agent's NFSHomeDirectory is the root-owned /var/empty — a --global write
    // has nowhere to land and would abort the whole gate under `set -e`.
    expect(gate).toContain("git config --system --add safe.directory");
    expect(gate).not.toContain("--global --add safe.directory");
    expect(gate).not.toMatch(/safe\.directory\s+['"]?\*/);
  });

  it("guards the safe.directory write instead of letting `set -e` abort the gate", () => {
    expect(gate).toMatch(/git config --system --add safe\.directory "\$vault"[\s\S]{0,120}gate_fail/);
  });

  it("probes the Keychain with `-w` and an EXPLICIT keychain file (the wrapper's exact operation)", () => {
    // Without -w the lookup never decrypts, so it passes against a LOCKED keychain
    // the wrapper then fails to read; without the file it hits root's default keychain.
    expect(gate).toMatch(/sudo -n -u "\$ATLAS_AGENT_USER" \/usr\/bin\/security find-generic-password -w/);
    expect(gate).toMatch(/-a "\$ATLAS_AGENT_USER" "\$keychain"/);
  });

  it("reads every wrapper field through the guarded helper — a missing wrapper must not abort the gate", () => {
    // ROUND-2 REGRESSION: a bare `sed "$SYNC_WRAPPER"` outside the wrapper-exists
    // guard exits 1 under `set -euo pipefail`, killing the gate before the later
    // probes and returning exit 1 instead of the documented exit 2 — on the now-NORMAL
    // path where install-artifact.sh skipped the wrapper.
    expect(SERVICES).toMatch(/^wrapper_field\(\) \{/m);
    expect(SERVICES).toMatch(/\[ -r "\$SYNC_WRAPPER" \] \|\| return 0/);
    for (const field of ["BRAIN", "CONFIG_DIR", "KEYCHAIN"]) {
      expect(gate).toContain(`$(wrapper_field ${field} || true)`);
    }
    // No raw sed against the wrapper may survive anywhere in the gate.
    expect(gate).not.toMatch(/sed[^\n]*\$SYNC_WRAPPER/);
  });

  it("requires the upstream puller — atlas-agent is network-denied and cannot fetch", () => {
    expect(gate).toContain("ATLAS_UPSTREAM_PULLER_LABEL");
    expect(gate).toMatch(/launchctl print "system\/\$puller"/);
  });

  it("probes the puller in the INVOKING operator's gui domain (SUDO_UID), not gui/0", () => {
    expect(gate).toContain('gui/${SUDO_UID:-$(id -u)}/$puller');
  });
});

describe("install-artifact.sh — wrapper rendering", () => {
  it("substitutes every placeholder and installs the wrapper root-owned 0755", () => {
    for (const sub of [
      "s|@ATLAS_BRAIN_BIN@|$brain_target|g",
      "s|@ATLAS_CONFIG_DIR@|$CONFIG_DIR|g",
      "s|@ATLAS_KEYCHAIN@|$KEYCHAIN_FILE|g",
      "s|@ATLAS_SECURITY_BIN@|/usr/bin/security|g",
    ]) {
      expect(INSTALL).toContain(sub);
    }
    expect(INSTALL).toMatch(/install -m 0755 -o root -g "\$ATLAS_ROOT_GROUP" "\$rendered_wrapper"/);
  });

  it("SKIPS the optional wrapper instead of failing the privileged install", () => {
    // The daemons must still install on a host that never adopted a vault (and in CI).
    expect(INSTALL).toContain("skip_wrapper");
    expect(INSTALL).toMatch(/log "SKIP atlas-sync-wrapper\.sh/);
    expect(INSTALL).not.toMatch(/cannot resolve an absolute[\s\S]*?exit 2/);
  });

  it("verifies the resolved `brain` really IS the Atlas CLI before baking it in", () => {
    // `brain` is a generic name on root's PATH.
    expect(INSTALL).toMatch(/\$brain_invoke --help[\s\S]{0,60}Atlas CLI/);
  });

  it("accepts a NON-executable .js entrypoint via a root-owned shim", () => {
    // ROUND-2 REGRESSION: `apps/cli/dist/bin.js` is plain tsc output (mode 0644) and
    // the repo ships no installed binary, so an `-x`-only test made the documented
    // runbook silently skip the wrapper every single time.
    expect(INSTALL).toMatch(/\*\.js \| \*\.mjs \| \*\.cjs/);
    expect(INSTALL).toContain("/usr/bin/env node");
    // The shim keeps the wrapper's one-absolute-executable invariant (and D16: it is
    // installed root-owned into the non-agent-writable dir, never spliced as a string).
    expect(INSTALL).toMatch(/install -m 0755 -o root -g "\$ATLAS_ROOT_GROUP" "\$BRAIN_SHIM\.tmp" "\$BRAIN_SHIM"/);
    expect(INSTALL).toContain('BRAIN_SHIM="$ATLAS_INSTALL_BIN/brain-shim.sh"');
  });

  it("removes a stale wrapper when the install SKIPS — never leaves old substitutions running", () => {
    expect(INSTALL).toMatch(/rm -f "\$ATLAS_INSTALL_BIN\/atlas-sync-wrapper\.sh" "\$BRAIN_SHIM"/);
  });

  it("requires a config dir — the launchd cwd-`/` failure is otherwise silent", () => {
    expect(INSTALL).toContain("ATLAS_CONFIG_DIR");
    expect(INSTALL).toMatch(/\$CONFIG_DIR\/brain\.config\.yaml/);
  });

  it("rejects sed-hostile characters in a substituted path rather than corrupting the render", () => {
    expect(INSTALL).toMatch(/unsupported character in path/);
  });

  it("guards the macOS-only wrapper install behind the Darwin check", () => {
    expect(INSTALL).toMatch(/if \[ "\$ATLAS_OS" = "Darwin" \]; then[\s\S]*?atlas-sync-wrapper\.sh/);
  });

  it("the installed wrapper is the SAME artifact the auto-hook test drives", () => {
    for (const ph of ["@ATLAS_BRAIN_BIN@", "@ATLAS_CONFIG_DIR@", "@ATLAS_KEYCHAIN@", "@ATLAS_SECURITY_BIN@"]) {
      expect(WRAPPER).toContain(ph);
    }
  });
});
