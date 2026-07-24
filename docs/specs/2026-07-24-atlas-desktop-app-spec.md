# Atlas Desktop (`@atlas/desktop`) — v1 Minimum

## intent — Intent & Soundness

**Problem.** Atlas v2 is a single-process CLI: `brain <cmd>` opens the vault, mutates, commits, exits (ADR-0003). There is no daemon, no `brain serve`, no launchd service. The owner therefore has **no ambient way to know Atlas is usable** — "is my vault reachable, is git healthy, is the Gemini key present, is the index fresh, are migrations current?" is answerable only by remembering to type `brain status` in a terminal. Configuration (vault path, model names, API key) has no surface at all beyond hand-editing `brain.config.yaml` and running `security add-generic-password` by hand.

**Design.** A macOS Electron app at `apps/desktop` (package `@atlas/desktop`) that is **the only persistent Atlas-related process on the machine**. It hosts a thin, in-process **engine session** and is otherwise a *pure client* of the existing `brain` CLI. It delivers four capabilities:

1. **Running indicator** — a menubar glyph (green / amber / red) derived from the engine session state plus the checks `brain status --json` emits.
2. **Restart Atlas** — tear down and re-initialize the engine session; non-destructive.
3. **Configuration** — edit vault, model settings, and the Gemini credential.
4. **Launch at login** — an explicit toggle that registers/unregisters the app as a macOS login item, so the ambient indicator is present after every reboot without a manual launch.

**Why this solves it.** Because there is no daemon, "up and running" can only mean *readiness*: "if I invoke Atlas right now, will it work?" That predicate is **fully computed by `brain status`** (`vault-reachable`, `git-healthy`, `provider-key-present`, `index-not-stale`, `migrations-current`) plus one app-local fact (config loads). Polling that predicate on an interval and surfacing it in the menubar is a complete answer to the stated need — no new engine, no revived supervision machinery, and **no second readiness implementation** in the app.

**Engine-access doctrine (the load-bearing decision → propose ADR-0004).** This spec MUST be accompanied by a new `docs/adr/0004-persistent-desktop-surface-and-engine-access.md`:

- The app **never mutates** the vault, the SQLite projection, or git directly, and in v1 it **never reads them directly either** — `brain status` is the sole authority for Atlas-managed readiness.
- **Anything touching *Atlas-managed* state** — vault working tree, git history, projection, LanceDB — → **spawn the `brain` CLI**. Every such mutation continues to flow through `runMutation` (lock → `HEAD == refs/heads/main` → validate → ground → dirty-check → apply → one commit per ChangePlan → refresh LanceDB then SQLite → release). The app never re-implements that path.
- Net: **exactly one writer path survives** for Atlas-managed state (the CLI), and **exactly one reader path** for readiness (the CLI); git history remains the sole audit and undo.

**Trade-offs acknowledged.**
- *Rejected: revive a daemon / `brain serve`.* Would directly contradict ADR-0003 and reintroduce a supervised background process, OS identities, and a privilege surface the pivot deliberately demolished. Rejected outright.
- *Rejected: the app opens the projection DB read-write and writes notes itself.* Faster for some future features, but creates a second writer, defeating one-commit-per-ChangePlan and the git-only undo. Rejected outright.
- *Rejected: the app opens the projection DB read-only to probe readiness itself.* An earlier draft held a `better-sqlite3` read-only handle to `SELECT 1`. That duplicated the readiness authority (`brain status` already opens the store read-only), dragged in a native module with an Electron ABI-rebuild burden, and added a DB-handle lifecycle the four capabilities do not need. Rejected: the app is a pure `brain status` client. Projection-openability, if ever needed as a signal, is added as a **CLI-owned** status check, not an app-local probe.
- *Chosen: persistent GUI + `brain status`-only readiness + CLI-spawn for state.* Costs process-spawn latency per action (~hundreds of ms) and means the app cannot show anything the CLI does not expose. Accepted; both are cheap at this cadence and both are consistent with the doctrine.
- *Rejected for v1: grow the CLI surface with `brain config get/set`.* See `interfaces`.

**Assumptions (explicit).**
- The app ships inside the same monorepo build as `apps/cli`, so it can resolve the `brain` binary and `ATLAS_ROOT` deterministically from its own install layout (dev and packaged modes are both specified in `interfaces` §2).
- macOS-only. The Keychain and the menubar are both macOS-specific; ADR-0003's stated target is macOS.
- Single operator, single machine, one vault at a time.
- `brain status --json` and the exit-code set (`0/1/2/4/5`; `7` only from `jobs run`) are stable contracts owned by `apps/cli`.

**Unstated-dependency check.** The app depends on: `brain.config.yaml` + `AtlasConfigSchema`/`loadConfig` + the vault-pin canonicalization helper (`@atlas/cli`), the `brain` binary, the Keychain item `atlas-gemini-api-key` accessed only through `@atlas/models`' credential module (presence probe + write helper — see `ssot`), the `status` JSON schema at `docs/specs/cli-contract/status.schema.json`, and the `yaml` document library from the workspace `catalog:`. All exist today (the `@atlas/models` write helper is an additive export, see `ssot`); none is invented here. **The app depends on no SQLite driver** — `better-sqlite3` is not a desktop dependency.

**Success criteria (objective).** v1 is correctly implemented when, on the owner's Mac:
1. With a healthy vault, the menubar glyph is green with the check-mark symbol, and its accessible label reads `Atlas: healthy`.
2. Breaking any one check that maps to `red` (e.g. `mv` the vault, delete the Keychain item) flips the glyph to red **within one poll interval** after the next completed poll; breaking a check that maps to `amber` (e.g. let the index go stale) flips it to amber; each transition raises exactly one macOS notification.
3. `Restart Atlas` completes and refreshes the indicator, and `git status` in the vault plus the projection DB's `notes` row count (read via `brain status --json`) are **unchanged** before and after.
4. Configuration edits are correct when: (a) editing the vault path produces a `brain.config.yaml` that `loadConfig` accepts and flips `vault-reachable` within one poll interval; (b) editing either model name (`generation_model`, `embedding_model`) produces a config `loadConfig` accepts and a `brain` command loads without a `ConfigError` — there is **no** model-validity check, so no glyph transition is asserted for model edits; (c) setting the API key updates the Keychain item and flips `provider-key-present` within one poll interval; (d) editing `vault.note_globs` (add, edit, clear) produces a config `loadConfig` accepts, and clearing the list omits the key so the schema default applies.
5. The Gemini key value never appears in the UI, in app logs, or in any file the app writes — verified by grep of the app's log output and `brain.config.yaml` after a set/replace. (The key is briefly present in the `security` process's own argv during a write; that accepted playground-tier residual is documented in `security`.)
6. Toggling **Launch at login** registers/unregisters the macOS login item, the toggle renders the OS-observed value after the write, and after a logout/login the app starts and the glyph settles green.
7. `pnpm -r build`, `pnpm -r test`, and `node tools/gen-cli-contract.ts --check` stay green on both CI legs (`ubuntu-latest` and `macos-15`).

**Finalized vs open.** Finalized: the engine-access doctrine, the four capabilities, the state model, the pure-`brain status` readiness split, Keychain-only credentials owned by `@atlas/models`, the Keychain account value, the app-owned check-severity policy, and — settled in `open-questions` — no key-probe-on-save (rely on `provider-key-present`) and index-staleness as advisory amber only (no in-UI `index rebuild`). Genuinely open (all in `open-questions`, none blocking the plan): the live `POLL_TIMEOUT_MS` confirmation, the exact shape of the `@atlas/cli`/`@atlas/models` export extractions, concurrent-edit file-watching, the ADR-0004 wording, and hardening the credential write off argv.

## scope — Scope & Boundaries

**Tier: playground.** Single-user, single-machine, personal tooling on the owner's Mac. Absence of HA, multi-user auth, migration tooling, secret rotation, telemetry, code-signing/notarization ceremony, canary rollout, or 10x-scale capacity is **deliberate restraint**, not a gap. Adding any of those to v1 is out of scope.

**In scope for v1 — exactly four capabilities.**

| # | Capability | Contracted surface |
|---|---|---|
| 1 | Running indicator | Menubar glyph (3 states, shape+color), popover scoreboard of the CLI checks + last-checked time, interval poll (60 s default, tunable) + on-demand refresh, macOS notification on health transition |
| 2 | Restart Atlas | Tear down + re-initialize the engine session; non-destructive; refreshes the indicator |
| 3 | Configuration | Vault (`vault.path`, `vault.note_globs`), AI (`models.generation_model`, `models.embedding_model`), credential (set/replace the Keychain item; presence-only display) |
| 4 | Launch at login | A labeled toggle that registers/unregisters the macOS login item; renders the OS-observed state; failure semantics per the `app:setLoginItem` channel in `interfaces` §4 |

Plus the supporting scaffolding those four require: the `apps/desktop` workspace, the main/renderer split, the engine-session lifecycle, the CLI-spawn wrapper, and quit.

**Explicitly out of scope for v1 (named, not built).** Nothing below is implemented, reserved, or structurally anticipated — no UI slot, no module seam, no IPC channel, no schema:

- **Usage-metrics dashboard.**
- **Ask-a-question pane** (retrieval / synthesis UI).
- **Drag-and-drop / clipboard ingest.** v1 adds **no** ingest path, so it does not widen ADR-0003's accepted unsandboxed-ingest risk.
- **Embedded MCP host.**
- **Any direct read of Atlas-managed state** — no projection DB handle, no direct git queries. Readiness comes only from `brain status`.

**Also out of scope:** auto-update, crash reporting, multi-vault switching, running `sync` / `index rebuild` / any other mutating command from the UI (v1 spawns `brain status` only), Windows/Linux support, and app notarization/distribution beyond a locally-built `.app`.

**Anti-inflation notes.** The app introduces **no** new abstraction layer over the CLI beyond a single typed spawn wrapper. There is no plugin system, no generic "command runner" framework, no state-management library mandated, no IPC schema registry, and **no SQLite driver**. The status poll is a plain interval — no scheduler, no job queue. There is no offline cache of status; a failed poll is a failed poll.

**Constraint vs preference.** Hard constraints: macOS-only; no new writer path; no direct read of Atlas-managed state; no revived fortress machinery; Keychain-only for the secret, mediated by `@atlas/models`; CI matrix stays green; `version 0.0.0` / `private: true`; deps via `catalog:` only. Preferences (not gates): the poll interval's 60 s default value, the specific glyph symbols, and the popover layout.

## interfaces — Interfaces & Contracts

The app introduces **no network API and no new CLI commands**. Its interfaces are: (a) the workspace/package surface, (b) the consumed `brain status --json` contract, (c) the consumed config schema, (d) the internal main↔renderer IPC surface, (e) the credential module it consumes from `@atlas/models`, (f) the macOS login-item API. It holds **no projection DB handle and issues no direct git query.**

### 1. Workspace / package

```
apps/desktop/
  package.json          # name @atlas/desktop, version 0.0.0, private true
  tsconfig.json         # extends ../../tsconfig.base.json
  CLAUDE.md             # directory constitution (required by house rules)
  src/main/             # Electron main process
  src/renderer/         # popover + config window (semantic HTML)
  src/shared/           # types shared main↔renderer (no Node/Electron imports)
```

- Added to `pnpm-workspace.yaml` via the existing `apps/*` glob — no workspace-list edit needed.
- All new deps (`electron`, and the `yaml` document library if not already cataloged) are pinned **once** in the root `catalog:` and referenced as `"electron": "catalog:"`.
- Depends on `@atlas/cli` (workspace) for `AtlasConfigSchema` / `loadConfig` / the config-path resolution / the vault-pin canonicalization helper, on `@atlas/models` for the credential module (presence probe + write helper + service identifier), and on `@atlas/contracts` if shared DTOs are needed. It does **not** depend on `@atlas/sqlite-store` at all.

