/**
 * `quarantine.config-schema.test` (Task 2.2 / #28) — the `quarantine` config section
 * rejects key-id configurations that would make freshly quarantined data unreadable
 * (finding: `key_id` could appear in `revoked_key_ids`, so the store would write new
 * bundles under a key `keyForRead` immediately rejects). Also enforces safe key-id
 * syntax + uniqueness.
 */
import { describe, expect, it } from "vitest";
import { QuarantineConfig } from "../src/config/schema.js";

describe("quarantine config schema — revoked/current key-id safety", () => {
  it("accepts a valid section (and applies defaults)", () => {
    const parsed = QuarantineConfig.parse({ key_id: "cli-custody-v2", revoked_key_ids: ["cli-custody-v1"] });
    expect(parsed.key_id).toBe("cli-custody-v2");
    expect(parsed.revoked_key_ids).toEqual(["cli-custody-v1"]);
    expect(parsed.keep).toBe(200); // default
    expect(parsed.retention_days).toBe(30); // default
  });

  it("defaults the whole section when omitted", () => {
    const parsed = QuarantineConfig.parse(undefined);
    expect(parsed.key_id).toBe("cli-custody-v1");
    expect(parsed.revoked_key_ids).toEqual([]);
  });

  it("REJECTS revoking the current key_id (new bundles would be unreadable)", () => {
    expect(() =>
      QuarantineConfig.parse({ key_id: "cli-custody-v1", revoked_key_ids: ["cli-custody-v1"] }),
    ).toThrow(/cannot appear in revoked_key_ids/);
  });

  it("REJECTS an unsafe current key_id", () => {
    expect(() => QuarantineConfig.parse({ key_id: "../escape" })).toThrow(/not a safe key id/);
    expect(() => QuarantineConfig.parse({ key_id: "a/b" })).toThrow(/not a safe key id/);
    expect(() => QuarantineConfig.parse({ key_id: ".." })).toThrow(/not a safe key id/);
  });

  it("REJECTS an unsafe revoked key id", () => {
    expect(() =>
      QuarantineConfig.parse({ key_id: "cli-custody-v2", revoked_key_ids: ["../evil"] }),
    ).toThrow(/not a safe key id/);
  });

  it("REJECTS duplicate revoked key ids", () => {
    expect(() =>
      QuarantineConfig.parse({ key_id: "cli-custody-v3", revoked_key_ids: ["cli-custody-v1", "cli-custody-v1"] }),
    ).toThrow(/duplicate/);
  });
});
