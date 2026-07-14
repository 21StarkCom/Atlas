/**
 * `EgressClient` — the low-level IPC client for the egress-broker socket (D10).
 *
 * It speaks the framed-JSON `invoke` protocol and returns a typed
 * {@link EgressInvokeResult} that ALWAYS carries a receipt for a run-attributable
 * transmission (success, refusal, or provider error) so the caller (`@atlas/models`)
 * can write the `model_calls` row for every call (D6/D18). A malformed/expired
 * capability yields a refusal with no receipt. `@atlas/models` wraps this with the
 * ergonomic `generateText`/`generateObject`/`embed` surface.
 */
import { connect, type Socket } from "node:net";
import { EgressRefusal, type EgressCode } from "./errors.js";
import { ProviderCallError, providerCallErrorFromBody } from "./provider-error.js";
import {
  encodeFrame,
  FrameDecoder,
  validateEgressResponse,
  type EgressInvokeParams,
} from "./protocol.js";
import { ModelCallReceiptSchema, type ModelCallReceipt } from "./types.js";

/** The typed result of an `invoke`: the outcome + the receipt (when produced). */
export type EgressInvokeResult =
  | { readonly ok: true; readonly result: unknown; readonly receipt: ModelCallReceipt }
  | { readonly ok: false; readonly refusal: EgressRefusal; readonly receipt?: ModelCallReceipt }
  | { readonly ok: false; readonly providerError: ProviderCallError; readonly receipt: ModelCallReceipt };

interface Pending {
  resolve(value: EgressInvokeResult): void;
  reject(err: unknown): void;
}

export class EgressClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly decoder = new FrameDecoder();

  private constructor(private readonly socket: Socket) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.onData(chunk));
    socket.on("close", () => this.failAll(new Error("egress connection closed")));
    socket.on("error", (err) => this.failAll(err));
  }

  /** Connect to the egress broker socket at `socketPath`. */
  static connect(socketPath: string): Promise<EgressClient> {
    return new Promise((resolve, reject) => {
      const socket = connect(socketPath);
      socket.once("connect", () => {
        socket.removeListener("error", reject);
        resolve(new EgressClient(socket));
      });
      socket.once("error", reject);
    });
  }

  private onData(chunk: string): void {
    let frames: unknown[];
    try {
      frames = this.decoder.push(chunk);
    } catch {
      return;
    }
    for (const frame of frames) {
      const res = validateEgressResponse(frame);
      if (res === null) continue;
      const p = this.pending.get(res.id);
      if (p === undefined) continue;
      this.pending.delete(res.id);
      if (res.ok) {
        const receipt = ModelCallReceiptSchema.safeParse(res.receipt);
        if (!receipt.success) {
          p.reject(new EgressRefusal("egress.bad_request", "malformed success receipt across the seam"));
          continue;
        }
        p.resolve({ ok: true, result: res.result, receipt: receipt.data });
      } else if (res.providerError) {
        const receipt = ModelCallReceiptSchema.safeParse(res.receipt);
        p.resolve({
          ok: false,
          providerError: providerCallErrorFromBody(res.providerErrorBody),
          ...(receipt.success ? { receipt: receipt.data } : {}),
        } as EgressInvokeResult);
      } else {
        const receipt = res.receipt !== undefined ? ModelCallReceiptSchema.safeParse(res.receipt) : undefined;
        p.resolve({
          ok: false,
          refusal: new EgressRefusal(res.code as EgressCode, res.message, res.detail),
          ...(receipt?.success ? { receipt: receipt.data } : {}),
        });
      }
    }
  }

  private failAll(err: unknown): void {
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }

  /**
   * Send one `invoke` and resolve to its typed outcome + receipt. If `signal` is
   * provided, an abort sends a `cancel` frame for this request id; the broker aborts
   * the in-flight `AbortController` and replies with a `cancelled` provider-error
   * receipt, which resolves this promise normally (so the receipt is still retained,
   * D6). An already-aborted signal sends the cancel immediately after the invoke.
   */
  invoke(params: EgressInvokeParams, signal?: AbortSignal): Promise<EgressInvokeResult> {
    const id = this.nextId++;
    return new Promise<EgressInvokeResult>((resolve, reject) => {
      let onAbort: (() => void) | undefined;
      const settle = <T>(fn: (v: T) => void) => (v: T): void => {
        if (signal !== undefined && onAbort !== undefined) signal.removeEventListener("abort", onAbort);
        fn(v);
      };
      this.pending.set(id, { resolve: settle(resolve), reject: settle(reject) });
      this.socket.write(encodeFrame({ id, method: "invoke", params }));
      if (signal !== undefined) {
        onAbort = (): void => {
          if (!this.pending.has(id)) return;
          this.socket.write(encodeFrame({ id, method: "cancel", params: { id } }));
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }

  /** Close the connection. */
  close(): void {
    this.socket.end();
  }
}