### 2. Consumed: `brain status --json`

The **owner of this contract is `apps/cli`**, schema at `docs/specs/cli-contract/status.schema.json`. This spec does **not** restate the field list as a second authority. The app:

- Invokes `brain status --json` (argv exactly `["status", "--json"]`).
- Parses stdout as JSON and validates it against the shape the CLI schema declares; a parse/shape failure is treated as `red` with reason `status-unparseable` (see `behavior`).
- Consumes the `checks[]` entries the CLI emits. As of this writing the CLI emits **five**: `vault-reachable`, `git-healthy`, `provider-key-present`, `index-not-stale`, `migrations-current`. Each entry is `{ name: string, ok: boolean, detail: string | null }` — a **binary** result, not a tri-state. **The app invents no new checks and re-runs none of them.** It derives a display/health severity from each `ok` via the app-owned policy in `ssot` (the CLI is the authority on *whether* a check passed; the app owns only *how bad a failure is* for the glyph). If the CLI adds or removes a check, the app renders whatever `checks[]` contains generically and folds each into health by the same policy (unknown check names default to `fail`/red so a new failing check is never silently ignored).
- Interprets the process exit code per the CLI's `EXIT` set (`apps/cli/src/errors/envelope.ts` is the owner):

  | exit | app interpretation |
  |---|---|
  | `0` | status obtained; health from `checks[]` via the severity policy |
  | `1` | validation → `red`, surface the envelope `message` |
  | `2` | vault/config unresolvable → `red`, surface the envelope `message`. **`status` is lock-free** (it opens the store read-only and never takes the vault mutation lock), so exit 2 here means only a bad config or unreachable vault — never a held-lock case |
  | `4` | internal → `red`, surface `message`; if the envelope carries `retryable: true` + `retryAfterMs`, the next **auto**-poll is scheduled at `max(retryAfterMs, pollInterval)` (see `behavior` → Polling for how on-demand refresh relates to this) |
  | `5` | usage → `red`, reason `app-cli-mismatch` (the app built the wrong argv — a bug, surfaced as such) |
  | other / spawn failure / timeout | `red`, reason `cli-unreachable` |

  Exit `7` is not expected (only `jobs run` emits it); if seen, treat as `4`.

**`brain` binary + `ATLAS_ROOT` resolution (both modes specified).**
- **Dev (`pnpm dev`):** the app resolves the sibling `apps/cli` build (`dist/bin.js`) and sets `ATLAS_ROOT` to the repo root (walking up for `docs/specs/cli-contract/commands.json`).
- **Packaged `.app`:** the app **bundles** the built `apps/cli` `dist/` tree **and** the `docs/specs/cli-contract/` tree into its `Resources`, spawns the bundled `dist/bin.js`, and sets `ATLAS_ROOT` to the bundled resource path. The `.app` is therefore self-contained and does not depend on a repo checkout on disk.
- **User-visible failure when resources are absent:** if neither the bundled nor the dev `brain` entrypoint resolves, or `ATLAS_ROOT` has no `commands.json`, the session is `broken` with reason `cli-unreachable` and a hint ("the bundled Atlas CLI could not be found — reinstall the app"). The binary path is resolved from the app's own layout, never from `PATH`.

### 3. Consumed: config schema and file

- **Owner: `@atlas/cli`** — `AtlasConfigSchema` (zod, `.strict()`) + `loadConfig`, and `brain.config.yaml` is the single owner of every path/threshold. The app **imports** these; it does not restate defaults. Because the schema is `.strict()`, a config file carrying keys unknown to the schema does **not** validate — it lands in the `invalid` branch below; "unmanaged keys" therefore means **other schema-defined keys the app does not edit** (e.g. `retrieval`, `logging`, `sensitivity`), never arbitrary unknown keys.
- `DEFAULT_VAULT_PATH` (`~/Code/Vaults/main-vault`) and the model defaults (`gemini-3.5-flash`, `gemini-embedding-001`) are read from the schema/loader defaults, **never hardcoded in the app**.
- The app edits exactly these keys and no others:

  | Key | Type | Required | Notes |
  |---|---|---|---|
  | `vault.path` | string (absolute or `~`-prefixed path) | required | Subject to `ATLAS_EXPECT_VAULT` (below) |
  | `vault.note_globs` | string[] | optional | Edited as a list; empty list ⇒ omit the key rather than write `[]`, so the schema default applies |
  | `models.generation_model` | string | optional | Free text; validated only by the schema |
  | `models.embedding_model` | string | optional | Free text; validated only by the schema |

- **Writes edit the parsed YAML document in place, then validate.** The write path is: read the file → parse it into a YAML **document** (a `yaml`-library `Document`/CST, not a plain object) → set only the managed scalar/sequence nodes on that document → **materialize a plain object from the edited document and parse it with `AtlasConfigSchema`** → only if it parses, `stringify` the edited document and write atomically (temp file in the same directory, `fsync`, `rename`). Because managed nodes are edited on the document, every untouched node — including **comments, key ordering, and every unmanaged (other-schema) key** — is preserved through the round-trip. "Verbatim" in this spec means exactly that CST-level preservation of untouched content. A parse failure means **nothing is written**; the form shows the zod issue path + message.
- **Idempotency / no-op:** if the re-stringified document is **byte-identical** to the file just read, the write is a no-op — nothing is written and the result is `changed: false`. Repeated identical saves are therefore no-ops and leave mtime unchanged.
- **File-access failure on the write path.** If the pre-write read of the existing file fails for any reason other than "not found" — `EACCES`, `EPERM`, `EISDIR`, `ELOOP`, `EIO`, or an unclassified error — the write is **refused** and `config:write` returns `ok: false, reason: 'config-unreadable'` with the OS error line as `message`. Nothing is written, and the app never falls back to writing a file composed only from the form's fields (which would silently drop the unmanaged keys it could not read).
- **`ATLAS_EXPECT_VAULT`**: if that env pin is set in the app's environment, `loadConfig` fail-closed-rejects a config whose `vault.path` canonicalizes elsewhere. The app therefore **pre-checks** the pin before offering to save, using the **same canonicalization helper the CLI's pin enforcement uses** (see `ssot`): if the candidate path canonicalizes away from the pin, the vault field is rejected in-form with the pin's value named, and no write is attempted. The pin is displayed read-only in the config window when set.

### 4. Internal IPC (main ↔ renderer)

A small, closed, typed channel set defined in `src/shared/ipc.ts`. All handlers are `ipcMain.handle`/`invoke` (request/response) except the one push channel. Renderer runs with `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`; the preload exposes only these:

| Channel | Direction | Request | Response |
|---|---|---|---|
| `session:get` | invoke | — | `SessionSnapshot` |
| `session:refresh` | invoke | — | `SessionSnapshot` (forces an immediate poll) |
| `session:restart` | invoke | — | `SessionSnapshot` (after re-init) |
| `session:changed` | push (main→renderer) | `SessionSnapshot` | — |
| `config:read` | invoke | — | `ConfigView` |
| `config:create` | invoke | — | `ConfigWriteResult` |
| `config:write` | invoke | `ConfigEdit` | `ConfigWriteResult` |
| `config:revealInFinder` | invoke | — | `OpResult` |
| `credential:status` | invoke | — | `CredentialStatus` |
| `credential:set` | invoke | `{ value: string }` | `OpResult` |
| `app:getLoginItem` | invoke | — | `LoginItemStatus` |
| `app:setLoginItem` | invoke | `{ enabled: boolean }` | `LoginItemResult` |
| `app:quit` | invoke | — | `OpResult` |

**Runtime request validation + consistent error semantics.** Every channel handler runs behind a single shared invocation wrapper in the preload/main boundary. The wrapper **runtime-validates each request payload** (TypeScript types do not protect Electron IPC at runtime) before dispatch: a payload that fails its declared shape (e.g. `enabled` not a boolean, `credential.value` not a string) is **never** dispatched to the OS/spawn/file path — the wrapper short-circuits, and so does any handler/transport rejection, so **no expected call ever rejects** at the renderer. The error result is **not** a bare `OpResult`: each channel has an **error factory** that returns a value of *that channel's declared response shape* with `reason: 'app-internal'` and every required field populated at a **type-valid zero value** — a validation-short-circuited `config:write` returns a full `ConfigWriteResult` (`ok:false, changed:false, issues:[]`), and a validation-short-circuited `app:setLoginItem` returns a full `LoginItemResult` (`ok:false, readable:false, enabled:false`). The zero value is deliberate here: a malformed request has **no** valid requested boolean to echo, so `enabled` is `false` (type-valid), never a copied non-boolean. (The *requested-value-flagged-unverified* rule applies only to the distinct post-parse failure where a valid request's read-back throws — that path is the channel's own `login-item-readback-failed` semantics below, not this validation short-circuit.) The `OpResult` triple (`reason`/`message`/`hint`) is the **common subset** every such error carries, which the UI envelope in §6 renders uniformly; the richer per-channel fields are always present and type-valid so the runtime shape never breaks. Read channels (`session:*`, `config:read`, `credential:status`) never reject by construction, so they need no error factory. (Truly unexpected crashes still propagate as rejections, logged.)

**`config:read` never rejects either.** It is a read channel, but every failure mode of reading a file on disk is modelled as a `ConfigState` branch rather than a thrown error, so the form always has a branch to render.

Shared types (`src/shared/types.ts`):

