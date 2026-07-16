/**
 * `scan.engine.test` — representative secret formats are detected; clean content
 * passes; the guards quarantine-then-abort with exit 3.
 *
 * SECURITY NOTE: no live-format secret is committed here. Each representative
 * secret is ASSEMBLED at runtime from fragments (so neither this file nor git
 * push-protection sees a matchable credential) — exactly the pattern the committed
 * `fixtures/inputs/secret-bearing.md` documents. Assembled values are synthetic.
 */
import { describe, expect, it } from "vitest";
import {
  GeneratedArtifactGuard,
  PrePersistenceGuard,
  RULESET_ID,
  RULESET_VERSION,
  SecretDetectedError,
  scanBytes,
  type QuarantineSink,
  type SecretFinding,
} from "../src/index.js";

const enc = (s: string) => new TextEncoder().encode(s);

function scanText(s: string) {
  return scanBytes({ bytes: enc(s), context: { origin: "test", boundary: "pre-persistence" } });
}

// Assemble representative secrets at runtime (never a literal committed secret).
const A = "A".repeat(16);
const REPRESENTATIVE: { name: string; ruleId: string; text: string }[] = [
  { name: "AWS access key id", ruleId: "aws-access-key-id", text: `AKIA${A}` },
  {
    name: "AWS secret access key",
    ruleId: "aws-secret-access-key",
    text: `aws_secret_access_key = ${"wJ" + "a".repeat(38)}`,
  },
  { name: "GitHub token", ruleId: "github-token", text: `ghp_${"a1B2".repeat(9)}` },
  { name: "Google API key", ruleId: "google-api-key", text: `AIza${"aB9_".repeat(8)}xyz` },
  {
    name: "Slack token",
    ruleId: "slack-token",
    text: `xoxb-${"1".repeat(12)}-${"2".repeat(12)}-${"aB3".repeat(8)}`,
  },
  { name: "Stripe secret key", ruleId: "stripe-secret-key", text: `sk_live_${"aB3xY9".repeat(4)}` },
  {
    name: "JSON Web Token",
    ruleId: "jwt",
    text: `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${"eyJzdWIiOiIxMjM0NTY3ODkw"}.${"aBcDeF9gHiJk"}`,
  },
  {
    name: "PEM private key",
    ruleId: "private-key-block",
    text: `-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk=\n-----END OPENSSH PRIVATE KEY-----`,
  },
  { name: "password assignment", ruleId: "generic-secret-assignment", text: `password = "hunter2xyz"` },
];

describe("scanBytes — representative formats", () => {
  for (const c of REPRESENTATIVE) {
    it(`detects ${c.name}`, () => {
      const v = scanText(c.text);
      expect(v.clean).toBe(false);
      if (v.clean) return; // narrow
      expect(v.findings.map((f) => f.ruleId)).toContain(c.ruleId);
      expect(v.rulesetId).toBe(RULESET_ID);
      expect(v.rulesetVersion).toBe(RULESET_VERSION);
    });
  }

  it("detects a high-entropy token with no keyword anchor (entropy heuristic)", () => {
    // 44-char base64 of 32 random-looking bytes — high entropy, mixed alphabet.
    const token = "Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MEFCQ0RFRkdISUpL";
    const v = scanText(`the value is ${token} end`);
    expect(v.clean).toBe(false);
    if (v.clean) return;
    const hit = v.findings.find((f) => f.ruleId === "high-entropy-token");
    expect(hit).toBeDefined();
    expect(hit!.entropyBitsPerChar).toBeGreaterThanOrEqual(4.3);
  });
});

