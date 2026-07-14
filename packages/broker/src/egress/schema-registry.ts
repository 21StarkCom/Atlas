/**
 * The `generateObject` schema registry the broker resolves a `schemaId` against —
 * consumed FROM the `@atlas/contracts` SSOT (`SCHEMA_REGISTRY`), NOT a private
 * broker copy. A Zod object cannot cross the process seam, so `generateObject`
 * requests carry only a `schemaId` string; BOTH the CLI client and the broker
 * adapter resolve it against the SAME shared registry, so they are guaranteed to
 * resolve the identical schema (no drift). An unknown `schemaId` is a fail-closed
 * `validation` error (never a silently-unvalidated pass). Additional entries are
 * registered in the contracts SSOT by their owning task, or injected as a test
 * overlay via `EgressServiceConfig.schemaRegistry`.
 */
import type { z } from "zod";
import { SCHEMA_REGISTRY } from "@atlas/contracts";

/** The default registry available on every egress broker — the shared contracts SSOT. */
export const DEFAULT_SCHEMA_REGISTRY: Readonly<Record<string, z.ZodTypeAny>> = SCHEMA_REGISTRY;

/** Resolve a `schemaId` to its registered schema, or `undefined` if unknown. */
export function resolveSchema(
  registry: Readonly<Record<string, z.ZodTypeAny>>,
  schemaId: string,
): z.ZodTypeAny | undefined {
  return registry[schemaId];
}
