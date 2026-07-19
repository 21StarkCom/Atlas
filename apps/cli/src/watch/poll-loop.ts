/**
 * `watch/poll-loop` — the attached `PRAGMA data_version` poll loop (SP-1 Phase 3
 * Task 3). Every `pollMs`, read `data_version` once on the transaction-free poller
 * connection; on change (vs the stored value), invoke the SERIALIZED async
 * `onTick`. The observed value is stored BEFORE `onTick` runs and never refreshed
 * after — a commit landing after the callback's source read but before a
 * post-callback refresh would otherwise be cached-without-diffing (a lost wakeup);
 * storing the pre-callback value leaves `data_version` ahead of the stored value,
 * so the next tick still fires.
 *
 * Each tick also `stat()`s the ledger path and compares `(device, inode)` + schema
 * head vs the attach-time identity — a mismatch/vanished path resolves the
 * completion promise `"reattach"` (Phase 3 detects; the re-attach ACTION is
 * Phase 5). `stop()` resolves `"stopped"`. Quiet-period heartbeats ride the SAME
 * serialized queue (`onHeartbeat`), so they never interleave with a tick.
 */
import { statSync } from "node:fs";
import { captureLedgerIdentity } from "@atlas/sqlite-store";
import { readDataVersion } from "./attach.js";
import type { AttachedLedger, WatchOpts } from "./types.js";

export interface PollHandle {
  stop(): void;
  done: Promise<"stopped" | "reattach">;
}

/**
 * Run the attached poll loop. `onTick` may itself report `"reattach"` (e.g. a
 * mid-diff fault Phase 5 classifies); the loop stops ticking once `done` resolves.
 */
export function runPollLoop(
  att: AttachedLedger,
  opts: WatchOpts,
  onTick: (att: AttachedLedger) => Promise<"continue" | "reattach">,
  onHeartbeat: () => Promise<void>,
): PollHandle {
  let resolveDone!: (v: "stopped" | "reattach") => void;
  const done = new Promise<"stopped" | "reattach">((r) => (resolveDone = r));
  let finished = false;
  let lastDataVersion = att.dataVersion;
  let lastHeartbeatAt = Date.now();
  // The serialized queue: every callback (tick or heartbeat) chains onto `queue`,
  // so a tick never starts until the prior tick/heartbeat promise resolves.
  let queue: Promise<void> = Promise.resolve();

  const finish = (v: "stopped" | "reattach"): void => {
    if (finished) return;
    finished = true;
    clearInterval(timer);
    // Resolve AFTER the in-flight callback drains — the final line is never truncated.
    void queue.then(() => resolveDone(v));
  };

  /** The identity guard: path must still name the attach-time (device, inode) + schema head. */
  const identityIntact = (): boolean => {
    try {
      const st = statSync(att.path);
      if (st.dev !== att.identity.device || st.ino !== att.identity.inode) return false;
      // Schema-head comparison uses the store-held fd's identity (same connection).
      const now = captureLedgerIdentity(att.ledger);
      return now.schemaHead === att.identity.schemaHead;
    } catch {
      return false; // vanished path (or a closed handle) — re-attach
    }
  };

  const tick = (): void => {
    if (finished) return;
    if (!identityIntact()) {
      finish("reattach");
      return;
    }
    // Read ONCE per tick, store BEFORE the callback — never refreshed after (lost-wakeup guard).
    const observed = readDataVersion(att.connection);
    const changed = observed !== lastDataVersion;
    if (changed) {
      lastDataVersion = observed;
      queue = queue.then(async () => {
        if (finished) return;
        const outcome = await onTick(att);
        if (outcome === "reattach") finish("reattach");
      });
    }
    const due = Date.now() - lastHeartbeatAt >= opts.heartbeatSeconds * 1000;
    if (due) {
      lastHeartbeatAt = Date.now();
      queue = queue.then(async () => {
        if (finished) return;
        await onHeartbeat();
      });
    }
  };

  // Deliberately NOT unref'd — this interval is what keeps the long-lived stream
  // process alive between events.
  const timer = setInterval(tick, opts.pollMs);

  return {
    stop: () => finish("stopped"),
    done,
  };
}