describe("scanBytes — BOM-marked UTF-16 encodings (normalization-contract accepted set)", () => {
  const utf16le = (s: string) => {
    const body = Buffer.from(s, "utf16le");
    return new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xfe]), body]));
  };
  const utf16be = (s: string) => {
    const le = Buffer.from(s, "utf16le");
    const be = Buffer.alloc(le.length);
    for (let i = 0; i + 1 < le.length; i += 2) {
      be[i] = le[i + 1]!;
      be[i + 1] = le[i]!;
    }
    return new Uint8Array(Buffer.concat([Buffer.from([0xfe, 0xff]), be]));
  };
  const utf8bom = (s: string) => new Uint8Array(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(s, "utf8")]));

  const secret = `AKIA${A}`;
  const entropyTok = "Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MEFCQ0RFRkdISUpL";

  it("detects a structural secret in a UTF-16LE-BOM stream", () => {
    const v = scanBytes({ bytes: utf16le(`key = ${secret}`), context: { origin: "u16le", boundary: "pre-persistence" } });
    expect(v.clean).toBe(false);
    if (v.clean) return;
    expect(v.findings.map((f) => f.ruleId)).toContain("aws-access-key-id");
  });

  it("detects a structural secret in a UTF-16BE-BOM stream", () => {
    const v = scanBytes({ bytes: utf16be(`ghp_${"a1B2".repeat(9)}`), context: { origin: "u16be", boundary: "pre-persistence" } });
    expect(v.clean).toBe(false);
    if (v.clean) return;
    expect(v.findings.map((f) => f.ruleId)).toContain("github-token");
  });

  it("detects a high-entropy token in a UTF-16LE-BOM stream", () => {
    const v = scanBytes({ bytes: utf16le(`value ${entropyTok} end`), context: { origin: "u16le", boundary: "pre-persistence" } });
    expect(v.clean).toBe(false);
    if (v.clean) return;
    expect(v.findings.some((f) => f.ruleId === "high-entropy-token")).toBe(true);
  });

  it("a UTF-8-BOM stream is decoded (BOM stripped) and scanned", () => {
    const v = scanBytes({ bytes: utf8bom(`password = "hunter2xyz"`), context: { origin: "u8bom", boundary: "pre-persistence" } });
    expect(v.clean).toBe(false);
    if (v.clean) return;
    expect(v.findings.map((f) => f.ruleId)).toContain("generic-secret-assignment");
  });

  it("clean UTF-16LE prose stays clean", () => {
    const v = scanBytes({ bytes: utf16le("just ordinary prose, nothing secret here\n"), context: { origin: "u16le", boundary: "pre-persistence" } });
    expect(v.clean).toBe(true);
  });
});

describe("scanBytes — clean content passes", () => {
  const cleanSamples = [
    "# My note\n\nJust ordinary prose about a project. No secrets here.\n",
    "The quick brown fox jumps over the lazy dog. ".repeat(5),
    // A sha256 content hash: hex is 16-symbol ⇒ ≤ 4.0 bits/char, below the entropy floor.
    `contentHash: ${"a".repeat(1) + "0123456789abcdef".repeat(3) + "9c2f"}`,
    "sha256:9c2f8b1e0a...:text/markdown:1:1", // a serialized rendition id
    "aliases: [Foo Bar, בדיקה עברית, project-x]\n",
  ];
  for (const [i, s] of cleanSamples.entries()) {
    it(`clean sample #${i} yields clean:true`, () => {
      const v = scanText(s);
      expect(v.clean).toBe(true);
    });
  }

  it("an empty input is clean", () => {
    expect(scanBytes({ bytes: new Uint8Array(), context: { origin: "e", boundary: "pre-persistence" } }).clean).toBe(true);
  });
});

