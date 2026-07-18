/**
 * `health/socket-errors` — the SINGLE authority for "is this an ordinary socket
 * transport failure?" (plan Phase 1 Task 3a). Both the anchor probe
 * (`audit/anchor-check.ts` `resolveAnchorProbe`) and the daemon probe
 * (`health/probe.ts` `probeDaemon`) consume this one predicate to decide socket
 * unreachability, so the broker-failure taxonomy has a single socket-code list
 * instead of two that can drift out of agreement.
 *
 * Operation-specific outcomes (the anchor probe's RPC timeout, a post-connect
 * `EPIPE`) are layered on top BY EACH CALLER — they are deliberately NOT baked in
 * here (the RPC timeout in particular is an anchor-probe concern, not a socket
 * fact).
 */

/**
 * The complete connect-failure code set the daemon socket layer can emit for an
 * unreachable/dead peer. `ETIMEDOUT` is the OS connect timeout (a socket-level
 * fact), distinct from the anchor probe's own RPC timeout layered by its caller.
 */
const TRANSPORT_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ENOENT",
  "EPIPE",
  "ECONNRESET",
  "EACCES",
  "ETIMEDOUT",
]);

/**
 * `true` iff `err` is a Node `SystemError` whose `code` is one of the connect-
 * failure codes above, unwrapping an `AggregateError` (Node may wrap connect
 * errors from multiple address attempts into one). Any non-transport error — an
 * arbitrary `Error`, a thrown string, a refusal — is `false`.
 */
export function isTransportError(err: unknown): boolean {
  if (err instanceof AggregateError) {
    return err.errors.some((e) => isTransportError(e));
  }
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === "string" && TRANSPORT_CODES.has(code);
  }
  return false;
}
