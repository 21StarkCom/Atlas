/**
 * The shared `generateObject` schema registry (provider-interface §1) — the SSOT
 * that BOTH the `@atlas/models` client and the in-broker Gemini adapter resolve a
 * `schemaId` against. A Zod object cannot cross the egress IPC seam, so a
 * `generateObject` request carries only a `schemaId` string; both sides look it up
 * HERE so they are guaranteed to resolve the SAME schema (the client can then reject
 * a caller whose supplied Zod schema is not the registered one, and the broker
 * validates the model output against the identical schema).
 *
 * It lives in `@atlas/contracts` (the zero-dependency seam leaf) precisely so the
 * broker and the CLI client share ONE registry object rather than each owning a
 * private copy that could drift. Seeded with `ChangePlan`; a task that adds an
 * extraction/classification schema registers it here (or, in a test, injects an
 * overlay). An unknown `schemaId` resolves to `undefined` — the caller/broker maps
 * that to a fail-closed `validation` error (never a silently-unvalidated pass).
 */
import type { z } from "zod";
import { ChangePlanSchema } from "./changeplan.js";

/** The canonical shared registry: `schemaId` → the ONE Zod schema both sides use. */
export const SCHEMA_REGISTRY: Readonly<Record<string, z.ZodTypeAny>> = Object.freeze({
  ChangePlan: ChangePlanSchema,
});

/** The type of a schema registry (the SSOT one, or a test overlay of the same shape). */
export type SchemaRegistry = Readonly<Record<string, z.ZodTypeAny>>;

/** Resolve a `schemaId` to its registered schema against `registry` (default the SSOT), or `undefined`. */
export function resolveRegisteredSchema(
  schemaId: string,
  registry: SchemaRegistry = SCHEMA_REGISTRY,
): z.ZodTypeAny | undefined {
  return registry[schemaId];
}