```ts
type Health = 'healthy' | 'degraded' | 'broken';
type CheckSeverity = 'pass' | 'warn' | 'fail';   // app-derived from the CLI's boolean `ok`

// One row of the CLI's checks[], plus the severity the app assigns it (ssot: CHECK_SEVERITY).
interface CheckView {
  name: string;            // e.g. 'vault-reachable' — from the CLI, not enumerated here
  ok: boolean;             // the CLI's authoritative pass/fail — verbatim from status --json
  detail: string | null;  // human-readable, from the CLI
  severity: CheckSeverity; // app-derived: 'pass' when ok; else 'warn' | 'fail' per CHECK_SEVERITY
}

interface SessionSnapshot {
  health: Health;
  reason: string;          // stable slug, e.g. 'ok' | 'check-warn:index-not-stale' | 'cli-unreachable'
  message: string;         // one-line human sentence; also the accessible label body
  checks: CheckView[];     // [] when the CLI could not be reached
  configLoaded: boolean;
  lastCheckedAt: string;   // ISO 8601, or the empty string before the first poll
  polling: boolean;        // true while a poll is in flight
  configGeneration: number; // the session generation this snapshot belongs to (ssot)
}

// The shared shape every mutating channel returns.
interface OpResult {
  ok: boolean;
  reason: string;          // 'ok' on success; otherwise a stable slug
  message: string;         // one line, human-readable
  hint?: string;           // remediation, when one exists
}

// The config file's state, as a discriminated union — the form renders one branch per state.
// These five branches are total: `config:read` returns exactly one of them for every
// possible on-disk condition, and never rejects.
type ConfigState =
  | { kind: 'loaded'; values: ConfigValues }
  | { kind: 'missing' }                                    // ENOENT — no brain.config.yaml at `path`
  | { kind: 'unreadable'; errno: string; error: string }    // exists but could not be read (see below)
  | { kind: 'unparseable'; error: string }                 // read, but YAML parse failed — raw parser message
  | { kind: 'invalid'; values: PartialConfigValues; issues: ConfigIssue[] };
       // parses as YAML but fails AtlasConfigSchema; `values` holds the readable managed fields,
       // `issues` explains every field that is present-but-wrong

// Every managed field resolved — a config that passed AtlasConfigSchema. Optional-in-schema
// fields (note_globs, both model names) are surfaced with their effective (default-applied) value
// plus a flag saying whether the file set them, so the form never fabricates an unmarked default.
interface ConfigValues {
  vaultPath: string;
  noteGlobs: string[];        setInFile: { noteGlobs: boolean; generationModel: boolean; embeddingModel: boolean };
  generationModel: string;
  embeddingModel: string;
}

// The `invalid` branch's best-effort subset. A managed key appears here ONLY when the parsed YAML
// held a value of the correct primitive type at that path; anything else is omitted rather than
// coerced or defaulted.
interface PartialConfigValues {
  vaultPath?: string;
  noteGlobs?: string[];
  generationModel?: string;
  embeddingModel?: string;
}

interface ConfigIssue { path: string; message: string }

interface ConfigView {
  path: string;                    // resolved brain.config.yaml path (present in every state)
  state: ConfigState;
  expectVaultPin: string | null;   // ATLAS_EXPECT_VAULT, or null when unset
  credential: CredentialStatus;
  // Schema-derived defaults + the create-candidate (vault.path seeded from the pin when set),
  // computed by main from AtlasConfigSchema. The renderer displays these for absent-optional
  // fields (in `invalid`) and for the `missing` branch WITHOUT ever duplicating a default of its
  // own — so the SSOT "read defaults from the schema, never restate them" rule holds in the UI too.
  defaults: ConfigValues;
  createCandidate: ConfigValues;
}

// Presence plus its provenance, so the form can distinguish "not set" from "could not be checked".
interface CredentialStatus {
  present: boolean;
  source: 'env' | 'keychain' | 'none' | 'unknown';
  // 'env'      ⇒ ATLAS_GEMINI_API_KEY overrides the Keychain
  // 'keychain' ⇒ present in the Keychain
  // 'none'     ⇒ probe succeeded and the item is definitively absent (item-not-found)
  // 'unknown'  ⇒ the probe itself failed (spawn error, locked/denied Keychain, nonzero that is
  //              not item-not-found); presence is UNKNOWN, not "absent". present is false here,
  //              but the UI must render "presence unknown", never "not set".
}

// Read back from macOS on every call — the OS is the owner of this setting (see `ssot`).
interface LoginItemStatus {
  enabled: boolean;        // app.getLoginItemSettings().openAtLogin
  readable: boolean;       // false when the OS query itself failed
}

interface LoginItemResult extends OpResult {
  readable: boolean;       // false when the post-write read-back query itself threw
  enabled: boolean;        // the state observed by re-reading the OS; when readable=false this
                           // carries the requested value flagged unverified, and the UI shows "unknown"
}

interface ConfigEdit {                       // every field optional; omitted = unchanged
  vaultPath?: string;
  noteGlobs?: string[];
  generationModel?: string;
  embeddingModel?: string;
}

interface ConfigWriteResult extends OpResult {
  changed: boolean;                          // false when the save was a no-op (byte-identical)
  issues: ConfigIssue[];                     // zod issue paths on failure; [] on success
}
```

**Invalid-state rendering rule (absent-optional vs present-but-wrong).** A managed field that is **present in the file but the wrong type** appears in neither `PartialConfigValues` (it is omitted) and **does** carry a matching `issues[]` entry — the form renders it as an empty control marked invalid. A field that is **optional in the schema and simply absent** produces **no** zod issue (the schema defaults it), so it has no `issues[]` entry; the form renders it with its **schema default (read from `ConfigView.defaults`, which main computes from the schema — the renderer holds no defaults of its own), visibly marked "using default (not set in file)"** — never as an unmarked value the owner might read as their own. `vault.path` is required, so its absence is always an `issues[]` entry. This makes the invariant precise: *every present-but-wrong field has an issue; every absent optional field is default-marked; the required field always has an issue when missing.* Saving from `invalid` is still a full schema-validated round-trip: it either produces a file `AtlasConfigSchema` accepts, or writes nothing.

**`config:read` state derivation — the total mapping from disk condition to branch:**

| Disk condition | Branch |
|---|---|
| File read and parsed, `AtlasConfigSchema` accepts it | `loaded` |
| `ENOENT` at `path` | `missing` |
| Read failed with `EACCES`, `EPERM`, `EISDIR`, `ELOOP`, `EIO`, or any other errno | `unreadable` (`errno` carries the code, or `'UNKNOWN'` when the error has none; `error` carries the OS message line) |
| Read succeeded, YAML parse threw | `unparseable` |
| Read + YAML parse succeeded, schema rejected it | `invalid` |

The `unreadable` branch is **read-only in the form** — the same posture as `unparseable`: the app will not overwrite a file whose current contents it could not read, because doing so would silently drop unmanaged keys. Its only actions are Reveal in Finder and retry (`config:read` again).

Channel semantics for the operations the UI requires:

- **`config:create`** — writes a new `brain.config.yaml` at `ConfigView.path`. Valid **only** when the current state is `missing`. It constructs a candidate from schema defaults **except** that when `ATLAS_EXPECT_VAULT` is set it seeds `vault.path` from the pin (not `DEFAULT_VAULT_PATH`), then runs the **same shared pin pre-check** `config:write` uses before writing. If the pin is set and the candidate still canonicalizes away from it (it cannot, since it is seeded from the pin, but the check is applied unconditionally for a single code path), it returns `ok: false, reason: 'pin-conflict'` and writes nothing — so a pre-check pass followed by a loader rejection remains impossible. Called in `loaded` / `unparseable` / `invalid` it returns `ok: false, reason: 'config-exists'`; called in `unreadable` it returns `ok: false, reason: 'config-unreadable'`. It is invoked only from the explicit "Create config" action, and because IPC is in-process request/response (no lost responses to retry), `config-exists` on a subsequent call unambiguously means a real pre-existing file, not a lost success. Success ⇒ `ok: true, changed: true`, followed by the same immediate Restart a `config:write` triggers.
- **`config:revealInFinder`** — opens the containing directory with the file selected (Electron `shell.showItemInFolder`). Valid in every state including `missing` and `unreadable` (in which case it reveals the directory). Returns `ok: false, reason: 'reveal-failed'` with the OS message when the path cannot be shown.
- **`app:getLoginItem`** — returns the current OS setting, read fresh via `app.getLoginItemSettings()` on every call; the app persists no copy. If the OS query throws, it returns `{ enabled: false, readable: false }` — never a guessed `true` — and the toggle renders in an explicit "unknown" state rather than silently claiming "off".
- **`app:setLoginItem`** — calls `app.setLoginItemSettings({ openAtLogin: enabled })`, then **re-reads** the OS setting and returns what the OS actually reports. Failure semantics match every other mutating channel: it never rejects on an expected failure. It returns `ok: false, reason: 'login-item-write-failed'` (carrying the OS error) when the write itself throws; `ok: false, reason: 'login-item-unverified'` when the write succeeded but the read-back disagrees with the requested value (e.g. blocked by a system policy), with `readable: true` and `enabled` = the observed state; and `ok: false, reason: 'login-item-readback-failed'`, `readable: false` when the **read-back query itself throws** — in which case the write may well have landed but the app cannot confirm it, so `enabled` carries the requested value flagged unverified and the UI renders the same "unknown" state as `app:getLoginItem`'s `readable:false`. Idempotent: setting the value it already has returns `ok: true` and performs no observable change.
- **`app:quit`** — runs the shutdown sequence in `behavior` (cancel any in-flight poll, clear the interval) and then terminates the app. It returns `OpResult` for symmetry and to surface a pre-quit failure; on the success path the renderer will normally never observe the response because the process exits. A teardown step that throws is logged and does **not** block termination — quit always terminates; it returns `ok: false, reason: 'quit-teardown-failed'` only in the case where it can still respond.

`credential:set` **has no getter that returns a value.** There is deliberately no channel that can return the secret; `credential:status` returns `CredentialStatus` — presence + provenance, never the value.

### 5. Credential module (consumed from `@atlas/models`)

The credential lives behind **one owner** — the `@atlas/models` credential module, the same package that resolves the key for `brain` and backs the `provider-key-present` check. That module owns the **service identifier**, the **presence probe**, and the **write helper**; the desktop app imports all three and re-literals none of them (see `ssot`).

- **Presence probe** — `@atlas/models` exposes a presence-only probe returning `CredentialStatus`. `ATLAS_GEMINI_API_KEY` in the environment ⇒ `{ present: true, source: 'env' }` (and the config window states the env override is in effect and that a set/replace will not take effect while it is set). Otherwise it probes the Keychain by **service only** (`security find-generic-password -s <service>`, **no `-w`** so the secret is never printed, **no `-a`** so the probe cannot over-constrain on account): item found ⇒ `{ present: true, source: 'keychain' }`; a definitive item-not-found ⇒ `{ present: false, source: 'none' }`; **any other probe failure** (spawn error, locked/denied Keychain, nonzero that is not item-not-found) ⇒ `{ present: false, source: 'unknown' }`, never a thrown error and never a false "not set".
- **Set/replace** — `@atlas/models` exposes a write-only `setGeminiApiKey(value)` helper. It rejects an empty or whitespace-only `value` up front (the desktop channel returns `ok: false, reason: 'empty-key'`, nothing spawned). Otherwise it runs `security add-generic-password -U -s <service> -a <account> -w <value>` with `shell: false` and an explicit argv array. A nonzero `security` exit ⇒ `OpResult { ok: false, reason: 'keychain-write-failed', message: <security stderr, one line> }`.
  - **Why `-w <value>` and not stdin (an accepted residual).** `security add-generic-password` has **no** stdin path for the password: with `-w` and no argument it prompts on the controlling TTY (and demands a retype), so a piped value does not work. The only non-interactive path is `-w <value>` in argv. The secret is therefore briefly visible in the `security` process's own argv, readable by **same-user** processes for the duration of one `exec`. At playground tier (single operator, single machine, ADR-0003's trust model) this is an **accepted residual risk**, documented in `security`. It is the one place the key touches argv; it never touches app state, disk, logs, or an IPC response. (Hardening to a native Keychain binding that avoids argv entirely is noted in `open-questions`.)
- **The `-a` account value is settled: the current login user.** Resolved at runtime from Node's `os.userInfo().username` — **never hardcoded**. On the target machine that resolves to `aryeh`, which matches the account on the **existing live Keychain item** (service `<service>`, account `aryeh`), so `-U` **updates that same item** rather than creating a duplicate; deriving it from the login user generalizes to any machine.
  - **SSOT:** a single `KEYCHAIN_ACCOUNT` constant in the `@atlas/models` credential module, initialized once from `os.userInfo().username`. No other module derives an account value, and the literal `aryeh` appears nowhere in the code.
  - Because **lookup is by service only**, the account participates in **no** read path — both the CLI's key resolution and the presence probe ignore it. It exists solely so `-U` targets one stable item.
  - Edge case: if `os.userInfo()` throws (a userless execution context), `setGeminiApiKey` returns `ok: false, reason: 'keychain-account-unresolved'` and writes nothing, rather than guessing an account.
- The app **never** reads the secret value back, never renders it, never logs it, never places it in an IPC response.

### 6. Errors surfaced to the user

