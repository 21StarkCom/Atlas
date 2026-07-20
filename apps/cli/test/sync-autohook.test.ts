/**
 * `atlas-sync-wrapper.sh` — the two-step launchd auto-hook (#60 Phase 6, Tasks 6.1/6.2).
 *
 * The wrapper is the piece that closes the ingest→index gap: `brain sync` advances
 * the cursor and ENQUEUES an `index:reconcile` job, but nothing indexes until that
 * job is drained. Dropping the drain is a silent failure — sync keeps reporting
 * success while nothing new is ever retrievable — so the sequencing, the exit-code
 * routing, and the credential scoping are all asserted here.
 *
 * These tests exercise the REAL shipped script (rendered exactly as
 * `install-artifact.sh` renders it, `@ATLAS_*@` placeholders substituted) against
 * recording stubs for `brain` and `security`. What a stub cannot prove — that a
 * committed upstream edit becomes retrievable within one invocation against a real
 * provisioned instance — is the live-drive gate (Task 6.4), and the Keychain fetch
 * itself is the declared CI parity gap (`provisioning/CLAUDE.md`).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mintEgressCapability, verifyCapability } from "@atlas/broker";

const WRAPPER_SRC = fileURLToPath(new URL("../../../provisioning/macos/atlas-sync-wrapper.sh", import.meta.url));

const SECRET = "keychain-delivered-capability-secret";

let dir: string;

/** Absolute paths inside the scratch install. */
const P = {
  wrapper: (): string => join(dir, "atlas-sync-wrapper.sh"),
  brain: (): string => join(dir, "brain"),
  security: (): string => join(dir, "security"),
  log: (): string => join(dir, "calls.log"),
  fdCapture: (): string => join(dir, "fd3.capture"),
  tmp: (): string => join(dir, "tmp"),
  configDir: (): string => join(dir, "conf"),
  keychain: (): string => join(dir, "atlas-test.keychain"),
};

/**
 * Render the shipped wrapper the way provisioning does: substitute the absolute
 * tool paths. Testing the rendered artifact (not a hand-written copy) is the point —
 * a drift between this and `install-artifact.sh` would be a real install bug.
 */
function renderWrapper(): void {
  const src = readFileSync(WRAPPER_SRC, "utf8")
    .replaceAll("@ATLAS_BRAIN_BIN@", P.brain())
    .replaceAll("@ATLAS_CONFIG_DIR@", P.configDir())
    .replaceAll("@ATLAS_KEYCHAIN@", P.keychain())
    .replaceAll("@ATLAS_SECURITY_BIN@", P.security());
  writeFileSync(P.wrapper(), src, { mode: 0o755 });
}

/**
 * A `brain` stub that records argv + the full environment + whatever it can read on
 * fd 3, then exits with the status configured per subcommand.
 */
function writeBrainStub(opts: { syncRc: number; drainRc?: number }): void {
  const script = `#!/usr/bin/env bash
sub="$1"
{
  echo "ARGV|$*"
  echo "PWD|$sub|$PWD"
  echo "ENV_KEY|$sub|\${ATLAS_EGRESS_CAPABILITY_KEY-<unset>}"
  echo "ENV_FD|$sub|\${ATLAS_EGRESS_CAPABILITY_KEY_FD-<unset>}"
  # The whole environment, so a test can prove the raw secret is nowhere in it.
  env | sed "s|^|ENVDUMP:$sub:|"
} >> ${JSON.stringify(P.log())}
if [ "$sub" = "jobs" ]; then
  # Read the command-scoped fd exactly as the Node mint path does.
  if [ -r /dev/fd/3 ]; then cat <&3 > ${JSON.stringify(P.fdCapture())}; fi
  exit ${opts.drainRc ?? 0}
fi
exit ${opts.syncRc}
`;
  writeFileSync(P.brain(), script, { mode: 0o755 });
}

/** A `security` stub standing in for the Keychain fetch. */
function writeSecurityStub(opts: { secret?: string; rc?: number }): void {
  const script = `#!/usr/bin/env bash
echo "ARGV|security $*" >> ${JSON.stringify(P.log())}
${opts.secret !== undefined ? `printf '%s\\n' ${JSON.stringify(opts.secret)}` : ""}
exit ${opts.rc ?? 0}
`;
  writeFileSync(P.security(), script, { mode: 0o755 });
}

