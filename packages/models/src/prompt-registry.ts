/**
 * The egress-side PROMPT REGISTRY (provider-interface §2, finding #2).
 *
 * A `GenerateTextRequest`/`GenerateObjectRequest` carries only a versioned
 * `prompt.ref` (`prompts/<name>@<n>`) — NEVER an inline prompt — so a caller cannot
 * smuggle arbitrary instructions and so the transmitted request is reproducible from
 * an audited reference. The adapter resolves that reference HERE, inside the broker,
 * and includes the resolved prompt CONTENT in the exact serialized HTTP body — which
 * is precisely the byte range the in-broker exact-payload scan hashes and inspects
 * (INVARIANT 2). Before this, `prompt.ref` was dropped: extraction/classification
 * calls transmitted the source `input` with NO task instructions, and the actual
 * prompt content was never covered by the scan (a scan bypass).
 *
 * Resolution FAILS CLOSED: an unknown reference throws a terminal `validation`
 * `ProviderCallError` at serialize time — before any transport, dispatch, or budget
 * reservation — rather than silently transmitting an instruction-less request.
 */
import { ProviderCallError, providerError } from "./provider-error.js";

/** A resolved prompt: its reference + the versioned task-instruction content. */
export interface ResolvedPrompt {
  readonly ref: string;
  readonly content: string;
}

/** Resolves a `prompt.ref` to its content, or `undefined` when unknown (fail-closed). */
export interface PromptRegistry {
  resolve(ref: string): ResolvedPrompt | undefined;
}

/**
 * The registered V1 prompt refs — the name SSOT shared with the CLI (#210: the CLI
 * once sent a hand-typed ref no registry entry backed, killing every synthesis
 * command at the first live daemon). Callers import these constants; the registry
 * below is keyed off them, so a ref that compiles is registered by construction.
 */
export const PROMPT_REFS = {
  extract: "prompts/extract@1",
  classify: "prompts/classify@1",
  synthesize: "prompts/synthesize@1",
  synthesisPlan: "prompts/synthesis-plan@1",
} as const;

/**
 * The V1 prompt content. Versioned by ref (`prompts/<name>@<n>`): editing a prompt
 * mints a NEW ref rather than mutating an existing one, so a persisted `model_calls`
 * request hash always maps back to the exact instructions that were transmitted.
 */
const V1_PROMPTS: Readonly<Record<string, string>> = {
  [PROMPT_REFS.extract]:
    "You are Atlas's source-extraction step. From the SOURCE TEXT that follows, extract only claims that are explicitly supported by the text. Do not infer, speculate, or add external knowledge. Return grounded claims with their supporting spans.",
  [PROMPT_REFS.classify]:
    "You are Atlas's source-classification step. Classify the SOURCE TEXT that follows against the requested schema. Use only evidence present in the text; when the text is insufficient, prefer the most conservative label.",
  [PROMPT_REFS.synthesize]:
    "You are Atlas's synthesis step. Compose the requested output strictly from the provided grounded claims and their evidence. Never introduce facts absent from the inputs.",
  // The synthesis-plan step's output is re-validated against the strict ChangePlan
  // schema on BOTH seam sides (broker parse + models client); serialize transmits no
  // responseSchema, so this prompt is the model's only description of the shape.
  // AppendSection is the sole steered op: it is patchable and its expectedContentHash
  // is optional — UpdateSection needs a content hash the model cannot know from the pack.
  [PROMPT_REFS.synthesisPlan]:
    'You are Atlas\'s synthesis-plan step. The user message is one JSON object: { kind, instruction, target, retrievalRunId, context } — kind is the workflow (enrich | reconcile | maintain), instruction states the task, target is the id of the note to change, and context.notes[] is the retrieval grounding (each note: noteId, sensitivity, trust, sections[] of { sectionPath, text }). Propose the smallest useful change to the target note, grounded strictly in the provided sections — never introduce facts absent from the inputs, and do not ground on notes whose trust is "unverified". Respond with EXACTLY one JSON object and nothing else (no markdown fences, no commentary): { "target": <the target note id>, "rationale": <one or two sentences citing the grounding noteIds>, "sourceIds": [], "retrievedEvidence": [<the noteIds used as grounding>], "confidence": <number 0..1>, "proposedRisk": "tier-1" | "tier-2", "reversibility": "reversible" | "conditional" | "irreversible", "schemaVersion": 1, "operation": { "op": "AppendSection", "opVersion": 1, "selector": { "path": <a section heading on the target note> }, "content": <the markdown to append>, "createIfAbsent": true } }. Emit every field shown and no field not shown.',
};

/** A registry backed by an in-memory map (the default is {@link DEFAULT_PROMPT_REGISTRY}). */
export class MapPromptRegistry implements PromptRegistry {
  constructor(private readonly prompts: Readonly<Record<string, string>>) {}
  resolve(ref: string): ResolvedPrompt | undefined {
    const content = this.prompts[ref];
    return content === undefined ? undefined : { ref, content };
  }
}

/** The default egress prompt registry (the V1 prompt set). */
export const DEFAULT_PROMPT_REGISTRY: PromptRegistry = new MapPromptRegistry(V1_PROMPTS);

/**
 * Resolve `ref` or FAIL CLOSED with a terminal `validation` provider error. Callers
 * invoke this at serialize time, so an unknown reference is rejected before any
 * transport/dispatch/budget draw — never transmitted as an instruction-less request.
 */
export function resolvePromptOrThrow(registry: PromptRegistry, ref: string): ResolvedPrompt {
  const resolved = registry.resolve(ref);
  if (resolved === undefined) {
    throw new ProviderCallError(
      providerError("validation", { message: `unknown prompt reference "${ref}" — refusing to transmit an instruction-less request` }),
    );
  }
  return resolved;
}
