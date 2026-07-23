/**
 * envelope — the JSON error-envelope emitter, validated against the 0.5 schema.
 *
 * Asserts CliError → envelope serialization, exit-code categories (plan §2.5),
 * omission of absent optionals, and schema-conformance via ajv.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import {
  CliError,
  EXIT,
  toEnvelope,
  writeErrorEnvelope,
  isCliError,
} from "../src/errors/envelope.js";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const SCHEMA = JSON.parse(
  readFileSync(
    join(REPO_ROOT, "docs", "specs", "cli-contract", "error-envelope.schema.json"),
    "utf8",
  ),
) as object;

const ajv = new Ajv2020({ strict: false });
const validate = ajv.compile(SCHEMA);

function capture(): NodeJS.WritableStream & { text: string } {
  return {
    text: "",
    write(chunk: string | Uint8Array): boolean {
      (this as { text: string }).text +=
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    },
  } as NodeJS.WritableStream & { text: string };
}

describe("error envelope", () => {
  it("maps the plan §2.5 exit categories", () => {
    expect(EXIT).toEqual({
      OK: 0,
      VALIDATION: 1,
      CONFIG: 2,
      INTERNAL: 4,
      USAGE: 5,
    });
  });

  it("serializes a minimal error and validates against the 0.5 schema", () => {
    const e = CliError.usage(
      "`--dry-run` and `--apply` are mutually exclusive.",
      "Pass at most one of --dry-run / --apply.",
    );
    const env = toEnvelope(e);
    expect(env).toEqual({
      code: "usage",
      message: "`--dry-run` and `--apply` are mutually exclusive.",
      hint: "Pass at most one of --dry-run / --apply.",
      retryable: false,
    });
    expect(validate(env)).toBe(true);
  });

  it("omits absent optional fields (no undefined keys leak into JSON)", () => {
    const env = toEnvelope(CliError.internal("boom"));
    expect(Object.keys(env).sort()).toEqual(["code", "hint", "message", "retryable"]);
    expect(JSON.stringify(env)).not.toContain("undefined");
  });

  it("carries details + retryable + retryAfterMs and validates (lock example)", () => {
    const e = new CliError({
      code: "locked:vault-maintenance",
      message: "The vault-maintenance lock is held by another process.",
      hint: "Wait for the holder to finish — a dead holder's lock is reclaimed automatically on the next acquire.",
      exitCode: EXIT.CONFIG,
      retryable: true,
      details: { scope: "vault-maintenance", holderPid: 44122, startedAt: "2026-07-12T09:31:04.512Z" },
    });
    const env = toEnvelope(e);
    expect(env.details).toMatchObject({ holderPid: 44122 });
    expect(env.retryable).toBe(true);
    expect(validate(env)).toBe(true);
  });

  it("carries nested errors[] and validates (batch validation example)", () => {
    const e = new CliError({
      code: "validation",
      message: "2 notes failed frontmatter validation.",
      hint: "Fix the reported notes and re-run.",
      exitCode: EXIT.VALIDATION,
      errors: [
        { code: "validation", message: "Missing required frontmatter key `id`.", details: { location: { file: "notes/orphan.md", line: 1 } } },
        { code: "validation", message: "Duplicate note id `person-alice`.", details: { field: "id", location: { file: "notes/alice-2.md", line: 2 } } },
      ],
    });
    const env = toEnvelope(e);
    expect(env.errors).toHaveLength(2);
    expect(validate(env)).toBe(true);
  });

  it("writeErrorEnvelope emits one NDJSON line and returns the exit code", () => {
    const out = capture();
    const code = writeErrorEnvelope(CliError.usage("nope"), out);
    expect(code).toBe(5);
    expect(out.text.endsWith("\n")).toBe(true);
    expect(out.text.split("\n").filter((l) => l).length).toBe(1);
    const parsed = JSON.parse(out.text);
    expect(parsed).toMatchObject({ code: "usage", message: "nope", retryable: false });
    expect(validate(parsed)).toBe(true);
  });

  it("isCliError narrows", () => {
    expect(isCliError(CliError.usage("x"))).toBe(true);
    expect(isCliError(new Error("x"))).toBe(false);
  });
});
