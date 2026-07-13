/**
 * `probeSandbox()` (`sandbox-contract.md §2`) — the startup capability check `doctor`
 * surfaces. It is side-effect-free + fast (it inspects the availability of each
 * REQUIRED guarantee's primitive on this host — it does NOT launch a worker) and its
 * result is cached for the process lifetime.
 *
 * `supported` is `true` only when EVERY guarantee is available (all V1 guarantees are
 * required — `sandbox-contract.md §1` marks each `required: true`). An unsupported
 * host (or a missing required primitive) makes `runInSandbox` fail closed.
 */
import type { SandboxCapabilityReport } from "../types.js";
import { detectHost, type SandboxBackend } from "./backend.js";
import { darwinBackend } from "./darwin.js";
import { makeLinuxBackend } from "./linux.js";

/** Resolve the backend for this host, or `null` if the host is unsupported. */
export function selectBackend(): SandboxBackend | null {
  const { id } = detectHost();
  if (id === "darwin-arm64") return darwinBackend;
  if (id === "linux-x86_64" || id === "linux-arm64") return makeLinuxBackend();
  return null;
}

let cached: SandboxCapabilityReport | null = null;

/** Compute (uncached) the capability report for this host. */
function computeReport(): SandboxCapabilityReport {
  const host = detectHost();
  const backend = selectBackend();
  if (backend === null) {
    // Unsupported host (`sandbox-contract.md §3`): report every guarantee unavailable.
    return {
      host: host.label,
      supported: false,
      checks: [
        { guarantee: "no-network", available: false, primitive: "unsupported-host", detail: `no sandbox backend for ${host.label}` },
      ],
    };
  }
  const checks = backend.probe();
  const supported = checks.every((c) => c.available);
  return { host: host.label, supported, checks };
}

/**
 * The cached, process-lifetime capability report. `doctor` calls this; so does
 * `runInSandbox` (to fail closed before spawning). Pass `{ force: true }` to bypass
 * the cache (used by tests that mutate host detection).
 */
export async function probeSandbox(opts?: { readonly force?: boolean }): Promise<SandboxCapabilityReport> {
  if (opts?.force || cached === null) {
    cached = computeReport();
  }
  return cached;
}

/** Drop the cached report (tests only). */
export function resetSandboxProbeCache(): void {
  cached = null;
}