Every failure the app shows uses one envelope shape in the UI: a **reason slug**, a **one-line human message**, and where applicable a **remediation hint** (e.g. "vault not found at `<path>` — open Configuration to fix the vault path"). This is exactly the `OpResult` triple, so mutating-channel failures render without translation. CLI-originated failures reuse the CLI's own envelope `message` verbatim rather than paraphrasing it.

## behavior — Behavior & Correctness

### The state boundary (what "anything touching state" means)

The engine-access doctrine's "spawn `brain` for anything touching state" governs **Atlas-managed state**: the vault working tree, git history, the SQLite projection, and the LanceDB index. Those four are `runMutation`'s domain, and the app writes **none** of them and **reads none of them directly** — the only `brain` invocation v1 makes is the read command `status --json`.

`brain.config.yaml` is **not** Atlas-managed state. It is the *input* that tells `brain` which vault and models to use — read at process start by `loadConfig`, not a projection of anything, not covered by a ChangePlan, not part of the commit-per-mutation audit trail. Editing it produces no note, no commit, and nothing for `git revert` to undo. Consequently `config:create` / `config:write` are **not** a second writer of Atlas state and do not bypass `runMutation`; there is nothing in that path for them to bypass.

The boundary, stated once:

| State | Owner / writer | How the app touches it |
|---|---|---|
| Vault working tree, git history, projection contents, LanceDB | `brain` via `runMutation` — the sole writer; `brain status` — the sole reader for readiness | Never writes. Never reads directly. Reads readiness only through `brain status --json` |
| `brain.config.yaml` | The file itself, shape owned by `AtlasConfigSchema` | Writes directly, schema-validated and atomic (`interfaces` §3) |
| The Gemini credential | macOS Keychain, mediated by `@atlas/models` | Presence-probed; set/replaced via the `@atlas/models` write helper |
| Launch-at-login | macOS | Read back from the OS; no local copy |

The app's config write is safe without the mutation order because it takes no vault lock, needs no grounding, and cannot leave a derived store stale — it is a whole-file atomic replace validated by the same schema `brain` will validate it with on next launch. Its only concurrency exposure is another editor of the same file, addressed under *Configuration* below. **If v1 ever needed to change Atlas-managed state, it would spawn `brain` — no exception exists for that class, and none is granted here.**

### The engine session

"Atlas," as the app manages it, is an **engine session**: the supervised in-process runtime holding

(a) the loaded, validated `brain.config.yaml` and its **fingerprint** (the mtime+hash used to detect drift); (b) the resolved-key **presence** state (never the value); (c) the validated vault; (d) the status poller; (e) a monotonic **session generation counter**.

**Initialization sequence** (also the Restart sequence):

1. Cancel any in-flight poll (see *Poll cancellation* below) and clear the interval timer; increment the generation counter.
2. `loadConfig()` — on `ConfigError`, session is `broken`, reason `config-invalid`, message = the error's file+key text, and the config fingerprint is captured as best-effort. **Stop here**; steps 3–4 are skipped and the config window is offered as the remediation.
3. Resolve key **presence** via the `@atlas/models` probe (env, else Keychain). A probe failure records `source: 'unknown'` (never fatal).
4. Run one immediate `brain status --json` poll, then arm the interval timer at `POLL_INTERVAL_MS`.

There is **no** projection-DB step — the app opens no DB handle.

**Health derivation** — one function, one owner (`src/main/health.ts`), fed the CLI's `checks[]` and the app-owned `CHECK_SEVERITY` policy:

| Condition (first match wins) | Health | Reason |
|---|---|---|
| `configLoaded == false` | `broken` | `config-invalid` |
| CLI unreachable / spawn failure / timeout / unparseable output | `broken` | `cli-unreachable` \| `status-unparseable` |
| CLI exit ∈ {1, 2, 4, 5} | `broken` | from the envelope |
| any check with `ok == false` whose severity is `fail` | `broken` | `check-failed:<name>` |
| any check with `ok == false` whose severity is `warn` | `degraded` | `check-warn:<name>` (e.g. `check-warn:index-not-stale`) |
| otherwise (every check `ok`) | `healthy` | `ok` |

`CHECK_SEVERITY` (owned in `ssot`) maps `vault-reachable`, `git-healthy`, `provider-key-present` → `fail` (a red readiness break) and `index-not-stale`, `migrations-current` → `warn` (advisory amber: `brain index rebuild` / `brain db migrate` fix them, and neither blocks a read). Unknown check names default to `fail`. Health maps to the glyph as green = `healthy`, amber = `degraded`, red = `broken`.

### Config-generation coherence

Every snapshot is stamped with the session's `configGeneration`. Because the owner's editor is an accepted second writer of `brain.config.yaml`, the file can change under a running session. To prevent a snapshot built from a config the app no longer reflects, **before each poll the app compares the on-disk config fingerprint to the session's loaded fingerprint**; if it changed, the app **Restarts the session** (reload config, re-probe key presence, re-arm) instead of polling against a stale in-memory config. A poll already in flight when the fingerprint change is detected is superseded per *Poll cancellation*, so its result cannot land on the new generation.

### Polling

**The interval rule, stated once.** The poller runs on a single configurable interval whose **default is 60 s**, held as `POLL_INTERVAL_MS` in `src/main/constants.ts` (the SSOT) and explicitly tunable. The interval value is a **default, not a gate** — nothing in this spec depends on its magnitude.

**The detection guarantee is stated relative to the interval, never as an absolute wall-clock**: *a check that breaks is reflected in the snapshot within one poll interval — specifically, at the next completed poll.* Every other statement in this spec (success criteria, live-drive steps, acceptance criteria) is expressed in those terms; **no line asserts a hard ≤ 60 s bound**, because a slow-but-successful poll, an honored `retryAfterMs` backoff, or a tuned interval all legitimately move the wall-clock.

**`nextEligiblePollAt` — one backoff rule.** The exit-4 `retryAfterMs` hint sets `nextEligiblePollAt = now + max(retryAfterMs, POLL_INTERVAL_MS)`. This gate applies to **automatic** polls only — the interval tick and the wake-from-sleep poll wait until `nextEligiblePollAt`. **User-initiated on-demand refreshes** (popover open, an explicit refresh, and the immediate poll after Restart / config write / credential set) **bypass** the backoff: they express deliberate operator intent and must feel responsive. The current snapshot stays `broken` until the refresh completes; the backoff only governs the automatic cadence, so the app never *loops* against a backing-off CLI, while a human who clicks refresh is never told "wait."

- On-demand refresh fires on: menubar/popover open, immediately after a Restart, immediately after a successful config write or credential set, and on wake from sleep (the wake poll additionally respects `nextEligiblePollAt`).
- **Single-flight.** At most one `brain status` child process exists at a time. A refresh requested while a poll is in flight returns the in-flight promise **only when that in-flight poll can still satisfy the request**; a refresh that must observe post-mutation state (after a config write or credential set) does not accept a poll that began before the mutation — see *Post-mutation reconciliation* below.
- **Timeout: 15 s wall-clock**, measured from spawn. `POLL_TIMEOUT_MS` in `src/main/constants.ts`; a starting value to be confirmed against a live p99 (see `open-questions`). On expiry the child is sent `SIGTERM`; if it has not exited **2 s** later (`POLL_KILL_GRACE_MS`) it is sent `SIGKILL`. The poll result is recorded as `broken` / `cli-unreachable`.
- **Fail-fast, no silent fallback.** A failed poll produces a `broken` snapshot with the real reason. The app does **not** retry-in-a-loop within a tick, does **not** fall back to the last-known-good snapshot as if it were current, and does **not** invent a "probably fine" state. `lastCheckedAt` always reflects the last *completed* poll so a stale scoreboard is visibly stale.

**Post-mutation reconciliation (no dropped guarantee).** A successful config write triggers a Restart and a successful credential set triggers a refresh (below). If the required operation cannot run immediately because a poll or Restart is already in flight, the app records a **pending reconciliation** rather than dropping it: when the active work settles, the app runs exactly one trailing operation — a **full Restart takes precedence over a refresh** if both are pending — and the caller's `ConfigWriteResult`/`OpResult` resolves against that final snapshot. A credential set issued while a poll is in flight therefore never returns key-presence sampled *before* the write; it awaits a refresh that begins *after* the write. A config write during an active Restart is not "ignored": it sets a pending Restart honored when the active one completes, so the session cannot be left on the old config and old generation.

**Poll cancellation (supersession).** A poll can be cancelled by a **Restart** or by **shutdown** (`app:quit` / OS-initiated termination). Restart is the only operation that *supersedes* a poll and starts a new generation; shutdown cancels without starting anything. Cancellation is defined as:

1. The child process is terminated with the same `SIGTERM` → 2 s → `SIGKILL` escalation the timeout uses. The app does not wait on the child before proceeding with the Restart/shutdown sequence; it does await the child's `exit`/`error` event before allowing a *new* poll to spawn, so the single-flight invariant holds across the boundary.
2. The superseded poll is marked cancelled at the moment of cancellation. **Its result is discarded unconditionally** — whether it arrives before or after termination, and regardless of exit code or stdout content. A cancelled poll never updates `health`, `reason`, `checks`, or `lastCheckedAt`, never emits `session:changed`, and never raises a notification. Late output from a cancelled child is not parsed.
3. Only the poll issued by the *current* session generation can update the snapshot. Each session init increments the generation counter; a poll result whose generation is not the current one is discarded by the same rule — even if the process was never signalled.

### Notifications

- A macOS notification is raised on **any transition to a different health level** — worse (`healthy`→`degraded`, `healthy`→`broken`, `degraded`→`broken`) *and* recovery (`broken`/`degraded`→`healthy`), so the owner learns both that it broke and that it is fixed — **or** when the set of failing/warning check names changes while already in a non-healthy state.
- **Exactly one notification per transition** — no repeat while the same state and same failing-check set persist.
- Notification text is **self-contained** (no "see above"): title `Atlas`, body = the snapshot `message`, e.g. `Vault not reachable at ~/Code/Vaults/main-vault`.
- Suppressed for the very first poll after app launch when the result is `healthy` (no news is not news).

### Restart Atlas

- **Definition:** tear down and re-initialize the engine session — cancel the in-flight poll, reload and re-validate config, re-resolve the key presence (env → Keychain), re-validate the vault, re-run `brain status`, re-arm the poller. Exactly the initialization sequence above.
- **Non-destructive, by construction:** the sequence spawns only `brain status --json` (a read command) and the `@atlas/models` `security find-generic-password` presence probe. It never touches the vault working tree, git, LanceDB, or projection contents, and holds no DB handle. It is safe to click at any time, including while the vault is dirty or while a `brain` command is running in a terminal — `brain status` is lock-free (it takes no mutation lock), so it cannot contend with a running mutation and cannot return the held-lock exit-2 case.
- **Concurrency:** Restart is single-flight. A Restart requested while one is running is coalesced into a pending Restart (per *Post-mutation reconciliation*), not silently dropped; the button is disabled with an announced busy state. A Restart supersedes any in-flight poll per *Poll cancellation*, so a slow pre-Restart poll can never land on top of the post-Restart snapshot.
- **Failure:** a Restart that fails at step 2 leaves the session `broken` with `config-invalid` — a successful *report* of a broken state, not a failed Restart. The button re-enables; nothing is left half-initialized.

### Configuration

