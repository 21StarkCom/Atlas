/**
 * The TERMINAL-SAFE renderer (Task 1.8 / #24) — the SINGLE human-output channel.
 *
 * Every human-facing byte Atlas prints passes through {@link render}. It neuters
 * terminal-injection vectors (plan §2.5, review hint "terminal-injection safety is
 * release-blocking") before any byte reaches a TTY:
 *
 *   - ANSI/CSI escape sequences (`ESC [ … final`) — SGR colour, cursor moves, erase.
 *   - OSC sequences incl. OSC-8 hyperlinks and OSC-52 clipboard writes
 *     (`ESC ] … (BEL | ESC \)`) — the whole sequence is removed; any visible OSC-8
 *     link *label* survives as inert plain text.
 *   - Every other `ESC`-introduced sequence — the lone `ESC` is stripped.
 *   - C1 control bytes `U+0080–U+009F` (incl. the 8-bit CSI `0x9B` / OSC `0x9D`).
 *   - C0 control bytes and `DEL` — EXCEPT `\t` (0x09) and `\n` (0x0A), which are
 *     preserved. `\r` (0x0D) is stripped so a CR-overwrite cannot rewrite a line.
 *   - Unicode bidi formatting controls (RLO/LRO/isolates/marks) — stripped so a
 *     bidi override cannot reorder surrounding text; the logical text survives.
 *
 * The renderer is deliberately colour-free: because every SGR escape is stripped,
 * output is inherently `NO_COLOR`-clean regardless of the caller's flags.
 */

/** CSI (7-bit): `ESC [` params `[0-?]*` intermediates `[ -/]*` final `[@-~]`. */
const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;

/**
 * OSC (7-bit): `ESC ]` … terminated by BEL (`\x07`) or ST (`ESC \`). Non-greedy so
 * back-to-back OSC-8 open/close pairs each match. Removes the sequence AND its
 * payload (the hyperlink target / clipboard data); an OSC-8 label between an
 * open/close pair is plain text and is left intact.
 */
const OSC = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g;

/** Any remaining lone `ESC` (malformed / other escape). */
const ESC = /\x1b/g;

/** C1 control bytes U+0080–U+009F (8-bit CSI/OSC introducers live here). */
const C1 = /[\x80-\x9f]/g;

/**
 * Unicode bidi formatting controls: LRE/RLE/PDF/LRO/RLO (U+202A–U+202E),
 * LRI/RLI/FSI/PDI (U+2066–U+2069), LRM/RLM (U+200E/U+200F), ALM (U+061C).
 */
const BIDI = /[‪-‮⁦-⁩‎‏؜]/g;

/**
 * Remaining C0 controls + DEL, EXCEPT tab (0x09) and newline (0x0A). This range
 * (`\x00-\x08`, `\x0b-\x1f`, `\x7f`) deliberately includes CR (0x0D) — the
 * CR-overwrite vector — and VT/FF/BS/BEL.
 */
const C0_EXCEPT_TAB_NL = /[\x00-\x08\x0b-\x1f\x7f]/g;

/** Options controlling how {@link render} emits its (already-sanitized) text. */
export interface RenderOpts {
  /**
   * Output mode. In `"json"` mode the renderer suppresses human output entirely
   * (structured JSON is emitted by the JSON/envelope path, not here).
   */
  mode: "human" | "json";
  /** Suppress non-error human output (`--quiet`). */
  quiet: boolean;
  /** Append a trailing newline to written output (default true). */
  newline: boolean;
  /** Destination stream. Defaults to `process.stdout`. */
  stream: NodeJS.WritableStream;
}

const DEFAULT_OPTS: RenderOpts = {
  mode: "human",
  quiet: false,
  newline: true,
  stream: process.stdout,
};

/**
 * Sanitize `text` into a terminal-safe form. Pure — no I/O. Exposed so callers
 * (progress lines, error messages) can neuter a string without emitting it, and
 * so tests can assert the neutered form directly.
 */
export function sanitize(text: string): string {
  return text
    .replace(OSC, "")
    .replace(CSI, "")
    .replace(ESC, "")
    .replace(C1, "")
    .replace(BIDI, "")
    .replace(C0_EXCEPT_TAB_NL, "");
}

/**
 * The single human-output path. Sanitizes `text`, writes it to the target stream
 * (unless suppressed by `json`/`quiet` mode), and returns the sanitized string.
 *
 * NO command may write human output except through here (enforced by
 * `no-render-bypass.test.ts`).
 */
export function render(text: string, opts: Partial<RenderOpts> = {}): string {
  const o: RenderOpts = { ...DEFAULT_OPTS, ...opts };
  const safe = sanitize(text);
  // JSON mode: no human bytes. Quiet: suppress ordinary output (errors render to
  // their own stream and pass quiet:false).
  if (o.mode === "json" || o.quiet) return safe;
  o.stream.write(o.newline ? `${safe}\n` : safe);
  return safe;
}
