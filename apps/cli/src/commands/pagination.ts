/**
 * The pagination CONTRACT shared by every registry-driven collection read of
 * Task 2.9 (`source list`, `note related`, `note history`, `git status`) — the
 * load-bearing part of the task. It is the single owner of the plan §2.5
 * pagination rules so no command re-implements (or drifts from) them:
 *
 *  - `--limit` default {@link DEFAULT_LIMIT} (50), hard-capped at {@link MAX_LIMIT}
 *    (500); `--offset` default 0. A `--limit` outside `[1, 500]` or a `--offset`
 *    below 0 is a `usage` error (exit 5) — {@link parseLimit} / {@link parseOffset}.
 *  - A DEFINED sort key with a UNIQUE tie-breaker (each command's
 *    `x-atlas-contract.ordering`), so offset pagination is deterministic even
 *    under concurrent inserts (two rows never compare equal → no row can swap
 *    across a page boundary because of a tie).
 *  - `{ limit, offset, total, hasMore }` — {@link buildPagination}. `total` is a
 *    LIVE (non-snapshot) count; `hasMore` is derived from the ACTUAL rows returned
 *    (`offset + rows < total`), never re-derived from `limit` (a short last page
 *    is reported correctly).
 *  - OUT-OF-RANGE offset ⇒ exit 5: a positive `--offset` that lands at or beyond
 *    `total` (an empty set has no page past 0) is a `usage` error, NOT a silent
 *    empty page — {@link assertOffsetInRange}. This is the semantic bound the
 *    contract pairs with `total`: you need `total` to know an offset is past the end.
 *
 * ## Best-effort anomaly bound (documented, plan §2.5 "best-effort under concurrency")
 * `total` and the page rows are read in separate statements, so a concurrent
 * insert/delete between them makes offset pagination best-effort: a row inserted
 * AHEAD of the current page (a newer `capturedAt`/`updatedAt` under a DESC key)
 * shifts every later row down one offset, so a full walk of all pages can see a
 * row at most ONCE MORE (a duplicate) or MISS it once (an omission). The bound is
 * strict: **across a paginated walk the number of duplicated-or-omitted rows is ≤
 * the number of rows inserted/deleted during the walk.** The unique tie-breaker
 * guarantees a STABLE total order at any instant, so within a single page snapshot
 * no row is ever duplicated or skipped; only inserts BETWEEN page reads move the
 * offset window. `pagination.contract.test` pins this bound.
 */
import { CliError } from "../errors/envelope.js";

/** Default `--limit` when unspecified (plan §2.5). */
export const DEFAULT_LIMIT = 50;
/** Hard ceiling for `--limit` (plan §2.5). */
export const MAX_LIMIT = 500;

/** A validated `--limit`/`--offset` pair. */
export interface PageRequest {
  readonly limit: number;
  readonly offset: number;
}

/** The `{ limit, offset, total, hasMore }` envelope every paginated command emits. */
export interface Pagination {
  readonly limit: number;
  readonly offset: number;
  readonly total: number;
  readonly hasMore: boolean;
}

/** A base-10 integer LITERAL: optional sign then one-or-more digits, nothing else. */
const INT_LEXICAL_RE = /^[+-]?\d+$/;

/**
 * Strictly parse a base-10 integer from a raw CLI value. Bare `Number(raw)` is too
 * permissive for a usage contract: `Number("")` is 0, `Number("1e2")` is 100,
 * `Number("0x10")` is 16, and surrounding whitespace is ignored — so `--offset=`,
 * `--offset=1e2`, `--offset=0x10` would all be silently accepted. This validates the
 * decimal-integer LEXICAL form first, then the safe-integer magnitude, returning the
 * value or `null` when `raw` is not a well-formed safe base-10 integer.
 */
function parseIntStrict(raw: string): number | null {
  if (!INT_LEXICAL_RE.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * Parse a `--limit` value. Must be a base-10 integer in `[1, MAX_LIMIT]`; anything
 * else (empty, non-integer, exponential/hex form, `< 1`, `> 500`) is a `usage` error
 * (exit 5). `command` scopes the message to the caller.
 */
export function parseLimit(command: string, raw: string): number {
  const n = parseIntStrict(raw);
  if (n === null || n < 1 || n > MAX_LIMIT) {
    throw CliError.usage(
      `\`${command}\`: --limit must be an integer in [1, ${MAX_LIMIT}] (got "${raw}")`,
    );
  }
  return n;
}

/**
 * Parse a `--offset` value. Must be a base-10 integer `>= 0`; anything else — empty
 * (`--offset=`), non-integer, exponential (`1e2`), hexadecimal (`0x10`), or negative —
 * is a `usage` error (exit 5). Lexical validation (not bare `Number()`) is what makes
 * `--offset=` a usage error rather than a silently-accepted 0.
 */
export function parseOffset(command: string, raw: string): number {
  const n = parseIntStrict(raw);
  if (n === null || n < 0) {
    throw CliError.usage(`\`${command}\`: --offset must be an integer >= 0 (got "${raw}")`);
  }
  return n;
}

/**
 * Assert `offset` names a reachable page given the live `total` (exit 5 otherwise).
 * `offset 0` is ALWAYS valid — it is the empty-set page too. Any positive offset
 * at or beyond `total` requests a page past the end (including every positive
 * offset when `total` is 0), which the contract treats as out-of-range, not a
 * silent empty page. Call AFTER computing `total`, BEFORE emitting.
 */
export function assertOffsetInRange(command: string, offset: number, total: number): void {
  if (offset > 0 && offset >= total) {
    throw CliError.usage(
      `\`${command}\`: --offset ${offset} is out of range (only ${total} row(s) available)`,
      total === 0
        ? "The collection is empty; use --offset 0."
        : `Valid offsets are 0..${total - 1}.`,
    );
  }
}

/**
 * Build the pagination envelope from the live `total` and the ACTUAL row count
 * returned for this page. `hasMore` is `offset + rows < total` — derived from the
 * rows actually returned so a short final page (or a concurrent delete) reports
 * `hasMore: false` correctly rather than trusting `offset + limit`.
 */
export function buildPagination(req: PageRequest, total: number, rows: number): Pagination {
  return { limit: req.limit, offset: req.offset, total, hasMore: req.offset + rows < total };
}