function runWrapper(env: Record<string, string> = {}): { status: number; stderr: string } {
  const res = spawnSync(P.wrapper(), [], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", TMPDIR: P.tmp(), ...env },
  });
  return { status: res.status ?? -1, stderr: res.stderr };
}

function log(): string {
  try {
    return readFileSync(P.log(), "utf8");
  } catch {
    return "";
  }
}

/** Which `brain` subcommands ran, in order. */
function invocations(): string[] {
  return log()
    .split("\n")
    .filter((l) => l.startsWith("ARGV|"))
    .map((l) => l.slice("ARGV|".length));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "atlas-autohook-"));
  mkdirSync(P.tmp(), { recursive: true });
  mkdirSync(P.configDir(), { recursive: true });
  // The wrapper `cd`s here and refuses to run without it — launchd's cwd is `/`.
  writeFileSync(join(P.configDir(), "brain.config.yaml"), "vault:\n  path: .\n");
  renderWrapper();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("atlas-sync-wrapper — step sequencing", () => {
  it("drains the reconcile job after a CLEAN sync (exit 0)", () => {
    writeBrainStub({ syncRc: 0 });
    writeSecurityStub({ secret: SECRET });
    const res = runWrapper();
    expect(res.status).toBe(0);
    expect(invocations()).toEqual(["sync --json", `security find-generic-password -w -s atlas-egress-capability -a atlas-agent ${P.keychain()}`, "jobs run --all --json"]);
  });

  it("STILL drains after a mixed clean+quarantined cycle (sync exit 6) — `set -e` must not abort", () => {
    writeBrainStub({ syncRc: 6 });
    writeSecurityStub({ secret: SECRET });
    const res = runWrapper();
    // The drain's status is the wrapper's status; the clean note still gets indexed.
    expect(res.status).toBe(0);
    expect(invocations()).toContain("jobs run --all --json");
  });

  it("propagates the drain's failure status", () => {
    writeBrainStub({ syncRc: 0, drainRc: 4 });
    writeSecurityStub({ secret: SECRET });
    expect(runWrapper().status).toBe(4);
  });
});

describe("atlas-sync-wrapper — true-abort statuses never drain", () => {
  for (const rc of [2, 3, 4, 5]) {
    it(`exits ${rc} without draining when sync exits ${rc}`, () => {
      writeBrainStub({ syncRc: rc });
      writeSecurityStub({ secret: SECRET });
      const res = runWrapper();
      expect(res.status).toBe(rc);
      expect(invocations()).toEqual(["sync --json"]);
      // Not even the Keychain is touched — no credential is fetched on an abort.
      expect(log()).not.toContain("find-generic-password");
    });
  }
});

describe("atlas-sync-wrapper — credential scoping", () => {
  it("runs `brain sync` with BOTH custody vars scrubbed, even when the caller's env sets them", () => {
    writeBrainStub({ syncRc: 0 });
    writeSecurityStub({ secret: SECRET });
    runWrapper({ ATLAS_EGRESS_CAPABILITY_KEY: "/inherited/path.key", ATLAS_EGRESS_CAPABILITY_KEY_FD: "7" });
    expect(log()).toContain("ENV_KEY|sync|<unset>");
    expect(log()).toContain("ENV_FD|sync|<unset>");
  });

  it("hands the drain fd 3 — and the raw secret appears in NO process environment", () => {
    writeBrainStub({ syncRc: 0 });
    writeSecurityStub({ secret: SECRET });
    expect(runWrapper().status).toBe(0);
    expect(log()).toContain("ENV_FD|jobs|3");
    expect(readFileSync(P.fdCapture(), "utf8")).toBe(SECRET);
    for (const line of log().split("\n").filter((l) => l.startsWith("ENVDUMP:"))) {
      expect(line).not.toContain(SECRET);
    }
  });

  it("never writes the secret to a temp file (here-strings would — process substitution does not)", () => {
    writeBrainStub({ syncRc: 0 });
    writeSecurityStub({ secret: SECRET });
    runWrapper();
    const leaked = readdirSync(P.tmp()).filter((f) => {
      try {
        return readFileSync(join(P.tmp(), f), "utf8").includes(SECRET);
      } catch {
        return false;
      }
    });
    expect(leaked).toEqual([]);
  });

  it("the fd payload is a WORKING mint secret end-to-end (resolver → mint → verify)", () => {
    writeBrainStub({ syncRc: 0 });
    writeSecurityStub({ secret: SECRET });
    runWrapper();
    const delivered = readFileSync(P.fdCapture(), "utf8");
    const cap = mintEgressCapability(
      { runId: "01J0000000000000000000000A" },
      {
        operation: "embed",
        model: "text-embedding-004",
        maxBytes: 1024,
        maxTokens: 100,
        costCeiling: 1000,
        allowedSensitivity: "internal",
      },
      { secret: delivered },
    );
    // Minted with what the wrapper delivered; verified with what the Keychain holds.
    expect(verifyCapability(cap, { secret: SECRET })).toMatchObject({ ok: true });
  });
});