- Opening the config window reads the current file and the pin/credential facts (`config:read`), and renders the branch of `ConfigState` it returns.
- **Validation is fail-fast and pre-write**: the edited object is parsed by `AtlasConfigSchema` and, when `ATLAS_EXPECT_VAULT` is set, checked against the pin via the shared canonicalization helper. Failures render as field-level issues; **no partial write ever occurs** (the atomic temp-file + rename guarantees the file is never observed half-written).
- A successful write triggers **exactly one** immediate session Restart (config is session state) — one teardown, one re-init, one poll — then the indicator reflects that poll. It is not two polls.
- **Credential set/replace**: the field is write-only. On save the value goes to `@atlas/models.setGeminiApiKey`; on success the field is cleared, the UI shows `Key: present`, and an immediate **refresh** (not a Restart — the session need not be rebuilt) runs so `provider-key-present` re-evaluates against post-write state. On failure the `OpResult` carries the specific reason (`empty-key`, `keychain-account-unresolved`, or `keychain-write-failed` with the `security` stderr line, which never contains the value).
- **Per-state form behavior:**
  - `missing` ⇒ fields render with the create-candidate values from `ConfigView.createCandidate` (schema defaults, or the pin for `vault.path` when set), disabled for edit; the only actions are **Create config** (`config:create`) and Reveal in Finder. No silent write.
  - `unreadable` ⇒ read-only with the OS error shown, offering **Reveal in Finder** and a retry of `config:read`; the app will not overwrite a file whose contents it could not read.
  - `unparseable` ⇒ read-only with the parse error shown and a **Reveal in Finder** action; the app will not overwrite a file it could not parse.
  - `invalid` ⇒ present-but-wrong fields render empty and marked from `issues[]`; absent optional fields render default-marked; saving is allowed because the save is a full schema-validated round-trip that either produces a valid file or writes nothing.
- Vault path pointing at a non-directory or a non-git directory ⇒ the write is allowed if the schema accepts it, but the next status poll will report the real failure — the app does not duplicate the CLI's vault validation.

### Other lifecycle behavior

- **Single instance.** A second launch focuses the existing instance and exits.
- **Login item** read via `app:getLoginItem` and toggled via `app:setLoginItem` (Electron `app.getLoginItemSettings` / `setLoginItemSettings`); macOS is the owner of that setting — the app stores no copy, and the toggle always renders the OS-observed value returned by the channel, including after a failed or unverifiable write.
- **Quit** (`app:quit`, and the same sequence on any OS-initiated termination) cancels any in-flight poll (same termination sequence) and clears the interval; there is nothing else to clean up (no DB handle exists). A teardown step that throws is logged and never prevents termination.
- **Sleep/wake:** the app subscribes to Electron's `powerMonitor` `'resume'` event; on wake it performs an **immediate on-demand refresh** (subject to `nextEligiblePollAt`) rather than waiting out the interval, and the interval timer is re-armed from that poll's completion. The refresh obeys single-flight like any other on-demand refresh, and the `'resume'` subscription is registered once (a Restart does not accumulate listeners).

### Observability (self-debugging level, not SRE-grade)

- The main process writes a plain line-oriented log to Electron's per-app user-data directory: **one per process start recording the single-instance-lock result** (`app start: lock=acquired|denied` — emitted once per OS process, NOT per Restart, so it is the single-instance oracle), one line per poll (`ISO timestamp, exit code, health, reason, duration_ms`), one per cancelled/timed-out poll (with which of the two it was), one per Restart (`session restart: gen=<n>` — the init sequence re-runs but does NOT re-acquire the lock), one per config write (keys changed — **never values**), one per credential set (`credential set: ok|error` — **never the value**), one per login-item change (requested vs observed vs readable), one per notification raised, one per wake-triggered refresh, one per config-fingerprint-drift Restart.
- Renderer console output is not persisted.
- **Log sanitization is a hard rule**: the credential value is never passed to any logging call, and config-write logging records key *names* only. Tests assert both that the sentinel value never appears **and** that each required event line is emitted (see `test-plan`).

## ssot — Single Source of Truth

Every value and rule the app touches has exactly one owner; the app consumes.

| Value / rule | Authoritative owner | How the app consumes it |
|---|---|---|
| Every path/threshold in Atlas config; the vault path; model names; the projection DB location | `brain.config.yaml`, validated by `AtlasConfigSchema` in `@atlas/cli` | Imports `AtlasConfigSchema` + `loadConfig`; never re-declares a field, type, or default |
| `DEFAULT_VAULT_PATH`, model defaults | The schema/loader defaults in `@atlas/cli` | Read from the schema; **not** restated in desktop code or in this spec's field table |
| The readiness predicate's checks and their pass/fail semantics | `apps/cli` `status` handler + `docs/specs/cli-contract/status.schema.json` | Consumes `checks[]` verbatim (`{name, ok, detail}`); the app **re-runs no check** — it does not itself test the vault, git, index staleness, or migrations |
| **Check → severity (glyph color)** | **New value introduced here.** Owner: the `CHECK_SEVERITY` map in `src/main/health.ts` | The app derives `warn`/`fail` from each check's boolean `ok`; it owns *how bad* a failure is for the glyph, never *whether* the check passed. `index-not-stale` + `migrations-current` ⇒ `warn`; `vault-reachable` + `git-healthy` + `provider-key-present` ⇒ `fail`; unknown names ⇒ `fail` |
| **Provider-key presence + set/replace + service identifier** | `@atlas/models`' credential module — the same package that resolves the key for `brain` and backs `provider-key-present` | **Imported, not forked.** The app calls the presence-only probe (returns `CredentialStatus`) and `setGeminiApiKey(value)` (write-only, never returns the value). The **service identifier** and `KEYCHAIN_ACCOUNT` live in that module; the app re-literals neither, so lookup and mutation can never target different Keychain items. If the probe/write helper is not currently exported, exporting them (presence-only + write-only) is part of this work |
| Exit-code meanings | `apps/cli/src/errors/envelope.ts` (`EXIT`) | The spawn wrapper maps codes in one place, `src/main/cli.ts`; no other module inspects exit codes |
| The mutation order / one-commit-per-ChangePlan | `apps/cli/src/workflows/mutation-order.ts` (`runMutation`) | The app performs **no** mutation of Atlas-managed state, so it cannot drift from it |
| Command membership / names / flags | `docs/specs/cli-contract/commands.json` | The app spawns only commands present there; v1 spawns exactly `status --json` |
| Gemini key value | The macOS Keychain item (or `ATLAS_GEMINI_API_KEY` when set) | Presence-probed and set/replaced through `@atlas/models`; **never copied, cached, mirrored into config, or held in app state** |
| Vault pin value | The `ATLAS_EXPECT_VAULT` env var, enforced by `loadConfig` | Read from the environment; enforced for real by `loadConfig` on the next session init |
| **Vault-pin canonicalization** | The **canonicalization helper `loadConfig`'s pin enforcement uses**, in `@atlas/cli` | **Imported and called** by the config form's pre-check and by `config:create`. The app implements no `~`-expansion, symlink resolution, or trailing-slash normalization of its own. If that logic is inline in `loadConfig`, extracting it into an exported helper is part of this work — so a pre-check pass followed by a loader rejection is impossible |
| Launch-at-login state | macOS (via `app.getLoginItemSettings`) | Read back from the OS on every `app:getLoginItem` and after every `app:setLoginItem`; no local copy persisted |
| Dependency versions | The root `catalog:` in `pnpm-workspace.yaml` | `"electron": "catalog:"` etc.; never a floating version in `apps/desktop/package.json` |
| Health-from-checks derivation | **New value introduced here.** Owner: `src/main/health.ts`, one exported function | Both the tray glyph and the popover scoreboard render from the single `SessionSnapshot` that function produces — the renderer never recomputes health from `checks[]` |
| Poll interval / timeout / kill-grace / notification-suppression / backoff (`POLL_INTERVAL_MS` default 60 s, `POLL_TIMEOUT_MS`, `POLL_KILL_GRACE_MS`, `nextEligiblePollAt`) | **New values introduced here.** Owner: `src/main/constants.ts` | Referenced by the poller and by tests; not duplicated into the renderer or into docs as literals. The detection guarantee is expressed **relative to** `POLL_INTERVAL_MS`, never as a wall-clock |
| The current session state + the session generation counter + the config fingerprint | **New state introduced here.** Owner: the main process's single `EngineSession` instance | The renderer holds only a cached copy delivered via `session:changed`/`session:get`; it never derives or mutates session state. Reconciliation direction is strictly main → renderer |

**Deliberately not duplicated:** the app introduces **no new store, table, cache, or config file**, and **no SQLite driver**. It holds no persistent state of its own except the app-log file and Electron's own window-state — neither of which shadows Atlas data.

