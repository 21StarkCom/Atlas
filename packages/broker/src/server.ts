/**
 * Broker Unix-domain-socket server (D10).
 *
 * Runs as `atlas-broker` under `provisioning/bin/broker-launcher.sh`. Accepts
 * framed-JSON requests (see {@link protocol}), dispatches to the
 * {@link BrokerService}, and replies with a typed result or a typed refusal —
 * a {@link BrokerRefusal} becomes an `ok:false` frame carrying its stable code +
 * exit code; any other throw is coerced to `broker.internal` so no raw stack
 * ever crosses the seam.
 */
import { createServer, type Server, type Socket } from "node:net";
import { chmodSync, existsSync, rmSync } from "node:fs";
import { BrokerRefusal } from "./errors.js";
import { BrokerService } from "./service.js";
import {
  decodeAuditEvent,
  encodeFrame,
  FrameDecoder,
  validateRequest,
  type BrokerMethod,
  type BrokerResponse,
  type WireSignedAuditEvent,
} from "./protocol.js";
import type { SignedAuditEvent, AuthorizationResponse } from "@atlas/contracts";
import type { RefAdvanceRequest, SourceCaptureRequest } from "./refs.js";
import type { PrivilegedOpDescriptor } from "./authorize.js";

/** A running broker socket server. */
export interface BrokerServer {
  readonly socketPath: string;
  close(): Promise<void>;
}

/** Dispatch a VALIDATED request (params already conform to the method schema). */
async function dispatch(service: BrokerService, method: BrokerMethod, params: unknown): Promise<unknown> {
  switch (method) {
    case "appendAuditEvent":
      return service.appendAuditEvent(decodeAuditEvent(params as WireSignedAuditEvent) as SignedAuditEvent);
    case "advanceProtectedRef": {
      const p = params as RefAdvanceRequest & { auditEvent: WireSignedAuditEvent };
      return service.advanceProtectedRef({ ...p, auditEvent: decodeAuditEvent(p.auditEvent) as SignedAuditEvent });
    }
    case "integrateSourceCapture": {
      const p = params as SourceCaptureRequest & { auditEvent: WireSignedAuditEvent };
      return service.integrateSourceCapture({ ...p, auditEvent: decodeAuditEvent(p.auditEvent) as SignedAuditEvent });
    }
    case "mintChallenge":
      return service.mintChallenge(params as PrivilegedOpDescriptor);
    case "execAuthorized": {
      const p = params as { op: PrivilegedOpDescriptor; auth: AuthorizationResponse };
      return service.execAuthorized(p.op, p.auth);
    }
  }
}

function respond(id: number, err: unknown, result?: unknown): BrokerResponse {
  if (err === undefined) return { id, ok: true, result };
  if (err instanceof BrokerRefusal) return { id, ...err.toWire() };
  return {
    id,
    ok: false,
    code: "broker.internal",
    exitCode: 4,
    message: err instanceof Error ? err.message : String(err),
    detail: {},
  };
}

/**
 * Start the broker server bound to `socketPath`. The socket file is created
 * `0660` (D10; `atlas-broker:atlas-git` ownership is provisioning's job). A stale
 * socket file at the path is removed first.
 */
export async function startBrokerServer(
  service: BrokerService,
  socketPath: string,
): Promise<BrokerServer> {
  await service.start();

  if (existsSync(socketPath)) rmSync(socketPath, { force: true });

  const server: Server = createServer((socket: Socket) => {
    socket.setEncoding("utf8");
    const decoder = new FrameDecoder();
    let queue: Promise<void> = Promise.resolve();

    socket.on("data", (chunk: string) => {
      let frames: unknown[];
      try {
        frames = decoder.push(chunk);
      } catch {
        // Unparseable frame — cannot correlate an id, so drop the connection.
        socket.destroy();
        return;
      }
      for (const frame of frames) {
        // Validate the request against the discriminated IPC contract. An
        // uncorrelatable frame (no numeric id) is dropped; a correlatable but
        // malformed one gets a typed `broker.bad_request` for its id.
        const parse = validateRequest(frame);
        if (parse.kind === "fatal") {
          socket.destroy();
          return;
        }
        // Serialize response ordering per-connection; mutations are additionally
        // serialized SERVICE-WIDE by the BrokerService mutation lock.
        queue = queue.then(async () => {
          if (parse.kind === "bad") {
            const refusal = new BrokerRefusal("broker.bad_request", parse.message);
            socket.write(encodeFrame({ id: parse.id, ...refusal.toWire() }));
            return;
          }
          try {
            const result = await dispatch(service, parse.method, parse.params);
            socket.write(encodeFrame(respond(parse.id, undefined, result)));
          } catch (err) {
            socket.write(encodeFrame(respond(parse.id, err)));
          }
        });
      }
    });
    socket.on("error", () => socket.destroy());
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  try {
    chmodSync(socketPath, 0o660);
  } catch {
    // Best-effort: on platforms/paths where chmod is unavailable the provisioning
    // layer still owns the final mode; do not fail startup on this.
  }

  return {
    socketPath,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          if (existsSync(socketPath)) rmSync(socketPath, { force: true });
          resolve();
        });
      }),
  };
}
