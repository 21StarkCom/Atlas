/**
 * The host-agnostic sandbox backend seam. `launcher.ts` and `probes.ts` talk to a
 * {@link SandboxBackend}; `darwin.ts` and `linux.ts` implement one each. Selection
 * is by detected host (`sandbox-contract.md §3` supported-host matrix); an
 * unsupported host yields `null` and callers fail closed.
 */
import { arch, platform } from "node:os";
import type { SandboxCapabilityCheck, SandboxHostId, SandboxLimits } from "../types.js";
import type { WorkerRequest } from "./protocol.js";

/** An extra file the launcher must open and place at a fixed child fd before exec. */
export interface ExtraChildFd {
  /** The child fd number the file must appear at (e.g. 10 for bwrap `--seccomp 10`). */
  readonly childFd: number;
  /** Absolute path of the file to open read-only and map to {@link childFd}. */
  readonly path: string;
}

/** How the launcher wants the confined child spawned. */
export interface SandboxSpawnPlan {
  /** The absolute program to exec (the confinement wrapper, e.g. `sandbox-exec`). */
  readonly command: string;
  /** Its argv (which ends in `node <workerModule> <requestJson>`). */
  readonly args: string[];
  /**
   * Extra read-only fds the launcher must wire into the child at fixed numbers (the
   * Linux backend uses this to hand bwrap the seccomp blob on fd 10). These are the
   * ONLY inherited fds beyond stdio + the result pipe — the `no-inherited-fds`
   * guarantee is about UNEXPECTED fds, not these deliberately-wired ones.
   */
  readonly extraFds?: readonly ExtraChildFd[];
  /**
   * A cleanup thunk for any backend-owned scratch created for this spawn (e.g. a
   * generated Seatbelt profile file, a seccomp blob). Always invoked by the launcher
   * in its `finally`, so it runs even after a forced termination.
   */
  cleanup(): void;
}

/** Inputs a backend needs to build a {@link SandboxSpawnPlan}. */
export interface SandboxSpawnInputs {
  /** Realpath of the node binary that runs the worker (the ONLY exec the child may do). */
  readonly nodePath: string;
  /** Absolute path of the worker (or probe) module the child runs. */
  readonly workerModule: string;
  /** The request handed to the worker as argv JSON. */
  readonly request: WorkerRequest;
  /** Resource caps to translate into rlimits/cgroups. */
  readonly limits: SandboxLimits;
  /**
   * Directories whose DATA the child may read beyond the input handle — the worker's
   * JS import closure (the monorepo code + `node_modules`). Everything else (vault,
   * home, credentials) stays unreadable.
   */
  readonly codeRoots: readonly string[];
  /**
   * Extra directories whose DATA must be DENIED even if a broad allow would cover
   * them (the configured vault + any test-supplied out-of-scope root). Belt-and-
   * suspenders on top of the credential/home denials the backend always applies.
   */
  readonly denyReadRoots: readonly string[];
}

/** A backend for one host family. */
export interface SandboxBackend {
  readonly hostId: SandboxHostId;
  /**
   * Side-effect-free, fast availability probe of each REQUIRED guarantee's primitive
   * on this host (`sandbox-contract.md §2`). Returns one check per guarantee.
   */
  probe(): SandboxCapabilityCheck[];
  /** Build the confined spawn plan for one worker/probe launch. */
  buildSpawn(inputs: SandboxSpawnInputs): SandboxSpawnPlan;
}

/**
 * Detect the host token. Returns the supported {@link SandboxHostId}, or the raw
 * `platform-arch` string for an unsupported host (so `doctor`/reports can name it).
 */
export function detectHost(): { id: SandboxHostId | null; label: string } {
  const p = platform();
  const a = arch();
  if (p === "darwin" && a === "arm64") return { id: "darwin-arm64", label: "darwin-arm64" };
  if (p === "linux" && a === "x64") return { id: "linux-x86_64", label: "linux-x86_64" };
  if (p === "linux" && a === "arm64") return { id: "linux-arm64", label: "linux-arm64" };
  return { id: null, label: `${p}-${a}` };
}
