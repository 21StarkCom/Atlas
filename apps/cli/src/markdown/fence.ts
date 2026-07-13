/**
 * Fenced-code-block detection (Task 1.3), shared by the wiki-link scanner
 * (`parse.ts`) and the section-model scanner (`sections.ts`). Getting this
 * right matters: a code fence hides `[[links]]` and `#headings` from structural
 * interpretation, so a fence that closes too early (or too late) leaks code
 * content into the model.
 *
 * We follow CommonMark's rule set precisely enough for that job:
 *  - An opening fence is ≥3 backticks or ≥3 tildes, indented ≤3 spaces.
 *  - The closing fence must use the SAME character AND be AT LEAST as long as
 *    the opener, indented ≤3 spaces, with nothing but trailing whitespace after
 *    it. A shorter run, a different character, or trailing content does NOT
 *    close the block.
 *  - A backtick opener's info string may not itself contain a backtick.
 *
 * Tracking only the delimiter *character* (the prior bug) let a 3-tick block be
 * closed by a shorter/foreign fence or a same-character line with trailing text.
 */

/** An open fence's delimiter character and its opening run length. */
export interface OpenFence {
  readonly char: "`" | "~";
  readonly len: number;
}

/** If `line` opens a fenced code block, return its fence; otherwise `null`. */
export function openingFence(line: string): OpenFence | null {
  const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!m) return null;
  const marker = m[1]!;
  const char = marker[0] as "`" | "~";
  // CommonMark: a backtick info string may not contain a backtick (it would be
  // ambiguous with an inline code span), so such a line does not open a block.
  if (char === "`" && m[2]!.includes("`")) return null;
  return { char, len: marker.length };
}

/**
 * True iff `line` is a valid closing fence for the currently-open `fence`:
 * same character, run length ≥ the opener's, ≤3 leading spaces, and only
 * trailing whitespace after the run.
 */
export function isClosingFence(line: string, fence: OpenFence): boolean {
  const m = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
  if (!m) return false;
  const marker = m[1]!;
  return marker[0] === fence.char && marker.length >= fence.len;
}
