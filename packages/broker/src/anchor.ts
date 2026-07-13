/**
 * WORM audit-anchor (security/broker contract §6, D8).
 *
 * The broker records the `refs/audit/runs` head + a monotonic `eventCount` into
 * an append-only file OUTSIDE the agent-writable repo (broker-owned `0600`).
 * Each line is an Ed25519 envelope (§8) over an `AuditAnchor`. On startup and on
 * every append the current audit-ref count is checked against the latest
 * anchor's `eventCount`: any truncation or suffix-rewrite of the audit ref makes
 * the live count REGRESS below the anchor — detectable even after SQLite loss —
 * and forces fail-closed (`broker.anchor_truncation`).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { type KeyObject } from "node:crypto";
import { AuditAnchorSchema, type AuditAnchor, type SignedEnvelope } from "@atlas/contracts";
import { signEnvelope, verifyEnvelope } from "./crypto.js";
import { BrokerRefusal } from "./errors.js";

/** Format a Date as an RFC-3339 UTC millisecond timestamp ending `Z` (§8.2). */
export function rfc3339Ms(d: Date): string {
  return d.toISOString().replace(/(\.\d{3})\d*Z$/, "$1Z");
}

export class WormAnchor {
  constructor(
    private readonly path: string,
    private readonly attestationKey: KeyObject,
    private readonly attestationPub: KeyObject,
    private readonly attestationSignerId: string,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Read every anchor record in file order (oldest → newest); [] if absent. */
  readAll(): SignedEnvelope[] {
    if (!existsSync(this.path)) return [];
    const raw = readFileSync(this.path, "utf8");
    return raw
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l) as SignedEnvelope);
  }

  /** The latest (highest-`eventCount`) valid anchor record, or `null` if none. */
  latest(): AuditAnchor | null {
    const all = this.readAll();
    if (all.length === 0) return null;
    const env = all[all.length - 1]!;
    if (!verifyEnvelope(env, this.attestationPub)) {
      throw new BrokerRefusal("broker.anchor_truncation", "latest WORM anchor signature is invalid");
    }
    return AuditAnchorSchema.parse(env.payload);
  }

  /**
   * Append a new anchor record for `auditHead`/`eventCount`. `eventCount` must
   * be strictly greater than the latest anchor's — the WORM invariant.
   */
  append(auditHead: string, eventCount: number): AuditAnchor {
    const prev = this.latest();
    if (prev !== null && eventCount <= prev.eventCount) {
      throw new BrokerRefusal(
        "broker.anchor_truncation",
        `refusing to anchor a non-increasing eventCount (${eventCount} ≤ ${prev.eventCount})`,
      );
    }
    const anchor: AuditAnchor = {
      schemaVersion: 1,
      anchoredAt: rfc3339Ms(new Date(this.now())),
      auditHead,
      eventCount,
      signerId: this.attestationSignerId,
    };
    const env = signEnvelope(anchor, this.attestationSignerId, this.attestationKey);
    if (!existsSync(this.path)) mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, JSON.stringify(env) + "\n", { mode: 0o600 });
    return anchor;
  }

  /**
   * Fail-closed startup/verify check (§6) that binds the anchored head to its
   * exact POSITION in the live chain, for ALL live counts — closing the
   * rewrite-then-append bypass (round-3 finding 4).
   *
   * `commitsOldestToNewest` is the full live audit-ref commit list. Let `A` be
   * the latest anchor's `eventCount` and `H` its `auditHead`:
   *   - live length `< A` ⇒ truncation (count regressed below the anchor);
   *   - otherwise the commit at anchored position `A` (`commits[A-1]`) MUST equal
   *     `H`. This proves the entire anchored prefix is intact even when the live
   *     chain is LONGER than the anchor — an attacker who rewrites an anchored
   *     suffix and appends one extra valid event shifts `commits[A-1]` off `H`
   *     and is caught (the previous count-only acceptance let that pass).
   * A live count strictly greater than the anchor with the anchored head still at
   * position `A` is legitimate (appends persisted since the last anchor write).
   */
  verifyChain(commitsOldestToNewest: readonly string[]): void {
    const prev = this.latest();
    if (prev === null) return;
    const live = commitsOldestToNewest.length;
    if (live < prev.eventCount) {
      throw new BrokerRefusal(
        "broker.anchor_truncation",
        `audit ref count ${live} regressed below anchored ${prev.eventCount} — truncation detected`,
      );
    }
    if (prev.eventCount === 0) return; // nothing anchored yet to bind a position to
    const atAnchoredPosition = commitsOldestToNewest[prev.eventCount - 1] ?? null;
    if (atAnchoredPosition !== prev.auditHead) {
      throw new BrokerRefusal(
        "broker.anchor_truncation",
        `commit at anchored position ${prev.eventCount} is ${atAnchoredPosition ?? "(none)"} ≠ anchored head ${prev.auditHead} — suffix rewrite detected`,
      );
    }
  }
}