describe("scanBytes — determinism + non-leakage", () => {
  it("is deterministic across repeated + reordered runs", () => {
    const text = `AKIA${A} and ghp_${"a1B2".repeat(9)}`;
    const a = scanText(text);
    const b = scanText(text);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("never emits the raw secret in a finding", () => {
    const secret = `ghp_${"a1B2".repeat(9)}`;
    const v = scanText(`token = ${secret}`);
    expect(v.clean).toBe(false);
    if (v.clean) return;
    const blob = JSON.stringify(v.findings);
    expect(blob).not.toContain(secret);
    for (const f of v.findings) expect(f.redactedPreview).not.toContain(secret);
  });

  it("orders findings by offset", () => {
    const v = scanText(`ghp_${"a1B2".repeat(9)}\nAKIA${A}`);
    expect(v.clean).toBe(false);
    if (v.clean) return;
    for (let i = 1; i < v.findings.length; i++) {
      expect(v.findings[i]!.startOffset).toBeGreaterThanOrEqual(v.findings[i - 1]!.startOffset);
    }
  });
});

/** A recording sink so tests can assert quarantine-before-throw semantics. */
class RecordingSink implements QuarantineSink {
  calls: { origin: string; findings: readonly SecretFinding[]; bytes: Uint8Array }[] = [];
  quarantine(input: { bytes: Uint8Array; origin: string; findings: readonly SecretFinding[] }): Promise<void> {
    this.calls.push({ origin: input.origin, findings: input.findings, bytes: input.bytes });
    return Promise.resolve();
  }
}

describe("PrePersistenceGuard", () => {
  it("passes clean bytes without quarantining", async () => {
    const sink = new RecordingSink();
    await new PrePersistenceGuard(sink).assertClean({ bytes: enc("clean prose"), origin: "note.md" });
    expect(sink.calls).toHaveLength(0);
  });

  it("quarantines THEN throws SecretDetectedError (exit 3) on a hit", async () => {
    const sink = new RecordingSink();
    const guard = new PrePersistenceGuard(sink);
    const bytes = enc(`AKIA${A}`);
    await expect(guard.assertClean({ bytes, origin: "note.md", kind: "raw" })).rejects.toBeInstanceOf(
      SecretDetectedError,
    );
    // Quarantine happened (before the throw), with the offending bytes + findings.
    expect(sink.calls).toHaveLength(1);
    expect(sink.calls[0]!.origin).toBe("note.md");
    expect(sink.calls[0]!.findings.length).toBeGreaterThan(0);
    expect(sink.calls[0]!.bytes).toEqual(bytes);
  });

  it("snapshots bytes at entry: a caller mutation during the async sink cannot alter quarantined content", async () => {
    // A sink that BLOCKS (async) while the caller mutates the shared buffer.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const captured: Uint8Array[] = [];
    const blockingSink: QuarantineSink = {
      async quarantine(input) {
        captured.push(input.bytes);
        await gate; // hold the quarantine open while the caller mutates below
      },
    };
    const bytes = enc(`AKIA${A}`);
    const original = Uint8Array.from(bytes);
    const guard = new PrePersistenceGuard(blockingSink);
    const pending = guard.assertClean({ bytes, origin: "note.md" });
    // Mutate the caller-owned buffer while quarantine is mid-flight.
    bytes.fill(0);
    release();
    await expect(pending).rejects.toBeInstanceOf(SecretDetectedError);
    // The quarantined bytes are the entry-time snapshot, unaffected by the mutation.
    expect(captured).toHaveLength(1);
    expect(captured[0]).toEqual(original);
    expect(captured[0]).not.toEqual(bytes);
  });

  it("SecretDetectedError carries exitCode 3", async () => {
    const guard = new PrePersistenceGuard(new RecordingSink());
    try {
      await guard.assertClean({ bytes: enc(`ghp_${"a1B2".repeat(9)}`), origin: "x" });
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(SecretDetectedError);
      expect((e as SecretDetectedError).exitCode).toBe(3);
      expect((e as SecretDetectedError).boundary).toBe("pre-persistence");
    }
  });
});

describe("GeneratedArtifactGuard", () => {
  it("quarantines THEN throws on a secret in a model-derived artifact", async () => {
    const sink = new RecordingSink();
    const guard = new GeneratedArtifactGuard(sink);
    await expect(
      guard.assertClean({ text: `here is a key: sk_live_${"aB3xY9".repeat(4)}`, sink: "worktree", runId: "01ABC" }),
    ).rejects.toBeInstanceOf(SecretDetectedError);
    expect(sink.calls).toHaveLength(1);
    expect(sink.calls[0]!.origin).toContain("01ABC");
    expect(sink.calls[0]!.origin).toContain("worktree");
  });

  it("passes a clean artifact", async () => {
    const sink = new RecordingSink();
    await new GeneratedArtifactGuard(sink).assertClean({
      text: "A perfectly ordinary generated summary sentence.",
      sink: "sqlite",
      runId: "01XYZ",
    });
    expect(sink.calls).toHaveLength(0);
  });
});

describe("scanBytes — ruleset v2 entropy precision guards (real-vault FP corpus)", () => {
  // Each case reproduces a false-positive CLASS measured on a real 226-file vault
  // (369/369 entropy findings triaged, all FPs). None may flag.
  const FALSE_POSITIVES: { name: string; text: string }[] = [
    {
      name: "GitHub issue URL (path segments)",
      text: "- issue opened: [#450 Verify btree_gist](https://github.com/21-Stark-AI/meridian/issues/450)",
    },
    {
      name: "Slack archive URL (?thread_ts query)",
      text: "see https://getevinced.slack.com/archives/D06PZHZAFGA/p1780479296037719?thread_ts=1780479296.037719&cid=D06PZHZAFGA today",
    },
    {
      name: "Google Docs share URL (high-entropy doc id inside a URL)",
      text: "- https://docs.google.com/document/d/1qA2bC3dE4fG5hI6jK7lM8nO9pQ0rS1tU2vW3xY4zA5/edit?usp=drivesdk",
    },
    {
      name: "Amazon tracking URL (ad-blob query tail)",
      text: `"[Attitude Is Everything](https://www.amazon.com/dp/B0C1X2Y3Z4?cmp-8896614386:adg-91345587082:crv-411479337354&qid=1719858372&sr=8-1)"`,
    },
    {
      name: "kebab-case slug filename",
      text: "ref: 30_Research/the-90-day-onboarding-notebook-for-new-engineering-managers.md",
    },
    {
      name: "BigQuery billing table name (underscore + hex chunks)",
      text: "tables: `gcp_billing_export_v1_018EF0_DBA3E5_848D68`, `gcp_billing_export_resource_v1_018EF0_DBA3E5_848D68`",
    },
    {
      name: "CamelCase product word-chain (no digits)",
      text: "Integrates BigQueryLookerCoralogixHiBobGithubJiraSlackNotion.",
    },
    {
      name: "prose line ending 'secret:' followed by a policy list line",
      text: "Never store any secret:\n  Passwords, tokens, private keys, session cookies, credentials.",
    },
  ];
  for (const c of FALSE_POSITIVES) {
    it(`does not flag: ${c.name}`, () => {
      expect(scanText(c.text)).toMatchObject({ clean: true });
    });
  }

  // True positives the guards MUST retain (assembled at runtime, synthetic).
  it("still flags a bare slash-containing base64 secret (AWS-secret shape, no keyword)", () => {
    const tok = ["wJalrXUtnFEMI", "K7MDENG", "bPxRfiCYEXAMPLEKEY"].join("/");
    const v = scanText(`the value is ${tok} end`);
    expect(v.clean).toBe(false);
    if (v.clean) return;
    expect(v.findings.map((f) => f.ruleId)).toContain("high-entropy-token");
  });

  it("still flags a bare Google-Docs-style id OUTSIDE a URL", () => {
    const v = scanText("doc id is 1qA2bC3dE4fG5hI6jK7lM8nO9pQ0rS1tU2vW3xY4zA5 here");
    expect(v.clean).toBe(false);
  });

  it("still flags a structural credential shape INSIDE a URL (webhook)", () => {
    const v = scanText(`hook: https://hooks.slack.com/services/T${"0".repeat(8)}/B${"0".repeat(8)}/${"a1B2c3D4".repeat(3)}`);
    expect(v.clean).toBe(false);
    if (v.clean) return;
    expect(v.findings.map((f) => f.ruleId)).toContain("slack-webhook");
  });

  it("still flags a single-line secret assignment", () => {
    const v = scanText(`client_secret: ${"a1B2c3D4".repeat(3)}`);
    expect(v.clean).toBe(false);
    if (v.clean) return;
    expect(v.findings.map((f) => f.ruleId)).toContain("generic-secret-assignment");
  });

  it("hex digest stays clean (unchanged from v1)", () => {
    expect(scanText(`sha256: ${"9f2c4d8e1a3b".repeat(6)}`)).toMatchObject({ clean: true });
  });
});
