/**
 * Pinned extractor library versions — a dependency-free module so the TRUSTED
 * `normalize()` orchestrator can reference the pins WITHOUT importing the per-format
 * parsers (and thus without pulling parse5 into the trusted process; the parsers stay
 * confined to the sandbox worker — wing round-2 findings 1 + 3).
 */

/**
 * Pinned parse5 generation (kept in sync with `packages/sources/package.json`). Bumping
 * parse5's behaviour bumps `EXTRACTOR_VERSION`, so an upgrade is a new rendition identity
 * — never silent drift. The conformance test asserts the installed parse5 equals this.
 */
export const PARSE5_VERSION = "8.0.1" as const;
