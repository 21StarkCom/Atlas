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
 * The V1 prompt content. Versioned by ref (`prompts/<name>@<n>`): editing a prompt
 * mints a NEW ref rather than mutating an existing one, so a persisted `model_calls`
 * request hash always maps back to the exact instructions that were transmitted.
 */
const V1_PROMPTS: Readonly<Record<string, string>> = {
  "prompts/extract@1":
    "You are Atlas's source-extraction step. From the SOURCE TEXT that follows, extract only claims that are explicitly supported by the text. Do not infer, speculate, or add external knowledge. Return grounded claims with their supporting spans.",
  "prompts/classify@1":
    "You are Atlas's source-classification step. Classify the SOURCE TEXT that follows against the requested schema. Use only evidence present in the text; when the text is insufficient, prefer the most conservative label.",
  "prompts/synthesize@1":
    "You are Atlas's synthesis step. Compose the requested output strictly from the provided grounded claims and their evidence. Never introduce facts absent from the inputs.",
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
