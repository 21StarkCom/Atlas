import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import _Ajv2020 from "ajv/dist/2020.js";
// ajv ships a CJS default export; normalize the interop shape for NodeNext + tsc
// and type it as a plain constructor (validation correctness is asserted at runtime).
const Ajv2020 = ((_Ajv2020 as any).default ?? _Ajv2020) as new (opts?: unknown) => {
  compile: (schema: unknown) => ((data: unknown) => boolean) & { errors?: unknown };
  errorsText: (errors?: unknown) => string;
};

/**
 * Task 0.5 (#14): the Phase-1 cli-contract JSON Schemas + the shared error
 * envelope must (a) be valid JSON Schema (draft 2020-12), (b) validate their own
 * embedded `examples`, and (c) exist for every Phase-1 registry row. The error
 * envelope must validate the example error objects the command schemas reference.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const contractDir = join(root, "docs/specs/cli-contract");

function loadJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

// A fresh Ajv per compile keeps $id collisions from leaking across schemas.
function ajv() {
  return new Ajv2020({ strict: false, allErrors: true });
}

const schemaFiles = readdirSync(contractDir)
  .filter((f) => f.endsWith(".schema.json"))
  .sort();

describe("Phase-1 cli-contract schemas", () => {
  it("there are schema files present", () => {
    expect(schemaFiles.length).toBeGreaterThan(0);
  });

  for (const file of schemaFiles) {
    describe(file, () => {
      const schema = loadJson(join(contractDir, file));

      it("is a compilable JSON Schema (draft 2020-12)", () => {
        expect(() => ajv().compile(schema)).not.toThrow();
      });

      it("validates its own embedded examples", () => {
        const validate = ajv().compile(schema);
        const examples: unknown[] = Array.isArray(schema.examples) ? schema.examples : [];
        for (const ex of examples) {
          const ok = validate(ex);
          if (!ok) {
            throw new Error(`${file} example failed: ${ajv().errorsText(validate.errors)}`);
          }
          expect(ok).toBe(true);
        }
      });
    });
  }
});

describe("error envelope", () => {
  const envelope = loadJson(join(contractDir, "error-envelope.schema.json"));
  const validate = ajv().compile(envelope);

  it("validates a representative error object", () => {
    const ok = validate({
      code: "locked:ledger-maintenance",
      message: "another ledger-maintenance holder is active",
      hint: "retry once the other operation completes",
      retryable: true,
    });
    expect(ok).toBe(true);
  });

  it("rejects an object missing a required field (code)", () => {
    const ok = validate({ message: "x", hint: "y", retryable: false });
    expect(ok).toBe(false);
  });
});

describe("registry ↔ Phase-1 schema presence", () => {
  const registry = loadJson(join(contractDir, "commands.json"));
  const rows: any[] = Array.isArray(registry) ? registry : registry.commands;
  const phase1 = rows.filter((r) => r.phase === 1);

  it("has Phase-1 rows", () => {
    expect(phase1.length).toBeGreaterThan(0);
  });

  for (const r of phase1) {
    it(`every Phase-1 row has its schema file: ${r.name}`, () => {
      expect(existsSync(join(root, r.schemaRef))).toBe(true);
    });
  }
});