describe("atlas-sync-wrapper — fail-closed custody", () => {
  it("refuses to drain when the Keychain fetch FAILS (locked/absent item)", () => {
    writeBrainStub({ syncRc: 0 });
    writeSecurityStub({ rc: 44 });
    const res = runWrapper();
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/capability secret unavailable/i);
    expect(invocations()).not.toContain("jobs run --all --json");
  });

  it("refuses to drain when the Keychain returns an EMPTY secret", () => {
    writeBrainStub({ syncRc: 0 });
    writeSecurityStub({ secret: "" });
    const res = runWrapper();
    expect(res.status).toBe(2);
    expect(invocations()).not.toContain("jobs run --all --json");
  });

  it("never leaks the secret into its own stderr on failure", () => {
    writeBrainStub({ syncRc: 0 });
    writeSecurityStub({ rc: 1 });
    expect(runWrapper().stderr).not.toContain(SECRET);
  });
});

describe("atlas-sync-wrapper — launchd environment (cwd is `/`)", () => {
  it("runs BOTH steps from the baked-in config dir — brain resolves <cwd>/brain.config.yaml", () => {
    writeBrainStub({ syncRc: 0 });
    writeSecurityStub({ secret: SECRET });
    expect(runWrapper().status).toBe(0);
    expect(log()).toContain(`PWD|sync|${P.configDir()}`);
    expect(log()).toContain(`PWD|jobs|${P.configDir()}`);
  });

  it("fails closed (exit 2) when the config dir holds no brain.config.yaml — never a silent bad-cwd run", () => {
    writeBrainStub({ syncRc: 0 });
    writeSecurityStub({ secret: SECRET });
    rmSync(join(P.configDir(), "brain.config.yaml"));
    const res = runWrapper();
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/no brain\.config\.yaml/i);
    expect(invocations()).toEqual([]);
  });

  it("names the keychain FILE explicitly — atlas-agent is home-less and has no login keychain", () => {
    writeBrainStub({ syncRc: 0 });
    writeSecurityStub({ secret: SECRET });
    runWrapper();
    expect(log()).toContain(`-a atlas-agent ${P.keychain()}`);
  });
});

describe("atlas-sync-wrapper — provisioning contract", () => {
  it("fails closed (exit 2) when the brain placeholder was never substituted", () => {
    const raw = readFileSync(WRAPPER_SRC, "utf8")
      .replaceAll("@ATLAS_CONFIG_DIR@", P.configDir())
      .replaceAll("@ATLAS_KEYCHAIN@", P.keychain())
      .replaceAll("@ATLAS_SECURITY_BIN@", P.security());
    writeFileSync(P.wrapper(), raw, { mode: 0o755 });
    const res = runWrapper();
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/brain executable not found/i);
  });

  it("invokes no bare `brain` — every call goes through the substituted absolute path", () => {
    const src = readFileSync(WRAPPER_SRC, "utf8");
    expect(src).not.toMatch(/^\s*brain\s/m);
    expect(src).toContain("@ATLAS_BRAIN_BIN@");
  });

  it("passes `shellcheck`-relevant strict mode (set -euo pipefail)", () => {
    expect(readFileSync(WRAPPER_SRC, "utf8")).toContain("set -euo pipefail");
  });
});