**Config write ownership.** The app writes `brain.config.yaml` but does not *own* it: the schema owns the shape, and every write is validated by that schema before landing. The app is one of two writers of that file (the other being the owner's editor); there is no lock, and last-write-wins is accepted at this tier. The pre-write re-read means the app preserves every unmanaged change **completed before that read**; a race where the editor saves *after* the app's read but *before* its rename remains subject to accepted last-write-wins — the pre-read is not a substitute for a lock, and the spec does not claim it is. (A compare-before-rename conflict check is noted in `open-questions`.)

## security — Security & Trust

**Trust model.** Consistent with **ADR-0003**: v2 has **no security boundary beyond git history** — single operator, single machine, personal vault. The desktop app **adds no new privilege boundary and no new writer** of Atlas-managed state, and **no new reader** of it either. It runs as the invoking user with that user's full filesystem privileges, exactly as `brain` does. There is no network listener, no server, no IPC to any other user's process, no OS identity, no daemon, no launchd service. **No retired fortress machinery is revived** — no brokers, no scan gate, no ledger, no trust tiers, no capabilities, no signer.

**Trust boundaries that exist:**
1. **Renderer ↔ main.** The renderer is the less-trusted side. `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, remote module off. The preload exposes only the closed channel list in `interfaces` — no generic "run this command" or "read this file" channel. Every request payload is **runtime-validated in main** before any OS/spawn/file effect (`interfaces` §4); a malformed request short-circuits to `app-internal` with no side effect. Config field values are validated by `AtlasConfigSchema` before any write.
2. **App ↔ `brain` CLI.** Argv is a fixed literal (`["status", "--json"]`) — never from user input, never through a shell. The CLI is spawned with `shell: false` and an explicit argv array. The binary path and `ATLAS_ROOT` are resolved from the app's own install layout, not from `PATH`, so a `PATH`-shadowed `brain` cannot be picked up.
3. **App ↔ Keychain (via `@atlas/models`).** `security` is spawned with `shell: false` and an argv array. **Accepted residual (playground tier):** because `security add-generic-password` has no stdin path for the password, the set/replace passes the value as the `-w` argv element, so the secret is briefly visible in that process's argv to **same-user** processes for one `exec`. This is the only place the key touches argv; it never touches disk, logs, app state, or an IPC response, and the presence probe never uses `-w` so it never prints the value. The `-a` account argument is the login username from `os.userInfo()` — a non-secret machine-local value, not user-supplied text.

**Authentication / authorization.** None, by design and proportional to the tier: a local single-user GUI whose privileges are already the invoking user's. An app-level passcode would protect nothing an attacker with that user's session could not already reach through the filesystem. The macOS Keychain's own ACL is the only access control in play, and it is the OS's to enforce.

**Data classification and handling.**

| Data | Class | Handling |
|---|---|---|
| Gemini API key | Credential | **Keychain-only**, mediated by `@atlas/models`. Never rendered (presence boolean only), never written to disk, never in logs, never in git, never returned over IPC, never held in app state beyond the single write call. Briefly in the `security` process argv (accepted residual above). **No IPC channel can return it.** |
| Vault note contents | Personal/proprietary | v1 reads **none** of it — the app opens no projection handle and issues no direct read. No note text reaches the renderer. |
| Config values (paths, model names) | Non-sensitive | Displayed and edited; logged by key name on write |
| Status check output | Non-sensitive | Displayed; may contain a vault path, which is logged |

**Secrets management.** Storage: macOS Keychain item (or the `ATLAS_GEMINI_API_KEY` env override, which the CLI owns). Access: presence-probed via `security find-generic-password` **without `-w`**; set/replaced via `@atlas/models.setGeminiApiKey` targeting the login-user account so the existing item is updated, not duplicated. **Rotation is manual and out of scope** — the set/replace *is* the rotation affordance.

**Encryption.** In transit: nothing leaves the machine — the app makes no network calls whatsoever (the Gemini calls are made by the CLI, in-process, when the owner runs a command). At rest: the credential is at rest only in the Keychain, which the OS encrypts. Vault and projection are plaintext on disk, unchanged from v2's existing posture (ADR-0003).

**Input validation.** Config edits are zod-validated pre-write. IPC request payloads are runtime-validated pre-dispatch. `brain status --json` output is parsed and shape-validated before use; malformed output is a `broken` state, not a crash. The renderer performs **no** `innerHTML`-style injection of CLI-derived strings — all CLI text is inserted as text nodes, so a hostile check `detail` cannot become markup.

**Least privilege.** Git access: none (no direct queries). Projection access: none (no handle). The app requests no macOS entitlements beyond notifications and login-item; no Full Disk Access, no camera/mic/contacts, no accessibility API. The app is never run with `sudo`.

**Audit.** git history remains the sole audit trail for vault state, and the app cannot write to it — so there is nothing new to audit there. The app-local log (poll results, restarts, config-key-name changes, credential-set outcomes) is a debugging aid, explicitly **not** a security ledger, and is sanitized as described in `behavior`.

**Residual risks (accepted, unchanged from ADR-0003 unless noted — do not re-add retired machinery to close them).**
- Agents write directly into the real brain; git history is the only undo. The app does not change this and adds no writer.
- Ingest is unsandboxed and unscanned. **v1 adds no ingest path**, so this surface is not widened. (When drag-drop ingest is later built, it *will* widen it, and that is a decision for that phase's ADR — not this one.)
- **New, accepted:** a persistent GUI process runs continuously as the owner. It holds no secret in memory and opens no listener, so its resident attack surface is the Electron runtime itself. Accepted at playground tier.
- **New, accepted:** the Gemini key is briefly visible in the `security` process argv (same-user only) during a set/replace, because `security add-generic-password` has no stdin path. Accepted at playground tier; a native-binding hardening is noted in `open-questions`.

## test-plan — Test Plan

**Strategy.** Unit + integration via **vitest** in `apps/desktop` (`pnpm -r test` picks it up). The main-process logic is deliberately factored so that health derivation, the check-severity policy, exit-code mapping, the poller/session lifecycle, the single-instance gate, config reading/writing, and log sanitization are **pure/injectable modules testable without launching Electron** — the CLI spawn, the `@atlas/models` credential module, `powerMonitor`, the login-item API, and the `app` object's single-instance surface are all injected fakes, and timers are vitest fake timers. Electron-window E2E is **not** automated in v1 (playground tier); the window and menubar are covered by the mandatory **live drive**. Both CI legs must stay green, so every automated test is platform-neutral or explicitly macOS-gated.

**Acceptance criteria per capability** are the seven numbered success criteria in `intent`; each maps to at least one test or live-drive step below.

### Automated — health derivation + check-severity (`src/main/health.ts`)

Table-driven, each asserting `health` **and** `reason`:

| Input | Expect | Breaks silently without this test |
|---|---|---|
| all checks `ok`, config loaded | `healthy` / `ok` | — |
| `index-not-stale` `ok:false`, rest ok | `degraded` / `check-warn:index-not-stale` | A warn rendering green; the owner never learns the index is stale |
| `migrations-current` `ok:false`, rest ok | `degraded` / `check-warn:migrations-current` | A pending migration rendering green |
| `vault-reachable` `ok:false` | `broken` / `check-failed:vault-reachable` | A missing vault showing amber, not red |
| `configLoaded: false` (otherwise passing) | `broken` / `config-invalid` — **precedence**: config wins over every check | A broken config masked by stale check data |
| both a `fail` and a `warn` present | `broken` (fail dominates) | A red condition downgraded to amber |
| an **unknown** check name with `ok:false` | `broken` / `check-failed:<name>` (unknown ⇒ fail) | A future failing check silently ignored by a hardcoded allowlist |
| `checks: []` with CLI unreachable | `broken` / `cli-unreachable` | An empty check list vacuously satisfying "no check failed" ⇒ **green with zero evidence**. The highest-value single test in the plan |

Plus a renderer assertion that an unknown check name appears in the scoreboard with its `name`, derived `severity`, and `detail`.

### Automated — exit-code mapping (`src/main/cli.ts`)

One case per code in the `interfaces` table, driven by a stubbed spawn. Plus:
- exit `0` with **non-JSON stdout** ⇒ `broken` / `status-unparseable`.
- exit `0` with JSON of the **wrong shape** (e.g. `checks` missing) ⇒ `status-unparseable`.
- exit `4` with `retryable: true, retryAfterMs: N`: assert the next **auto**-poll is scheduled at **exactly** `max(N, POLL_INTERVAL_MS)` — cover `N < POLL_INTERVAL_MS` (floor is the interval) **and** `N > POLL_INTERVAL_MS` (floor is `N`). *(Breaks silently: the app hammering a backing-off CLI, or polling too early when `N` is small.)*
- a user-initiated on-demand refresh while a `nextEligiblePollAt` backoff is pending ⇒ the refresh **fires immediately** (backoff governs auto-polls only).
- spawn `ENOENT` ⇒ `cli-unreachable`, no unhandled rejection.
- a poll exceeding `POLL_TIMEOUT_MS` ⇒ `SIGTERM`, then `SIGKILL` after `POLL_KILL_GRACE_MS`; result `cli-unreachable`. *(Breaks silently: a hung `brain` pinning the glyph on stale green.)*
- **argv assertion**: exactly `["status","--json"]` with `shell: false`.

### Automated — polling, coherence & notification rules

Fake timers; detection assertions are relative to `POLL_INTERVAL_MS`, never a literal.

- **Single-flight**: two refreshes while one poll is in flight ⇒ exactly **one** spawn.
- **Interval detection guarantee**: a stub flipping healthy→failing; advancing by `POLL_INTERVAL_MS` and letting the poll complete ⇒ snapshot reflects the failure; advancing less with no poll in flight ⇒ unchanged.
- **Config-fingerprint drift**: change the config file's fingerprint under a running session ⇒ the next scheduled poll instead triggers a Restart (new generation), and the resulting snapshot reflects the new config. *(Breaks silently: checks for vault B rendered under the app's memory of vault A.)*
- **Post-mutation reconciliation**: a config write during an in-flight Restart ⇒ a pending Restart runs after, leaving the session on the new config/generation (not the old); a credential set while a poll is in flight ⇒ the returned result reflects a refresh that began **after** the write, never the pre-write poll's presence. *(Breaks silently: a save that reports success while the engine keeps the old config.)*
- `healthy`→`degraded`→`degraded` ⇒ exactly **one** notification; `degraded`→`broken` ⇒ a second; `broken`→`healthy` ⇒ a recovery notification.
- Non-healthy with the failing-check **set changing** (`{vault}` → `{vault, git}`) ⇒ a new notification.
- First poll after launch returning `healthy` ⇒ **zero** notifications.
- `lastCheckedAt` advances only on a *completed* poll.

### Automated — single instance

The Electron `app` single-instance surface is injected as a fake exposing `requestSingleInstanceLock()`, `on('second-instance', …)`, `quit()`, and a `show/focus` spy.

- **lock denied ⇒ the process quits without initializing**: with the lock `false`, assert `app.quit()` is called and the session **never initializes** — no `brain status` spawn, no interval armed, no tray created, no credential probe. *(Breaks silently: two live instances polling and each holding a config form — doubled `brain status`, duplicate notifications, and two concurrent last-write-wins writers of `brain.config.yaml`.)*
- **lock granted ⇒ normal init, second-instance handler registered exactly once**.
- **second-instance event focuses, does not re-init**: emit `'second-instance'` ⇒ existing window shown/focused, generation counter unchanged, no additional interval or spawn.
- **repeated second-instance events are idempotent**: N emissions ⇒ N focus calls, still one session, still one interval.

### Automated — wake-from-sleep refresh

`powerMonitor` injected as a fake; timers fake.

- **wake triggers an immediate poll**: after the first poll, advance a small fraction of `POLL_INTERVAL_MS`, emit `'resume'`, assert a spawn at resume+ε with the interval timer demonstrably not yet due.
- **wake refresh obeys single-flight**: `'resume'` while a poll is in flight ⇒ no second spawn.
- **wake respects backoff**: `'resume'` while `nextEligiblePollAt` is pending ⇒ the wake poll waits until eligible.
- **wake re-arms the interval from the wake poll**.
- **no resume subscription leak**: listener count on `powerMonitor` is 1 after N restarts.

### Automated — poll cancellation on Restart/shutdown

The CLI spawn is a controllable fake whose child exit + stdout are driven manually.

- **restart terminates the in-flight child** (`SIGTERM` → `SIGKILL` after `POLL_KILL_GRACE_MS`).
- **restart supersedes the in-flight poll — late result fully discarded**: hold a poll's result, trigger `session:restart`, then deliver the superseded stdout+exit after the restart. Assert the superseded result changes nothing (`health`, `checks`, `reason`, `lastCheckedAt`), emits no `session:changed`, raises no notification. Run in **both orderings** (stale arriving before and after the post-Restart poll completes).
- **single-flight holds across the restart boundary**: at no point do two `brain status` children coexist — the new poll spawns only after the old child's `exit`/`error`.
- **stale generation is discarded without a signal**: a result carrying a stale generation is discarded by the generation rule even when the process was never signalled.
- **shutdown cancels without a new generation**: `app:quit` cancels the in-flight poll and starts nothing.

### Automated — restart/refresh-on-config-change

Fake timers; config file in a temp dir; CLI spawn stubbed.

- **successful config:write restarts immediately, no clock advance**: generation +1, a new `brain status` spawn, the interval timer's remaining delay still near a full `POLL_INTERVAL_MS` (proving the poll came from the write, not a due tick).
- **the restarted session reads the new config**: the injected loader receives the new file contents.
- **successful config:create restarts identically**.
- **a failed config:write triggers no restart**: invalid edit, `config-exists`, `config-unreadable`, and `pin-conflict` each ⇒ `ok:false`, generation unchanged, no new spawn.
- **a no-op save triggers no restart**: byte-identical output ⇒ `changed:false`, no restart, mtime unchanged.
- **successful credential:set refreshes but does not restart**: one immediate poll, generation **unchanged**.
- **restart/refresh-on-write is single-flight-safe** via the pending-reconciliation path: exactly one poll exists afterward.

### Automated — config read & write (`src/main/config-read.ts`, `src/main/config-write.ts`), temp dir

**Read — every `ConfigState` branch:**
- Valid file ⇒ `loaded` with all managed fields; optional fields carry `setInFile` flags.
- `ENOENT` ⇒ `missing`.
- `EACCES` (and separately `EISDIR`) ⇒ `unreadable` with errno + OS message; **no rejection**; distinct from `missing`.
- An error with no `errno` ⇒ `unreadable` with `errno: 'UNKNOWN'`.
- Unparseable YAML ⇒ `unparseable` with the parser message.
- Parses but fails schema ⇒ `invalid`; specifically a file where `vault.path` is valid but `note_globs` is a number ⇒ `values.vaultPath` present, `values.noteGlobs` **absent**, `issues[]` has a `note_globs` entry (present-but-wrong).
- **Absent optional produces no phantom issue**: a file setting only `vault.path` ⇒ if it otherwise validates it is `loaded` with the model/glob fields default-marked (`setInFile:false`), **not** `invalid`; assert no fabricated `issues[]` entry for the absent optionals. *(Breaks silently: the impossible invariant where an omitted optional must both be absent from values and produce an issue.)*

**Write (CST document semantics):**
- Valid edit ⇒ file written; re-reading via `loadConfig` **succeeds** (round-trip).
- **Invalid edit** (e.g. `note_globs` given a non-string element) ⇒ `ok:false`, issues populated, on-disk file **byte-identical**.
- **Comments + ordering preserved**: a config with leading/inline comments and a specific key order survives a vault-path edit with comments and order intact (CST-level). *(Breaks silently: an object round-trip silently stripping the owner's comments.)*
- **Unmanaged (other-schema) keys preserved**: a config containing schema keys the app does not manage survives a managed edit verbatim.
- **note_globs editing**: add multiple globs, edit one, then **clear the list** ⇒ the saved YAML **omits** `vault.note_globs` (not `[]`) and `loadConfig` applies the schema default; each state re-reads correctly.
- **No-op save**: byte-identical output ⇒ `changed:false`, mtime unchanged.
- **Write refused on an unreadable file** (`EACCES` pre-read) ⇒ `ok:false, reason:'config-unreadable'`, nothing written.
- **`ATLAS_EXPECT_VAULT` pin**: candidate canonicalizing elsewhere ⇒ rejected pre-write, nothing written, pin named; candidate differing textually but canonicalizing **to** the pin (symlink / trailing slash / `~`) ⇒ accepted; assert the pre-check calls the **CLI-exported canonicalization helper**, not a local copy.
- **`config:create` pin safety**: with the pin set, `config:create` seeds `vault.path` from the pin and the created file passes `loadConfig` (no immediate `config-invalid` Restart); with a hypothetical default-vs-pin mismatch the create path never writes a pin-violating file.
- **Fresh pre-write re-read under concurrent editing**: read the form state, mutate an **unmanaged** key externally (simulating the owner's editor completing a save **before** the app's pre-write read), then submit a managed edit and assert the external change **survives**. (File-watching is out of scope; this tests only the committed pre-write re-read.) *(Breaks silently: a save from a cached document clobbering an editor's change made before the read.)*
- **Atomicity**: a simulated failure between temp-write and rename leaves the original intact and no stray temp file the loader would read.
- **No Atlas-state write**: the config-write path touches only the config file — no git process, no `brain` spawn (beyond the post-write restart's poll), nothing under the vault path.
- **`config:create` state gating**: only writes in `missing`; `config-exists` in `loaded`/`unparseable`/`invalid`; `config-unreadable` in `unreadable`; nothing written otherwise.

### Automated — credential handling (security-relevant)

Tests inject a fake `@atlas/models` credential module; the security-command behavior is exercised through it.

- `setGeminiApiKey` argv contains `-U`, `-s <service>`, `-a <username>`, and `-w <value>`, spawned with `shell: false`; the **service identifier and account both come from the `@atlas/models` module**, and the literal `aryeh` appears nowhere in desktop source. *(Breaks silently: a duplicate Keychain item, or a service string that drifts from the CLI reader.)*
- **empty/whitespace value** ⇒ `credential:set` returns `ok:false, reason:'empty-key'` and **nothing is spawned**.
- **`os.userInfo()` throwing** ⇒ `ok:false, reason:'keychain-account-unresolved'`, nothing spawned.
- The presence probe invokes `security find-generic-password` **without `-w`** and **without `-a`** (service only).
- **`security` nonzero exit on set** (e.g. denied ACL) ⇒ `ok:false, reason:'keychain-write-failed'` with the stderr line as `message`, surfaced in the form, and presence **not** flipped to present.
- **Probe outcomes are three-valued**: a definitive item-not-found ⇒ `{present:false, source:'none'}`; a **non-not-found** failure (spawn error / locked Keychain / other nonzero) ⇒ `{present:false, source:'unknown'}`, rendered as "presence unknown", never "not set", never a crash.
- **No IPC channel returns the secret**: an assertion over the channel/handler map that no response type or runtime value contains the credential; `credential:status` returns only `CredentialStatus`.
- **Log sanitization + required lines**: feed a known sentinel through `credential:set` (success and nonzero-exit paths) and a config write; assert the sentinel appears **nowhere** in emitted lines, config-write lines contain key names not values, **and** that each required event class (poll, cancelled/timed-out poll, restart, config write, credential set, login-item change, notification, wake refresh, fingerprint-drift restart) emits exactly one well-formed line. *(Breaks silently: sanitization "passing" only because the log line was never emitted.)*
- `ATLAS_GEMINI_API_KEY` set ⇒ `{present:true, source:'env'}` without any Keychain call, and the UI reports the env override.

### Automated — IPC runtime validation + isolation

- **Malformed payloads**: table-driven bad requests for `config:write`, `credential:set`, and `app:setLoginItem` (e.g. `enabled` a string, `credential.value` a number) ⇒ the shared wrapper returns `reason:'app-internal'` and **no** file / Keychain / process / login-item side effect occurs. *(Breaks silently: a renderer regression reaching an OS mutation with an untyped payload.)*
- **Rejection→envelope**: a handler that throws surfaces as an `app-internal` `OpResult`, not a renderer-visible rejection.
- **Isolation settings**: assert the `BrowserWindow` is constructed with `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`. *(Breaks silently: a load-bearing security posture silently regressed.)*

### Automated — login item and quit channels

- `app:getLoginItem` returns the OS value fresh each call; a throwing `getLoginItemSettings` ⇒ `{enabled:false, readable:false}`, no rejection.
- `app:setLoginItem` write succeeds + read-back agrees ⇒ `{ok:true, readable:true, enabled:<requested>}`.
- `app:setLoginItem` with `setLoginItemSettings` throwing ⇒ `{ok:false, reason:'login-item-write-failed', readable:true, enabled:<observed>}`, no rejection.
- `app:setLoginItem` write clean but read-back disagrees ⇒ `{ok:false, reason:'login-item-unverified', readable:true, enabled:<observed>}`.
- **read-back throws after a successful write** ⇒ `{ok:false, reason:'login-item-readback-failed', readable:false, enabled:<requested, unverified>}`, no rejection, UI renders "unknown". *(Breaks silently: a fabricated observed boolean when none exists.)*
- Setting the value already in effect ⇒ `ok:true`, idempotent.
- `app:quit` runs teardown (poll terminated, interval cleared) before termination; a throwing teardown step is logged and termination still proceeds.

### Automated — session lifecycle

- Restart from a healthy session ⇒ the poller interval count stays at one, one new poll.
- Restart while `config-invalid` ⇒ terminates at step 2, no exception, button re-enables.
- Restart is single-flight; a second concurrent request is coalesced (pending), not a second sequence.
- **Non-destructiveness by construction**: the set of commands the restart sequence can spawn is exactly `{brain status --json, security find-generic-password}` — no mutating command reachable. *(Breaks silently: a future refactor slipping `brain sync` into the restart path.)*
- Quit ⇒ in-flight poll terminated, interval cleared (no DB handle to close).

### Automated — renderer

- The scoreboard renders from the delivered `SessionSnapshot` and **never recomputes** health or severity from `checks[]` (the renderer module exports no derivation function and imports the shared types only).
- Each `ConfigState` branch renders its form: `missing` ⇒ Create-config only (fields default/pin-seeded, disabled); `unreadable` ⇒ read-only with OS error, Reveal + retry, **no Create-config**; `unparseable` ⇒ read-only with parse error + Reveal; `invalid` ⇒ editable, present-but-wrong fields marked, absent optionals default-marked; `loaded` ⇒ normal edit.
- The login-item toggle renders the channel's value, including after `ok:false` and after `readable:false` (shows "unknown", not requested).
- CLI-derived strings inserted as text, not markup — a `detail` containing `<img onerror=…>` renders literally.
- Accessibility assertions are under `accessibility`.

### Automated — repo-level gates (must not regress)

- `pnpm -r build` and `pnpm -r test` green on **both** `ubuntu-latest` and `macos-15`. Keychain, notification, and login-item cases are macOS-gated (with a visible skip reason); health/severity/exit-code/poller/coherence/wake/cancellation/single-instance/config-read/config-write/restart/lifecycle/IPC-validation cases are platform-neutral (injected fakes) and run everywhere.
- **No native module in the desktop package** — `@atlas/desktop` depends on no `better-sqlite3` and no other native addon, so **neither CI leg performs a native rebuild** and `pnpm install --frozen-lockfile` stays clean on both. (Electron itself is fetched as a prebuilt binary and app packaging is macOS-only.) A test asserts the desktop `package.json` declares no native dependency.
- `node tools/gen-cli-contract.ts --check` still passes — v1 adds **no** command, so `commands.json` is unchanged; a gate proves the surface did not grow.
- The existing `no-retired-reference.test.ts` gate passes with the new package in tree.

### External dependencies — real vs doubles

`brain`, the `@atlas/models` credential module (hence `security`), `powerMonitor`, the login-item API, and the Electron single-instance lock are **stubbed/injected** in automated tests — deterministic, fast, CI-portable, at the cost of not proving the real contracts (a real `SIGTERM` on a real `brain`, a real sleep/wake, a real Keychain ACL prompt, a real double-launch of the packaged `.app`). That gap is closed by the live drive, which is why the live drive is a mandatory delivery step.

### Live drive (mandatory, on the real Mac — "test live"; NOT CI)

Run against the real `main-vault`, the real `brain` binary, and the real Keychain. Each step records observed evidence:

1. Launch; glyph green; accessible label `Atlas: healthy`; scoreboard shows all passing checks and a fresh `lastCheckedAt`.
2. `mv` the vault aside → by the next completed poll the glyph turns red, exactly one notification with a self-contained message; restore → recovery notification, green.
3. Let the index go stale (or force a pending migration) → the glyph turns **amber** (advisory), one notification; the reason names the warn check; fix it → green.
4. Delete the Keychain item → `provider-key-present` fails, glyph red; re-set the key through the config form → green; confirm via `security find-generic-password -s <service>` (exit 0, one item) and `security find-generic-password -s <service> -g 2>&1 | grep -c '"acct"<blob>="'` that **exactly one** account entry exists (no duplicate); grep the app log for the key value → **zero hits**.
5. Click Restart on a healthy session; capture `git -C <vault> status --porcelain` and the `notes` count from `brain status --json` before and after → identical.
6. Click Restart while the vault is dirty and while a `brain` command runs in a terminal → no error, no interference, no lock contention (confirming `status` is lock-free). Also click Restart during a deliberately-slowed poll → no stale result lands afterward and `pgrep -f 'brain status'` → empty.
7. Edit the vault path to a bogus value → save → the glyph goes red **on the post-save restart, without waiting for the next tick** (confirm the log shows a restart+poll line immediately after the write line); edit back → green immediately.
8. With `ATLAS_EXPECT_VAULT` exported, attempt a vault path elsewhere → rejected in-form with the pin named; nothing written (file mtime unchanged).
9. Edit **both** `models.generation_model` and `models.embedding_model`, save (assert a config with leading comments keeps them), then run `brain` in a terminal and confirm it loads the new config without a `ConfigError`. No glyph transition is expected (no model-validity check).
10. Edit `vault.note_globs`: add two globs, save, confirm `loadConfig` accepts; clear the list, save, confirm the YAML **omits** the key and `brain` applies the default.
11. `chmod 000` the config file and reopen the window → the **unreadable** branch renders with the OS error, offers Reveal in Finder, offers **no** Create-config action; restore permissions and retry → recovers. Confirm nothing was written while unreadable (mtime unchanged).
12. Toggle launch-at-login; confirm the rendered state matches System Settings; log out and back in; confirm the app starts and the glyph settles green; toggle back off and confirm the item is removed.
13. Measure `brain status --json` wall-clock over ~20 runs on the real vault; confirm `POLL_TIMEOUT_MS` sits comfortably above the observed p99 (resolves the timeout open question).
14. **Real sleep/wake**: `pmset sleepnow`, break a check while asleep, wake → the glyph updates from a wake-triggered poll promptly, and exactly one poll fired on wake (app log).
15. **Real double-launch**: with the app running, launch again from Finder → the existing menubar item is focused, no second glyph. The single-instance proof is **two independent oracles**, because one Electron instance owns several helper processes (GPU, renderer, utility) whose command lines share the app path: (a) count only the **main** process with an exact predicate that matches the main executable path and **excludes** any `--type=` helper (e.g. `pgrep -lf "<app>/Contents/MacOS/<main-exe>" | grep -v -- '--type='` ⇒ exactly one), and (b) confirm the app log shows exactly **one** `app start: lock=acquired` line (the running instance) and that the relaunch logged `app start: lock=denied` and quit — with **no** second `lock=acquired` and no second poll-arm sequence. Because a Restart emits `session restart:` and never `app start: lock=acquired`, the restarts from earlier steps do not inflate this count. Both oracles must hold.
16. Full VoiceOver + keyboard-only pass, plus 200%-zoom and contrast checks (see `accessibility`).
17. Build and launch the packaged `.app`; confirm it resolves the **bundled** `brain` binary and `ATLAS_ROOT` outside a `pnpm dev` context, and repeat step 15 against the packaged build (the single-instance lock is the behavior most likely to differ between `pnpm dev` and a real `.app`).

**Not specified (proportional to tier):** load/perf tests, migration/rollout tests, and staging-parity tests (there is one environment: the owner's Mac).

## accessibility — Accessibility

The app has a real user-facing surface — menubar glyph, popover/status window, config form, notifications — so this section is **normative**, and the bar is high.

**Target: WCAG 2.2 AA** for all text and meaningful non-text content, in **both light and dark menubars** and in both light and dark app appearance, and under macOS **Increase Contrast**.

### Menubar glyph

- **Never color-alone.** The three states are distinguished by **shape/symbol first, color second**: healthy = a **check**, degraded = a **caret/exclamation**, broken = a **cross**. The symbol must be legible at menubar size.
- **Rendering reconciles color with the menubar.** Because a macOS *template* image is system-tinted monochrome and cannot carry green/amber/red, the glyph is rendered as a **non-template image with explicit light- and dark-menubar variants** (an `NSImage` marked non-template, or per-appearance assets), so the health **color** survives while the **shape** still conveys state independently of color. The acceptance gate is the shape+label; color is a secondary cue whose contrast is verified below, not the sole signal.
- Carries an **accessible label and tooltip stating the state in words**, e.g. `Atlas: healthy`, `Atlas: degraded — index stale`, `Atlas: unreachable — vault not found`. The label is the snapshot's `message`, always specific.
- Contrast: the glyph's rendered form meets the ≥ 3:1 non-text contrast bar against **both** menubar backgrounds, verified per variant.

### Popover / status window

- **Fully keyboard operable.** The menubar status item is reachable via the macOS menu-bar keyboard path (Control-F8 / VoiceOver `VO-M`) and activating it opens the popover. **Initial focus** lands on the first interactive control — the **Restart** button. **Escape** dismisses the popover and returns focus to the menubar status item. Nothing is reachable by mouse only.
- **The scoreboard check rows are NOT tab stops.** They are a semantic list/table in document reading order, reachable via the VoiceOver rotor and reading order, not by Tab. The Tab order across interactive controls is **Restart → Configuration → Launch-at-login → Quit**.
- **Visible focus indicator** on every interactive element, meeting the non-text contrast bar; the system focus ring is not suppressed.
- **Semantic HTML first, ARIA only where HTML is insufficient.** Each check row programmatically associates its **name**, its **state in words** (e.g. "index-not-stale, warning, index is 3 commits behind"), and its detail. State is conveyed textually and by a status symbol, not by a colored dot alone.
- The **Restart** button is a real `<button>`, announces its name and its **busy/disabled** state while a restart is in flight (`aria-busy`/`aria-disabled` + text status, not graying alone).
- **Live-region announcements** (polite): when a poll completes and **any of** the health level, the reason, or the failing/warning check-set changes, the region announces the new state — mirroring the notification rule, so a same-health change to the failing-check set is not silent. It also announces **completion of a user-initiated refresh** even when the result is unchanged (an accessible "checked, still healthy" cue). It does **not** announce unchanged background polls (no spam), and it is polite, not assertive.
- **Headings and landmarks**: correct heading hierarchy and named regions so VoiceOver rotor navigation is useful.

### Configuration form

- Every field is a labeled control with a **programmatically associated `<label>`** — no placeholder-as-label.
- **Errors are programmatically associated** (`aria-describedby` to the message, `aria-invalid` on the control) and announced when they appear; the message names the field and the remediation.
- The credential field is `type="password"`, write-only, with associated help text ("stored in the macOS Keychain and never displayed"). Its **presence indicator** ("Key: present" / "Key: not set" / "Key: presence unknown") is text, not an icon alone.
- The launch-at-login control is a real labeled checkbox/switch whose checked state is the OS-observed value; on a failed or unverifiable write the associated message states the observed/unknown state in words.
- The `ATLAS_EXPECT_VAULT` pin, when set, is announced as a read-only constraint associated with the vault field.
- Save/cancel keyboard-reachable; **Return** submits, **Escape** cancels with no write.
- **Text scaling / zoom**: layout survives 200% zoom without loss of content or functionality; no fixed-height clipping.
- **Click targets** ≥ 24×24 CSS px and generously padded.

### Notifications

- Delivered through the **native macOS notification center**, inheriting system accessibility (VoiceOver announcement, notification-center review, Do-Not-Disturb honoring).
- Text is **self-contained**: no "see above".

### System preferences

- **`prefers-reduced-motion`** respected: no popover animation, no spinner rotation, no state-change transition when set — changes are instantaneous.
- **`prefers-color-scheme`** and macOS **Increase Contrast** respected; the app hardcodes no single-theme palette.
- No information is conveyed by color alone **anywhere** (checks, key presence, and glyph all carry a symbol and text).

### Verification

Accessibility is verified two ways:

(a) **Automated** — renderer tests assert: label association; `aria-invalid`/`aria-describedby` wiring on error; the live region's presence, politeness, and that it fires on health/reason/check-set change and on user-refresh completion but not on unchanged background polls; the reduced-motion branch; a non-color state indicator on every status row; the tab order excludes scoreboard rows; and that the layout has no fixed pixel heights that would clip at 200% zoom (asserted structurally on the rendered DOM/CSS).

(b) **Live** — a full **VoiceOver + keyboard-only** pass driving all four capabilities without the mouse; a **200% zoom** pass on the status and configuration windows confirming no lost content or function; and a **contrast** pass over text, controls, status indicators, and focus rings in **light, dark, and Increase Contrast** appearances, plus the glyph on both menubar backgrounds.

## open-questions — Open Questions

Each is stated concretely enough that resolving it yields a decision. Owner is the repo owner (Aryeh) unless noted; all are non-blocking for drafting the plan, and each names the phase by which it must be settled.

1. **Should credential set/replace verify the key with a probe call before saving?**
   A probe would catch a typo'd key immediately rather than at the next `brain` invocation, but it makes the app perform a **network call to Gemini** — which v1's security section states it never does — and it needs a model/endpoint to probe against. **Resolved for v1: no probe.** Rely on `provider-key-present` plus the owner's next real command. Revisiting it later requires amending the "no network calls" claim in the same change.
   *Decision needed by:* settled; revisit only in a later spec.

2. **`brain` binary + `ATLAS_ROOT` resolution in the packaged `.app` — resolved.**
   Resolved in `interfaces` §2: the packaged `.app` **bundles** `apps/cli/dist/` and the `docs/specs/cli-contract/` tree into `Resources`, spawns the bundled entrypoint, and points `ATLAS_ROOT` at the bundled tree; dev mode resolves the sibling repo build. The user-visible failure when resources are absent is `cli-unreachable` with a reinstall hint. Open only as a *packaging-mechanics* task (how the bundle step is wired), owner: implementer, by the packaging step.

3. **Confirmation of `POLL_TIMEOUT_MS` against a live measurement.**
   The spec sets `POLL_TIMEOUT_MS = 15_000` and `POLL_KILL_GRACE_MS = 2_000` so behavior is fully specified. Open only as a *tuning* question: live-drive step 13 measures `brain status --json` wall-clock on the real vault; if p99 is not comfortably below 15 s, the constant is adjusted in that phase. `POLL_INTERVAL_MS` stays at 60 s unless the live drive shows a reason to change it; because every guarantee is relative to the interval, retuning either constant invalidates nothing.
   *Decision needed by:* the phase-1 live check. **Owner: implementer, informed by the measurement.**

4. **Presence-probe, write-helper, and pin-canonicalization exports.**
   `ssot` requires the app to *import* the credential module's presence probe **and** its `setGeminiApiKey` write helper from `@atlas/models`, and the vault-pin canonicalization helper from `@atlas/cli`, rather than fork any of them. Unresolved: whether these are currently exported, and the exact extraction shape (a presence-only wrapper that never returns the value; a write-only setter; a `canonicalizeVaultPath` helper lifted out of `loadConfig`). All are internal refactors with no CLI-surface change, so none touches `commands.json`.
   *Decision needed by:* start of phase 1 (probe + write helper) and phase 3 (canonicalization). **Owner: implementer.**

5. **Concurrent config edits (app vs. the owner's editor).**
   The spec accepts last-write-wins with a pre-write re-read (which preserves changes completed before the read; later races remain last-write-wins). Unresolved: whether the config window should additionally watch the file and warn when it changed underneath an open form, or add a compare-before-rename conflict check. *Leaning:* out of scope for v1; note it.
   *Decision needed by:* phase 3, decidable at implementation time. **Owner: implementer.**

6. **ADR-0004 title and scope wording.**
   The ADR must state the persistent-desktop-surface decision **and** the engine-access doctrine (no direct read or write of Atlas-managed state, CLI-spawn for state, `brain status` the sole readiness reader, one surviving writer, config-file writes explicitly outside that boundary), and must explicitly state that it does **not** supersede or weaken ADR-0003. Whether it is one ADR or two (surface vs. doctrine) is open; *leaning:* one.
   *Decision needed by:* the first PR (the ADR lands with phase 1). **Owner: repo owner.**

7. **Hardening the credential write off argv.**
   v1 accepts the `security add-generic-password -w <value>` argv residual (same-user visibility for one `exec`) because `security` has no stdin path. A native Keychain binding (e.g. `@napi-rs/keyring`) via `@atlas/models` would remove argv exposure entirely, at the cost of a native module (the ABI-rebuild class this spec otherwise avoids). *Leaning:* keep the `security` shell-out at playground tier; revisit if the residual is later deemed unacceptable.
   *Decision needed by:* not blocking v1. **Owner: repo owner.**
