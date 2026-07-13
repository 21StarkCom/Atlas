/**
 * `GeneratedArtifactGuard` — the second enforcement point of the scan spine. It
 * scans the EXACT serialized form of a model response and every derived artifact
 * (patches, diffs, commit messages, …) before it reaches any persistence/
 * transmission sink. Same engine as {@link import("./pre-persistence.js").PrePersistenceGuard},
 * a second boundary — it exists from the first model call so nothing a model emits
 * lands unscanned.
 *
 * On a hit it quarantines the serialized bytes through the injected
 * {@link QuarantineSink} and throws {@link SecretDetectedError} (exit 3 at the CLI
 * boundary).
 */
import { scanBytes } from "./engine.js";
import { SecretDetectedError, type PersistenceSink, type QuarantineSink } from "./types.js";

/** UTF-8 encode the exact serialized artifact text for scanning + quarantine. */
const ENCODER = new TextEncoder();

export class GeneratedArtifactGuard {
  /** @param sink the CLI-side quarantine store (structural — the leaf never imports it). */
  constructor(private readonly sink: QuarantineSink) {}

  /**
   * Scan `text` (the exact serialized artifact) destined for `sink`; if clean,
   * return. Otherwise quarantine the bytes and throw {@link SecretDetectedError}.
   * `sink` names the destination the artifact was about to reach; `runId`
   * correlates the refusal to its run.
   */
  async assertClean(a: {
    readonly text: string;
    readonly sink: PersistenceSink;
    readonly runId: string;
  }): Promise<void> {
    const origin = `run:${a.runId}→${a.sink}`;
    const bytes = ENCODER.encode(a.text);
    const verdict = scanBytes({
      bytes,
      context: { origin, boundary: "generated-artifact", sink: a.sink },
    });
    if (verdict.clean) return;
    await this.sink.quarantine({ bytes, origin, findings: verdict.findings });
    throw new SecretDetectedError(origin, verdict.findings, "generated-artifact");
  }
}
