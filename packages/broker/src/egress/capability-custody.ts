/**
 * Custody resolution for the capability-MAC secret (#60 Phase 6, Task 6.2).
 *
 * The capability-MAC secret is a SHARED secret: the CLI reads it to MINT a
 * run-bound egress capability (D19), the egress daemon reads the SAME value to
 * VERIFY it. Two ends, one representation — so both resolve it here rather than
 * each reimplementing `readFileSync(process.env…)`. A half-migrated
 * representation silently breaks the drain, which is why this module is the sole
 * owner of "where does the secret come from".
 *
 * Two accepted forms:
 *
 * - **Custody path** — {@link CAPABILITY_KEY_ENV} names a file the launcher
 *   provisions readable by both identities (`0640`, group `atlas-git`). This is
 *   the daemon's and the interactive operator's form.
 * - **File descriptor** — {@link CAPABILITY_KEY_FD_ENV} names an already-open fd
 *   carrying the raw secret. This is the launchd sync wrapper's form: the secret
 *   is fetched from the Keychain at job start and handed to the drain on fd 3
 *   (`exec 3< <(printf '%s' "$key")` — a pipe, never a here-string, which bash
 *   backs with a temp FILE on macOS), so it is **never written to disk** and
 *   **never visible in the environment** (the env carries only the small integer
 *   `3`). It is command-scoped — it dies with the process it was passed to.
 *
 * **The fd read is memoized per process.** A pipe is a stream: it is drained by
 * the first read, and every later read returns EOF. But the mint path resolves the
 * secret on EVERY `mintEgressCapability` call, and one `brain jobs run --all`
 * drains many jobs in one process — so an un-memoized fd form would serve the
 * first minting job and hand every later one an empty secret (which
 * `requireNonEmpty` then throws on, failing the job as a transient `internal`
 * until it burns its whole attempt budget). Caching is exactly the fd form's
 * semantics: the descriptor is command-scoped and its payload is immutable for the
 * process lifetime. Only SUCCESSFUL reads are cached, so a failure stays
 * fail-closed and is re-attempted rather than remembered. The **path form is
 * deliberately NOT cached** — re-reading is what makes a rotation observable.
 *
 * The fd form WINS when both are present: it is the explicit, command-scoped
 * hand-off, and silently preferring a standing on-disk credential over the one
 * the caller just injected would be a surprising downgrade.
 *
 * **Fail-closed.** Absent, unreadable, or empty custody THROWS. There is no
 * credential-less fallback and no empty-secret mint — an empty MAC key would
 * produce capabilities the daemon happily verifies with the same empty key,
 * which is exactly the degraded success this design refuses. Failure messages
 * name the env vars and the fd number, never the secret bytes.
 */
import { readFileSync } from "node:fs";

/**
 * Env var naming the CLI-readable capability-MAC secret FILE (shared with the
 * egress broker; NOT the `atlas-egress`-only keys dir).
 */
export const CAPABILITY_KEY_ENV = "ATLAS_EGRESS_CAPABILITY_KEY";

/**
 * Env var naming an already-open FILE DESCRIPTOR carrying the raw capability-MAC
 * secret. Command-scoped: the launchd wrapper opens it for the drain only.
 */
export const CAPABILITY_KEY_FD_ENV = "ATLAS_EGRESS_CAPABILITY_KEY_FD";

/** The environment shape this resolver reads (injectable so tests never mutate `process.env`). */
export type CapabilityCustodyEnv = Record<string, string | undefined>;

/** An env value counts as "set" only when it is a non-empty string. */
function present(value: string | undefined): value is string {
  return value !== undefined && value.length > 0;
}

/**
 * Resolve the capability-MAC secret from custody (fd form, else path form).
 *
 * @param env - the environment to read; defaults to `process.env`.
 * @throws when neither form is set, the source cannot be read, or the secret is empty.
 */
export function resolveCapabilitySecret(env: CapabilityCustodyEnv = process.env): string {
  const fdRaw = env[CAPABILITY_KEY_FD_ENV];
  if (present(fdRaw)) return readFromFd(fdRaw);

  const path = env[CAPABILITY_KEY_ENV];
  if (present(path)) return readFromPath(path);

  throw new Error(
    `neither ${CAPABILITY_KEY_ENV} (custody path) nor ${CAPABILITY_KEY_FD_ENV} (file descriptor) is set — ` +
      `cannot resolve the capability mint secret from custody (pass an explicit { secret } in tests)`,
  );
}

/**
 * Successful fd reads, keyed by descriptor number. A pipe yields its payload once;
 * every mint after the first would otherwise see EOF. See the module header.
 */
const fdSecretCache = new Map<number, string>();

/** Reset the fd memo — tests only; production never re-uses a descriptor number. */
export function __resetCapabilityFdCache(): void {
  fdSecretCache.clear();
}

/** Read the secret from an already-open fd. Never falls back to the path form (fail closed). */
function readFromFd(fdRaw: string): string {
  // `Number` accepts "3.5"/" 3"/"0x3"; require a plain non-negative integer so a
  // malformed value fails loudly instead of reading some unrelated descriptor.
  if (!/^\d+$/.test(fdRaw)) {
    throw new Error(`${CAPABILITY_KEY_FD_ENV}=${fdRaw} is not a valid file descriptor (expected a non-negative integer)`);
  }
  const fd = Number(fdRaw);
  const cached = fdSecretCache.get(fd);
  if (cached !== undefined) return cached;
  let raw: string;
  try {
    // The fd is consumed whole; the caller (the wrapper) owns closing it.
    raw = readFileSync(fd, "utf8");
  } catch (err) {
    throw new Error(
      `cannot read the capability mint secret from ${CAPABILITY_KEY_FD_ENV}=${fdRaw}: ` +
        `file descriptor ${fdRaw} is not readable (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  // Only a SUCCESSFUL read is remembered — a throw stays fail-closed and retryable.
  const secret = requireNonEmpty(raw, `${CAPABILITY_KEY_FD_ENV}=${fdRaw}`);
  fdSecretCache.set(fd, secret);
  return secret;
}

/** Read the secret from the provisioned custody file. */
function readFromPath(path: string): string {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(
      `cannot read the capability mint secret from ${CAPABILITY_KEY_ENV}=${path}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return requireNonEmpty(raw, `${CAPABILITY_KEY_ENV}=${path}`);
}

/** Trim, then refuse an empty secret — an empty MAC key is a silent security downgrade. */
function requireNonEmpty(raw: string, source: string): string {
  const secret = raw.trim();
  if (secret.length === 0) {
    throw new Error(`the capability mint secret resolved from ${source} is empty — refusing to mint with an empty key`);
  }
  return secret;
}
