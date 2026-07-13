/**
 * `BrokerClient` — the client library for the broker IPC seam (D10).
 *
 * Connects to the broker's Unix socket and exposes the plan Task-1.6 surface:
 * `appendAuditEvent`, `advanceProtectedRef`, `integrateSourceCapture`,
 * `mintChallenge`, `execAuthorized`. Refusals from the daemon are rebuilt into a
 * {@link BrokerRefusal} so callers see the same stable code + exit code they
 * would in-process.
 */
import { connect, type Socket } from "node:net";
import {
  type AuthorizationChallenge,
  type AuthorizationResponse,
  type SignedAuditEvent,
} from "@atlas/contracts";
import { BrokerRefusal, type RefusalCode } from "./errors.js";
import {
  encodeAuditEvent,
  encodeFrame,
  FrameDecoder,
  validateResponse,
  validateResult,
  type BrokerMethod,
} from "./protocol.js";
import type { AppendResult } from "./audit-append.js";
import type { PrivilegedOpDescriptor } from "./authorize.js";
import type { RefAdvanceRequest, RefAdvanceResult, SourceCaptureRequest } from "./refs.js";
import type { PrivilegedOpResult } from "./service.js";

interface Pending {
  readonly method: BrokerMethod;
  resolve(value: unknown): void;
  reject(err: unknown): void;
}

export class BrokerClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly decoder = new FrameDecoder();

  private constructor(private readonly socket: Socket) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.onData(chunk));
    socket.on("close", () => this.failAll(new Error("broker connection closed")));
    socket.on("error", (err) => this.failAll(err));
  }

  /** Connect to the broker socket at `socketPath`. */
  static connect(socketPath: string): Promise<BrokerClient> {
    return new Promise((resolve, reject) => {
      const socket = connect(socketPath);
      socket.once("connect", () => {
        socket.removeListener("error", reject);
        resolve(new BrokerClient(socket));
      });
      socket.once("error", reject);
    });
  }

  private onData(chunk: string): void {
    let frames: unknown[];
    try {
      frames = this.decoder.push(chunk);
    } catch {
      return; // ignore an unparseable frame; the id-less garbage cannot be routed
    }
    for (const frame of frames) {
      // Validate the response against the IPC contract — a malformed frame must
      // never resolve a typed client call with garbage.
      const res = validateResponse(frame);
      if (res === null) continue; // uncorrelatable / malformed: cannot route safely
      const p = this.pending.get(res.id);
      if (p === undefined) continue;
      this.pending.delete(res.id);
      if (res.ok) {
        // A correlatable success frame must ALSO carry a result that conforms to
        // the method we sent — otherwise a malformed success response would
        // resolve a typed call with arbitrary data (round-3 finding 5).
        const validated = validateResult(p.method, res.result);
        if (validated === null) {
          p.reject(
            new BrokerRefusal(
              "broker.bad_request",
              `malformed success result for "${p.method}" — rejecting rather than resolving with garbage`,
            ),
          );
        } else {
          p.resolve(validated);
        }
      } else {
        p.reject(new BrokerRefusal(res.code as RefusalCode, res.message, res.detail));
      }
    }
  }

  private failAll(err: unknown): void {
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }

  private call<T>(method: BrokerMethod, params: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { method, resolve: resolve as (v: unknown) => void, reject });
      this.socket.write(encodeFrame({ id, method, params }));
    });
  }

  /** Append a signed audit event; returns its seq + the new audit head. */
  appendAuditEvent(e: SignedAuditEvent): Promise<AppendResult> {
    return this.call("appendAuditEvent", encodeAuditEvent(e));
  }

  /** Advance a protected ref under CAS + ancestry (+ optional authorization). */
  advanceProtectedRef(r: RefAdvanceRequest): Promise<RefAdvanceResult> {
    return this.call("advanceProtectedRef", { ...r, auditEvent: encodeAuditEvent(r.auditEvent) });
  }

  /** Integrate a Tier-1 source capture (sources/** + manifest only). */
  integrateSourceCapture(r: SourceCaptureRequest): Promise<RefAdvanceResult> {
    return this.call("integrateSourceCapture", { ...r, auditEvent: encodeAuditEvent(r.auditEvent) });
  }

  /** Mint an authorization challenge for a privileged op. */
  mintChallenge(op: PrivilegedOpDescriptor): Promise<AuthorizationChallenge> {
    return this.call("mintChallenge", op);
  }

  /** Verify an authorization for a privileged op. */
  execAuthorized(op: PrivilegedOpDescriptor, auth: AuthorizationResponse): Promise<PrivilegedOpResult> {
    return this.call("execAuthorized", { op, auth });
  }

  /** Close the connection. */
  close(): void {
    this.socket.end();
  }
}
