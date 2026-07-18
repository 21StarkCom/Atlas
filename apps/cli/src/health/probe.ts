/**
 * `health/probe` — the daemon connect/close reachability probe (plan Phase 1
 * Task 3). Returns a TYPED {@link DaemonProbe} that distinguishes ordinary socket
 * unreachability (drives a `daemon` event, `reachable:false`) from an unexpected
 * probe fault (drives a non-fatal `watch.error`). A single boolean cannot carry
 * both, so the probe classifies through the SHARED {@link isTransportError} — the
 * same classifier the anchor probe uses, so the two socket-failure paths cannot
 * drift.
 *
 * Connect-then-close ONLY — no bytes are sent. The daemon NAME (broker vs egress)
 * is attached by the caller, not the probe.
 */
import { createConnection } from "node:net";
import { isTransportError } from "./socket-errors.js";

/**
 * The outcome of a daemon reachability probe:
 *  - `reachable`   — a clean connect (then close).
 *  - `unreachable` — a connect error {@link isTransportError} recognizes (ordinary
 *                    socket-down; drives a `daemon` event `reachable:false`).
 *  - `fault`       — any OTHER thrown error (unexpected: a non-socket path
 *                    (`ENOTSOCK`), an unanticipated syscall failure; drives a
 *                    non-fatal `watch.error`). Carries the `code` + `message`.
 */
export type DaemonProbe =
  | { readonly socketPath: string; readonly status: "reachable" }
  | { readonly socketPath: string; readonly status: "unreachable"; readonly code: string }
  | { readonly socketPath: string; readonly status: "fault"; readonly code: string; readonly message: string };

/**
 * Probe a Unix-domain socket by connecting and immediately closing — no bytes
 * cross the boundary. Never rejects: every outcome (including a synchronous
 * `createConnection` throw) resolves to a typed {@link DaemonProbe}.
 */
export function probeDaemon(socketPath: string): Promise<DaemonProbe> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (p: DaemonProbe, sock?: ReturnType<typeof createConnection>): void => {
      if (settled) return;
      settled = true;
      sock?.destroy();
      resolve(p);
    };

    let sock: ReturnType<typeof createConnection>;
    try {
      sock = createConnection({ path: socketPath });
    } catch (err) {
      // A synchronous throw (e.g. an invalid path shape) is an unexpected fault.
      const e = err as NodeJS.ErrnoException;
      finish({ socketPath, status: "fault", code: e.code ?? "UNKNOWN", message: e.message });
      return;
    }

    sock.once("connect", () => finish({ socketPath, status: "reachable" }, sock));
    sock.once("error", (err: NodeJS.ErrnoException) => {
      const code = typeof err.code === "string" ? err.code : "UNKNOWN";
      if (isTransportError(err)) {
        finish({ socketPath, status: "unreachable", code }, sock);
      } else {
        finish({ socketPath, status: "fault", code, message: err.message }, sock);
      }
    });
  });
}

/**
 * The reachability view (`doctor`/`assertReadAuditReady`/snapshot) — `true` iff a
 * clean connect succeeded. A type predicate, so a `!isReachable(p)` guard narrows
 * `p` to the `unreachable`/`fault` variants (their `code`/`message` become visible).
 */
export function isReachable(p: DaemonProbe): p is Extract<DaemonProbe, { status: "reachable" }> {
  return p.status === "reachable";
}
