# Atlas Desktop (`@atlas/desktop`) — v1 Minimum

## intent — Intent & Soundness

**Problem.** Atlas v2 is a single-process CLI: `brain <cmd>` opens the vault, mutates, commits, exits (ADR-0003). There is no daemon, no `brain serve`, no launchd service. The owner therefore has **no ambient way to know Atlas is usable** — "is my vault reachable, is git healthy, is the Gemini key present, is the index fresh?" is answerable only by remembering to type `brain status` in a terminal. Configuration (vault path, model names, API key) has no surface at all beyond hand-editing `brain.config.yaml` and running `security add-generic-password` by hand.

**Design.** A macOS Electron app at `apps/desktop` (package `@atlas/desktop`) that is **the only persistent Atlas-related process on the machine**. It hosts a thin, in-process **engine session** and is otherwise a *client* of the existing `brain` CLI. It delivers exactly three capabilities:

1. **Running indicator** — a menubar glyph (green / amber / red) derived from the engine session state plus the four checks `brain status --json` already emits.
2. **Restart Atlas** — tear down and re-initialize the engine session; non-destructive.
3. **Configuration** — edit vault, model settings, and the Gemini credential.

**Why this solves it.** Because there is no daemon, "up and running" can only mean *readiness*: "if I invoke Atlas right now, will it work?" That predicate is already fully computed by `brain status` (`vault-reachable`, `git-healthy`, `provider-key-present`, `index-not-stale`) plus two app-local facts (config loads, projection DB opens read-only). Polling that predicate on an interval and surfacing it in the menubar is a complete answer to the stated need — no new engine, no revived supervision machinery.

**Engine-access doctrine (the load-bearing decision → propose ADR-0004).** This spec MUST be accompanied by a new `docs/adr/0004-persistent-desktop-surface-and-engine-access.md`:

- The app **never mutates** the vault, the SQLite projection, or git directly.
- **Reads** → a **read-only** `better-sqlite3` handle on the projection DB, plus read-only git queries.
- **Anything touching *Atlas-managed* state** — vault working tree, git history, projection, LanceDB — → **spawn the `brain` CLI**. Every such mutation continues to flow through `runMutation` (lock → `HEAD == refs/heads/main` → validate → ground → dirty-check → apply → one commit per ChangePlan → refresh LanceDB then SQLite → release). The app never re-implements that path.
- Net: **exactly one writer path survives** for Atlas-managed state (the CLI); git history remains the sole audit and undo.

**Trade-offs acknowledged.**
- *Rejected: revive a daemon / `brain serve`.* Would directly contradict ADR-0003 and reintroduce a supervised background process, OS identities, and a privilege surface the pivot deliberately demolished. Rejected outright.
- *Rejected: the app opens the DB read-write and writes notes itself.* Faster for some future features, but creates a second writer, defeating one-commit-per-ChangePlan and the git-only undo. Rejected outright.
- *Chosen: persistent GUI + read-only reads + CLI-spawn for state.* Costs process-spawn latency per action (~hundreds of ms) and means the app cannot show anything the CLI does not expose. Accepted; both are cheap at this cadence.
- *Rejected for v1: grow the CLI surface with `brain config get/set`.* See `interfaces`.

**Assumptions (explicit).**
- The app ships inside the same monorepo build as `apps/cli`, so it can resolve the `brain` binary and `ATLAS_ROOT` deterministically from its own install layout.
- macOS-only. The Keychain and the menubar are both macOS-specific; ADR-0003's stated target is macOS.
- Single operator, single machine, one vault at a time.
- `brain status --json` and the exit-code set (`0/1/2/4/5`; `7` only from `jobs run`) are stable contracts owned by `apps/cli`.

**Unstated-dependency check.** The app depends on: `brain.config.yaml` + `AtlasConfigSchema`/`loadConfig` (`@atlas/cli`), the `brain` binary, the projection DB path (derived from config), the Keychain item `atlas-gemini-api-key`, the `status` JSON schema at `docs/specs/cli-contract/status.schema.json`, and `better-sqlite3` from the workspace `catalog:`. All exist today; none is invented here.

**Success criteria (objective).** v1 is correctly implemented when, on the owner's Mac:
1. With a healthy vault, the menubar glyph is green with the check-mark symbol, and its accessible label reads `Atlas: healthy`.
2. Breaking any one of the four checks (e.g. `mv` the vault, delete the Keychain item) flips the glyph to red or amber **within one poll interval** after the next completed poll **and** raises exactly one macOS notification per transition into that state.
3. `Restart Atlas` completes and refreshes the indicator, and `git status` in the vault plus the projection DB's `notes` row count are **byte/row-identical** before and after.
4. Editing the vault path, either model name, or setting the API key via the config form results in a `brain.config.yaml` that `loadConfig` accepts, and the corresponding check flips within one poll interval.
5. The Gemini key value never appears in the UI, in app logs, or in any file the app writes — verified by grep of the app's log output and `brain.config.yaml` after a set/replace.
6. `pnpm -r build`, `pnpm -r test`, and `node tools/gen-cli-contract.ts --check` stay green on both CI legs (`ubuntu-latest` and `macos-15`).

**Finalized vs open.** Finalized: the engine-access doctrine, the three capabilities, the state model, the read-only/CLI split, Keychain-only credentials, the Keychain account value. Open: the config-write mechanism detail, key-probe-on-save, and the amber auto-offer — all in `open-questions`.

## scope — Scope & Boundaries

**Tier: playground.** Single-user, single-machine, personal tooling on the owner's Mac. Absence of HA, multi-user auth, migration tooling, secret rotation, telemetry, code-signing/notarization ceremony, canary rollout, or 10x-scale capacity is **deliberate restraint**, not a gap. Adding any of those to v1 is out of scope.

**In scope for v1 — exactly three capabilities.**

| # | Capability | Contracted surface |
|---|---|---|
| 1 | Running indicator | Menubar glyph (3 states, shape+color), popover scoreboard of the four checks + last-checked time, interval poll (60 s default, tunable) + on-demand refresh, macOS notification on transition into a worse state |
| 2 | Restart Atlas | Tear down + re-initialize the engine session; non-destructive; refreshes the indicator |
| 3 | Configuration | Vault (`vault.path`, `vault.note_globs`), AI (`models.generation_model`, `models.embedding_model`), credential (set/replace the Keychain item; presence-only display) |

Plus the supporting scaffolding those three require: the `apps/desktop` workspace, the main/renderer split, the engine-session lifecycle, the read-only DB handle, the CLI-spawn wrapper, a login-item toggle (launch at login), and quit.

**Explicitly out of scope for v1 (named, not built).** Nothing below is implemented, reserved, or structurally anticipated — no UI slot, no module seam, no IPC channel, no schema:

- **Usage-metrics dashboard.**
- **Ask-a-question pane** (retrieval / synthesis UI).
- **Drag-and-drop / clipboard ingest.** v1 adds **no** ingest path, so it does not widen ADR-0003's accepted unsandboxed-ingest risk.
- **Embedded MCP host.**

**Also out of scope:** auto-update, crash reporting, multi-vault switching, running `sync` / `index rebuild` / any other mutating command from the UI (v1 spawns `brain status` only), Windows/Linux support, and app notarization/distribution beyond a locally-built `.app`.

**Anti-inflation notes.** The app introduces **no** new abstraction layer over the CLI beyond a single typed spawn wrapper and a single typed read-only DB accessor. There is no plugin system, no generic "command runner" framework, no state-management library mandated, no IPC schema registry. The status poll is a plain interval — no scheduler, no job queue. There is no offline cache of status; a failed poll is a failed poll.

**Constraint vs preference.** Hard constraints: macOS-only; no new writer path; no revived fortress machinery; Keychain-only for the secret; CI matrix stays green; `version 0.0.0` / `private: true`; deps via `catalog:` only. Preferences (not gates): the poll interval's 60 s default value, the specific glyph symbols, and the popover layout.

## interfaces — Interfaces & Contracts

The app introduces **no network API and no new CLI commands**. Its interfaces are: (a) the workspace/package surface, (b) the consumed `brain status --json` contract, (c) the consumed config schema, (d) the read-only DB access, (e) the internal main↔renderer IPC surface, (f) the Keychain interaction.

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
- All new deps (`electron`, `electron-rebuild` or equivalent) are pinned **once** in the root `catalog:` and referenced as `"electron": "catalog:"`. `better-sqlite3` is consumed from the existing catalog entry.
- Depends on `@atlas/cli` (workspace) for `AtlasConfigSchema` / `loadConfig` / the config path resolution, and on `@atlas/contracts` if shared DTOs are needed. It does **not** depend on `@atlas/sqlite-store`'s write paths.

### 2. Consumed: `brain status --json`

The **owner of this contract is `apps/cli`**, schema at `docs/specs/cli-contract/status.schema.json`. This spec does **not** restate the field list as a second authority. The app:

- Invokes `brain status --json` (argv exactly `["status", "--json"]`).
- Parses stdout as JSON and validates it against the shape the CLI schema declares; a parse/shape failure is treated as `red` with reason `status-unparseable` (see `behavior`).
- Consumes the `checks[]` entries named `vault-reachable`, `git-healthy`, `provider-key-present`, `index-not-stale`. **It invents no new checks.** If the CLI later adds a check, the app renders it in the scoreboard generically and folds it into health by the same rules.
- Interprets the process exit code per the CLI's `EXIT` set (`apps/cli/src/errors/envelope.ts` is the owner):

  | exit | app interpretation |
  |---|---|
  | `0` | status obtained; health from `checks[]` |
  | `1` | validation → `red`, surface the envelope `message` |
  | `2` | config/vault/lock → `red`, surface the envelope `message` (most common: bad config, unreachable vault, held lock) |
  | `4` | internal → `red`, surface `message`; if the envelope carries `retryable: true` + `retryAfterMs`, the next poll is scheduled at `max(retryAfterMs, pollInterval)` |
  | `5` | usage → `red`, reason `app-cli-mismatch` (the app built the wrong argv — a bug, surfaced as such) |
  | other / spawn failure / timeout | `red`, reason `cli-unreachable` |

  Exit `7` is not expected (only `jobs run` emits it); if seen, treat as `4`.

### 3. Consumed: config schema and file

- **Owner: `@atlas/cli`** — `AtlasConfigSchema` (zod) + `loadConfig`, and `brain.config.yaml` is the single owner of every path/threshold. The app **imports** these; it does not restate defaults.
- `DEFAULT_VAULT_PATH` (`~/Code/Vaults/main-vault`) and the model defaults (`gemini-3.5-flash`, `gemini-embedding-001`) are read from the schema/loader defaults, **never hardcoded in the app**.
- The app edits exactly these keys and no others:

  | Key | Type | Required | Notes |
  |---|---|---|---|
  | `vault.path` | string (absolute or `~`-prefixed path) | required | Subject to `ATLAS_EXPECT_VAULT` (below) |
  | `vault.note_globs` | string[] | optional | Edited as a list; empty list ⇒ omit the key rather than write `[]`, so the schema default applies |
  | `models.generation_model` | string | optional | Free text; validated only by the schema |
  | `models.embedding_model` | string | optional | Free text; validated only by the schema |

- **Writes are schema-validated round-trips.** The write path is: read the existing YAML → apply the edited keys → parse the resulting object with `AtlasConfigSchema` → **only if it parses**, serialize and write atomically (write temp file in the same directory, `fsync`, `rename`). Keys the app does not manage are preserved verbatim from the source document. A parse failure means **nothing is written**; the form shows the zod issue path + message.
- **File-access failure on the write path.** If the pre-write read of the existing file fails for any reason other than "not found" — `EACCES`, `EPERM`, `EISDIR`, `ELOOP`, `EIO`, or an unclassified error — the write is **refused** and `config:write` returns `ok: false, reason: 'config-unreadable'` with the OS error line as `message`. Nothing is written, and the app never falls back to writing a file composed only from the form's fields (which would silently drop the unmanaged keys it could not read).
- **`ATLAS_EXPECT_VAULT`**: if that env pin is set in the app's environment, `loadConfig` fail-closed-rejects a config whose `vault.path` canonicalizes elsewhere. The app therefore **pre-checks** the pin before offering to save, using the **same canonicalization helper the CLI's pin enforcement uses** (see `ssot`): if the candidate path canonicalizes away from the pin, the vault field is rejected in-form with the pin's value named, and no write is attempted. The pin is displayed read-only in the config window when set.
- **Idempotency:** a save that produces byte-identical YAML performs no write and reports "no changes". Repeated identical saves are therefore no-ops.

### 4. Read-only projection DB

- Opened with `better-sqlite3` in **read-only** mode (`{ readonly: true }`) at the path derived from the loaded config. No pragma that could write; no migration; no schema assumption beyond table existence checks.
- v1 reads **nothing** beyond an openability probe (`SELECT 1`). No table contents are surfaced. The handle exists because it is part of the readiness predicate.
- Open failure (missing file, corrupt, permissions, migration lock) ⇒ session state `degraded`/`broken` per `behavior`; it is never auto-repaired by the app.

### 5. Internal IPC (main ↔ renderer)

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

**Consistent mutation error semantics.** Every mutating channel (`config:create`, `config:write`, `config:revealInFinder`, `credential:set`, `app:setLoginItem`, `app:quit`) returns a result object — it never rejects on an expected failure. Each carries the same triple the UI envelope in §7 renders: a stable `reason` slug, a human `message`, and an optional `hint`. `ConfigWriteResult` additionally carries field-level `issues[]`; `LoginItemResult` additionally carries the OS-observed `enabled` state; the other mutating channels carry no extra fields. Only a programming error (a channel invoked with a request that fails its own type check) rejects, and that surfaces as `reason: 'app-internal'`.

**`config:read` never rejects either.** It is a read channel, but every failure mode of reading a file on disk is modelled as a `ConfigState` branch rather than a thrown error, so the form always has a branch to render.

Shared types (`src/shared/types.ts`):

```ts
type Health = 'healthy' | 'degraded' | 'broken';
type CheckStatus = 'pass' | 'warn' | 'fail';

interface CheckView {
  name: string;            // e.g. 'vault-reachable' — from the CLI, not enumerated here
  status: CheckStatus;
  detail?: string;         // human-readable, from the CLI
}

interface SessionSnapshot {
  health: Health;
  reason: string;          // stable slug, e.g. 'ok' | 'index-stale' | 'cli-unreachable'
  message: string;         // one-line human sentence; also the accessible label body
  checks: CheckView[];     // [] when the CLI could not be reached
  configLoaded: boolean;
  dbOpen: boolean;
  lastCheckedAt: string;   // ISO 8601, or the empty string before the first poll
  polling: boolean;        // true while a poll is in flight
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
       // parses as YAML but fails AtlasConfigSchema; `values` holds only the fields that
       // were individually readable, `issues` explains every field that is missing or bad

// Every field present — the shape of a config that passed AtlasConfigSchema.
interface ConfigValues {
  vaultPath: string;
  noteGlobs: string[];
  generationModel: string;
  embeddingModel: string;
}

// The `invalid` branch's best-effort subset. A key appears here ONLY when the parsed YAML
// held a value of the correct primitive type at that path; anything else is omitted rather
// than coerced or defaulted.
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
}

// Presence plus its provenance, so the form can state that an env override is in effect
// and that a set/replace will not take effect while it is set.
interface CredentialStatus {
  present: boolean;
  source: 'env' | 'keychain' | 'none';   // 'env' ⇒ ATLAS_GEMINI_API_KEY overrides the Keychain
}

// Read back from macOS on every call — the OS is the owner of this setting (see `ssot`).
interface LoginItemStatus {
  enabled: boolean;        // app.getLoginItemSettings().openAtLogin
  readable: boolean;       // false when the OS query itself failed
}

interface LoginItemResult extends OpResult {
  enabled: boolean;        // the state observed by re-reading the OS after the write
}

interface ConfigEdit {                       // every field optional; omitted = unchanged
  vaultPath?: string;
  noteGlobs?: string[];
  generationModel?: string;
  embeddingModel?: string;
}

interface ConfigWriteResult extends OpResult {
  changed: boolean;                          // false when the save was a no-op
  issues: ConfigIssue[];                     // zod issue paths on failure; [] on success
}
```

**`PartialConfigValues` rendering rule (why `invalid` is safe to render and edit).** A field omitted from `PartialConfigValues` renders as an **empty control marked invalid**, never as a schema default and never as a blank that looks legitimate — substituting a default would let a Save silently write a value the owner never typed. Every omitted field has a corresponding entry in `issues[]` (a missing-key or wrong-type issue at that path), so `invalid` can never render an unexplained empty field. Saving from this branch is still a full schema-validated round-trip: it either produces a file `AtlasConfigSchema` accepts, or writes nothing.

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

- **`config:create`** — writes a new `brain.config.yaml` from schema defaults at `ConfigView.path`. Valid **only** when the current state is `missing`. Called in `loaded` / `unparseable` / `invalid` it returns `ok: false, reason: 'config-exists'`; called in `unreadable` it returns `ok: false, reason: 'config-unreadable'`. In every non-`missing` case it writes nothing. It is never invoked implicitly — only from the explicit "Create config" action. Success ⇒ `ok: true, changed: true`, followed by the same immediate Restart a `config:write` triggers.
- **`config:revealInFinder`** — opens the containing directory with the file selected (Electron `shell.showItemInFolder`). Valid in every state including `missing` and `unreadable` (in which case it reveals the directory). Returns `ok: false, reason: 'reveal-failed'` with the OS message when the path cannot be shown.
- **`app:getLoginItem`** — returns the current OS setting, read fresh via `app.getLoginItemSettings()` on every call; the app persists no copy. If the OS query throws, it returns `{ enabled: false, readable: false }` — never a guessed `true` — and the toggle renders in an explicit "unknown" state rather than silently claiming "off".
- **`app:setLoginItem`** — calls `app.setLoginItemSettings({ openAtLogin: enabled })`, then **re-reads** the OS setting and returns what the OS actually reports. Failure semantics match every other mutating channel: it never rejects on an expected failure, and returns `ok: false` with a stable slug — `reason: 'login-item-write-failed'` when the write itself throws, and `reason: 'login-item-unverified'` when the write succeeded but the read-back disagrees with the requested value (e.g. blocked by a system policy). In both failure cases `enabled` carries the **observed** state, so the toggle reflects reality rather than the request, and the `message` is the OS error line or `"macOS reports launch-at-login is still <observed>"`. Idempotent: setting the value it already has returns `ok: true` and performs no observable change.
- **`app:quit`** — runs the shutdown sequence in `behavior` (close the DB handle, cancel any in-flight poll, clear the interval) and then terminates the app. It returns `OpResult` for symmetry and to surface a pre-quit failure; on the success path the renderer will normally never observe the response because the process exits. A teardown step that throws is logged and does **not** block termination — quit always terminates; it returns `ok: false, reason: 'quit-teardown-failed'` only in the case where it can still respond.

`credential:set` **has no getter that returns a value.** There is deliberately no channel that can return the secret; `credential:status` returns `CredentialStatus` — a boolean plus provenance, never the value.

### 6. Keychain

- **Read/presence**: `ATLAS_GEMINI_API_KEY` in the app's environment ⇒ `present: true, source: 'env'` (and the config window states that the env override is in effect and that set/replace will not take effect while it is set). Otherwise probe the Keychain item **without capturing the value into any variable that outlives the call** — presence is the exit status of `security find-generic-password -s atlas-gemini-api-key` (no `-w`, so the secret is not printed) ⇒ `source: 'keychain'` on success, `'none'` otherwise.
- **Set/replace**: `security add-generic-password -U -s atlas-gemini-api-key -a <account> -w` with the value passed on **stdin** (never as an argv element, which would expose it in the process table). A nonzero `security` exit ⇒ `OpResult { ok: false, reason: 'keychain-write-failed', message: <security stderr, one line> }`.
- **The `-a` account value is settled: the current login user.** It is resolved at runtime from Node's `os.userInfo().username` (equivalently `$USER` / `whoami`) — **never hardcoded**. On the target machine that resolves to `aryeh`, which matches the account on the **existing live Keychain item** (service `atlas-gemini-api-key`, account `aryeh`), so `-U` **updates that same item** (service + account both match) rather than creating a duplicate entry; deriving it from the login user generalizes correctly to any machine.
  - **SSOT:** a single `KEYCHAIN_ACCOUNT` constant in `src/main/keychain.ts`, initialized once from `os.userInfo().username`. No other module derives an account value, and the literal `aryeh` appears nowhere in the code.
  - Because **lookup is by service only** (`-s`, with no `-a`), the account participates in **no** read path — the CLI's key resolution and the app's presence probe both ignore it. It exists solely so that `-U` targets one stable item instead of forking a second one.
  - Edge case: if `os.userInfo()` throws (a userless execution context), `credential:set` returns `ok: false, reason: 'keychain-account-unresolved'` and writes nothing, rather than falling back to a guessed account that could create a duplicate item.
- The app **never** reads the secret value back, never renders it, never logs it, never places it in an IPC response.

### 7. Errors surfaced to the user

Every failure the app shows uses one envelope shape in the UI: a **reason slug**, a **one-line human message**, and where applicable a **remediation hint** (e.g. "vault not found at `<path>` — open Configuration to fix the vault path"). This is exactly the `OpResult` triple, so mutating-channel failures render without translation. CLI-originated failures reuse the CLI's own envelope `message` verbatim rather than paraphrasing it.

## behavior — Behavior & Correctness

### The state boundary (what "anything touching state" means)

The engine-access doctrine's "spawn `brain` for anything touching state" governs **Atlas-managed state**: the vault working tree, git history, the SQLite projection, and the LanceDB index. Those four are `runMutation`'s domain, and the app writes **none** of them — it holds a read-only DB handle, issues read-only git queries, and the only `brain` invocation v1 makes is the read command `status --json`.

`brain.config.yaml` is **not** Atlas-managed state. It is the *input* that tells `brain` which vault and models to use — it is read at process start by `loadConfig` and is not a projection of anything, not derived from the vault, not covered by a ChangePlan, and not part of the commit-per-mutation audit trail. Editing it produces no note, no commit, and nothing for `git revert` to undo. Consequently `config:create` / `config:write` are **not** a second writer of Atlas state and do not bypass `runMutation`; there is nothing in that path for them to bypass.

The boundary, stated once:

| State | Owner / writer | How the app touches it |
|---|---|---|
| Vault working tree, git history, projection contents, LanceDB | `brain` via `runMutation` — the sole writer | Never writes. Reads the projection read-only; reads git read-only |
| `brain.config.yaml` | The file itself, shape owned by `AtlasConfigSchema` | Writes directly, schema-validated and atomic (`interfaces` §3) |
| The Gemini credential | macOS Keychain | Presence-probed; set/replaced via `security` |
| Launch-at-login | macOS | Read back from the OS; no local copy |

The app's config write is safe without the mutation order because it takes no vault lock, needs no grounding, and cannot leave a derived store stale — it is a whole-file atomic replace validated by the same schema `brain` will validate it with on next launch. Its only concurrency exposure is another editor of the same file, addressed under *Configuration* below. **If v1 ever needed to change Atlas-managed state, it would spawn `brain` — no exception exists for that class, and none is granted here.**

### The engine session

"Atlas," as the app manages it, is an **engine session**: the supervised in-process runtime holding

(a) the loaded, validated `brain.config.yaml`; (b) the read-only projection DB handle; (c) the resolved-key **presence** state (never the value); (d) the validated vault; (e) the status poller.

**Initialization sequence** (also the Restart sequence):

1. Close the existing DB handle if any; cancel any in-flight poll (see *Poll cancellation* below) and clear the interval timer.
2. `loadConfig()` — on `ConfigError`, session is `broken`, reason `config-invalid`, message = the error's file+key text. **Stop here**; steps 3–5 are skipped and the config window is offered as the remediation.
3. Resolve key **presence** (env, else Keychain probe). Failure to probe is not fatal; it records `present: false, source: 'none'`.
4. Open the projection DB read-only and run `SELECT 1`. Failure ⇒ `dbOpen: false`.
5. Run one immediate `brain status --json` poll, then arm the interval timer at `POLL_INTERVAL_MS`.

**Health derivation** — one function, one owner (`src/main/health.ts`):

| Condition (first match wins) | Health | Reason |
|---|---|---|
| `configLoaded == false` | `broken` | `config-invalid` |
| CLI unreachable / spawn failure / timeout / unparseable output | `broken` | `cli-unreachable` \| `status-unparseable` |
| CLI exit ∈ {1, 2, 4, 5} | `broken` | from the envelope |
| any check `status == 'fail'` | `broken` | `check-failed:<name>` |
| `dbOpen == false` | `degraded` | `projection-unreadable` |
| any check `status == 'warn'` | `degraded` | `check-warn:<name>` (e.g. `check-warn:index-not-stale`) |
| otherwise | `healthy` | `ok` |

Health maps to the glyph as green = `healthy`, amber = `degraded`, red = `broken`.

### Polling

**The interval rule, stated once.** The poller runs on a single configurable interval whose **default is 60 s**, held as `POLL_INTERVAL_MS` in `src/main/constants.ts` (the SSOT) and explicitly tunable. The interval value is a **default, not a gate** — nothing in this spec depends on its magnitude.

**The detection guarantee is stated relative to the interval, never as an absolute wall-clock**: *a check that breaks is reflected in the snapshot within one poll interval — specifically, at the next completed poll.* Every other statement in this spec (success criterion 2 and 4, the live-drive steps, the acceptance criteria) is expressed in those terms; **no line asserts a hard ≤ 60 s bound**, because a slow-but-successful poll, an honored `retryAfterMs` backoff, or a tuned interval all legitimately move the wall-clock.

- On-demand refresh fires on: menubar/popover open, immediately after a Restart, immediately after a successful config write or credential set, and on wake from sleep.
- **Single-flight.** At most one `brain status` child process exists at a time. A refresh requested while a poll is in flight returns the in-flight promise; it does not spawn a second process.
- **Timeout: 15 s wall-clock**, measured from spawn. This is the value of `POLL_TIMEOUT_MS` in `src/main/constants.ts` (the same SSOT); it is a starting value, to be confirmed against a live p99 measurement of `brain status --json` on the real vault (see `open-questions`). On expiry the child is sent `SIGTERM`; if it has not exited **2 s** later (`POLL_KILL_GRACE_MS`, same SSOT) it is sent `SIGKILL`. The poll result is recorded as `broken` / `cli-unreachable`.
- **Fail-fast, no silent fallback.** A failed poll produces a `broken` snapshot with the real reason. The app does **not** retry-in-a-loop within a tick, does **not** fall back to the last-known-good snapshot as if it were current, and does **not** invent a "probably fine" state. `lastCheckedAt` always reflects the last *completed* poll so a stale scoreboard is visibly stale.
- The one exception to "no retry": an exit-`4` envelope carrying `retryable: true` + `retryAfterMs` schedules the *next* poll no sooner than `retryAfterMs`. That is honoring the CLI's own backoff hint, not masking an error — the current snapshot is still `broken`.

**Poll cancellation (supersession).** A poll can be cancelled only by a Restart. Cancellation is defined as:

1. The child process is terminated with the same `SIGTERM` → 2 s → `SIGKILL` escalation the timeout uses. The app does not wait on the child before proceeding with the Restart sequence; it does await the child's `exit`/`error` event before allowing a *new* poll to spawn, so the single-flight invariant holds across the boundary.
2. The superseded poll is marked cancelled at the moment of cancellation. **Its result is discarded unconditionally** — whether it arrives before or after termination, and regardless of exit code or stdout content. A cancelled poll never updates `health`, `reason`, `checks`, or `lastCheckedAt`, never emits `session:changed`, and never raises a notification. Late output from a cancelled child is not parsed.
3. Only the poll issued by the *current* session generation can update the snapshot. Each session init increments a generation counter; a poll result whose generation is not the current one is discarded by the same rule.

### Notifications

- A macOS notification is raised **only on a transition into a worse health state** (`healthy`→`degraded`, `healthy`→`broken`, `degraded`→`broken`) or when the set of failing/warning check names changes while already in a non-healthy state.
- **Exactly one notification per transition** — no repeat while the state persists. Recovery to `healthy` raises one notification too (so the owner learns it is fixed).
- Notification text is **self-contained** (no "see above"): title `Atlas`, body = the snapshot `message`, e.g. `Vault not reachable at ~/Code/Vaults/main-vault`.
- Notifications are suppressed for the very first poll after app launch when the result is `healthy` (no news is not news).

### Restart Atlas

- **Definition:** tear down and re-initialize the engine session — close the DB handle, cancel the in-flight poll, reload and re-validate config, re-resolve the key presence (env → Keychain), re-validate the vault, re-run `brain status`, re-arm the poller. Exactly the initialization sequence above.
- **Non-destructive, by construction:** the sequence spawns only `brain status --json` (a read command) and opens the DB read-only. It never touches the vault working tree, git, LanceDB, or projection contents. It is safe to click at any time, including while the vault is dirty or while a `brain` command is running in a terminal.
- **Concurrency:** Restart is single-flight. A Restart requested while one is running is ignored (the button is disabled with an announced busy state). A Restart cancels/supersedes any in-flight poll per *Poll cancellation* above — the superseded poll's child is terminated and its result discarded, so a slow pre-Restart poll can never land on top of the post-Restart snapshot.
- **Failure:** a Restart that fails at step 2 leaves the session `broken` with `config-invalid` — that is a successful *report* of a broken state, not a failed Restart. The button re-enables; nothing is left half-initialized (the DB handle from step 1 is already closed, and `dbOpen` is `false`).

### Configuration

- Opening the config window reads the current file and the pin/credential facts (`config:read`), and renders the branch of `ConfigState` it returns.
- **Validation is fail-fast and pre-write**: the edited object is parsed by `AtlasConfigSchema` and, when `ATLAS_EXPECT_VAULT` is set, checked against the pin. Failures render as field-level issues; **no partial write ever occurs** (the atomic temp-file + rename guarantees the file is never observed half-written).
- A successful write triggers an immediate session Restart (config is session state), then a refresh of the indicator.
- **Credential set/replace**: the field is write-only. On save the value goes to `security add-generic-password -U` via stdin, under the login-user account resolved per `interfaces` §6; on success the field is cleared, the UI shows `Key: present`, and an immediate refresh runs so `provider-key-present` re-evaluates. On failure the `OpResult` carries `reason: 'keychain-write-failed'` and the `security` stderr line (stderr is emitted by `security` and does not contain the value).
- **Per-state form behavior:**
  - `missing` ⇒ fields render with schema defaults, disabled for edit; the only action is **Create config** (`config:create`), plus Reveal in Finder. No silent write.
  - `unreadable` ⇒ the form is read-only with the OS error shown, offering **Reveal in Finder** and a retry of `config:read`; the app will not overwrite a file whose contents it could not read.
  - `unparseable` ⇒ the form is read-only with the parse error shown and a **Reveal in Finder** action (`config:revealInFinder`); the app will not overwrite a file it could not parse.
  - `invalid` ⇒ fields render from the readable subset, editable, with the offending fields marked from `issues[]`; saving is allowed because the save is a full schema-validated round-trip that either produces a valid file or writes nothing.
- Vault path pointing at a non-directory or a non-git directory ⇒ the write is allowed if the schema accepts it, but the next status poll will report the real failure — the app does not duplicate the CLI's vault validation.

### Other lifecycle behavior

- **Single instance.** A second launch focuses the existing instance and exits.
- **Login item** read via `app:getLoginItem` and toggled via `app:setLoginItem` (Electron `app.getLoginItemSettings` / `setLoginItemSettings`); macOS is the owner of that setting — the app stores no copy, and the toggle always renders the OS-observed value returned by the channel, including after a failed write.
- **Quit** (`app:quit`, and the same sequence on any OS-initiated termination) closes the DB handle, cancels any in-flight poll (same termination sequence), and clears the interval; there is nothing else to clean up. A teardown step that throws is logged and never prevents termination.
- **Sleep/wake:** the app subscribes to Electron's `powerMonitor` `'resume'` event; on wake it performs an **immediate on-demand refresh** rather than waiting out the remainder of the interval (the interval timer is also re-armed from that poll's completion). The refresh obeys single-flight like any other on-demand refresh.

### Observability (self-debugging level, not SRE-grade)

- The main process writes a plain line-oriented log to Electron's per-app user-data directory: one line per poll (`ISO timestamp, exit code, health, reason, duration_ms`), one per cancelled/timed-out poll (with which of the two it was), one per Restart, one per config write (keys changed — **never values**), one per credential set (`credential set: ok|error` — **never the value**), one per login-item change (requested vs observed), one per notification raised, one per wake-triggered refresh.
- Renderer console output is not persisted.
- **Log sanitization is a hard rule**: the credential value is never passed to any logging call, and config-write logging records key *names* only. A test asserts this (see `test-plan`).

## ssot — Single Source of Truth

Every value and rule the app touches has exactly one owner; the app consumes.

| Value / rule | Authoritative owner | How the app consumes it |
|---|---|---|
| Every path/threshold in Atlas config; the vault path; model names; the projection DB location | `brain.config.yaml`, validated by `AtlasConfigSchema` in `@atlas/cli` | Imports `AtlasConfigSchema` + `loadConfig`; never re-declares a field, type, or default |
| `DEFAULT_VAULT_PATH`, model defaults | The schema/loader defaults in `@atlas/cli` | Read from the schema; **not** restated in desktop code or in this spec's field table (the table names the keys, not their defaults) |
| The readiness predicate's four checks and their semantics | `apps/cli` `status` handler + `docs/specs/cli-contract/status.schema.json` | Consumes `checks[]`; the app **re-derives nothing** — it does not itself test the vault, git, or index staleness |
| **Provider-key presence** | `apps/cli`'s key-resolution routine (env `ATLAS_GEMINI_API_KEY`, else the Keychain item `atlas-gemini-api-key`) — the same routine that backs the `provider-key-present` check | **One implementation, exported from `@atlas/cli` and imported by the app** as a presence-only probe returning `CredentialStatus`. The desktop app does **not** write its own env-or-Keychain resolution. If the routine is not currently exported, exporting it (presence-only, never the value) is part of this work — the app must not fork it. `CredentialStatus` is a pre-first-poll convenience for the config window, computed by the CLI-owned routine; the poll's `provider-key-present` check remains the authority for the indicator, and the two cannot disagree because there is one implementation |
| **Keychain account for the set/replace (`-a`)** | **New value introduced here.** Owner: the `KEYCHAIN_ACCOUNT` constant in `src/main/keychain.ts`, initialized once at runtime from `os.userInfo().username` | Referenced only by the `security add-generic-password -U` invocation. Never hardcoded, never duplicated, never used on a read path (lookup is by `-s` service only), never mirrored into config or the renderer |
| Exit-code meanings | `apps/cli/src/errors/envelope.ts` (`EXIT`) | The spawn wrapper maps codes in one place, `src/main/cli.ts`; no other module inspects exit codes |
| The mutation order / one-commit-per-ChangePlan | `apps/cli/src/workflows/mutation-order.ts` (`runMutation`) | The app performs **no** mutation of Atlas-managed state, so it cannot drift from it |
| Command membership / names / flags | `docs/specs/cli-contract/commands.json` | The app spawns only commands present there; v1 spawns exactly `status --json` |
| Gemini key value | The macOS Keychain item `atlas-gemini-api-key` (or `ATLAS_GEMINI_API_KEY` when set, which the CLI treats as the override) | Presence-probed and set/replaced; **never copied, cached, mirrored into config, or held in app state** |
| Vault pin value | The `ATLAS_EXPECT_VAULT` env var, enforced by `loadConfig` | Read from the environment; enforced for real by `loadConfig` on the next session init |
| **Vault-pin canonicalization** (how a candidate path is normalized before comparison to the pin) | The **canonicalization helper `loadConfig`'s pin enforcement uses**, in `@atlas/cli` | **Imported and called** by the config form's pre-check. The app does **not** implement `~`-expansion, symlink resolution, or trailing-slash normalization of its own. If that logic is currently inline in `loadConfig`, extracting it into an exported helper is part of this work. The pre-check is a UX affordance running the *same* comparison the loader will run, so a pre-check pass followed by a loader rejection is impossible |
| Launch-at-login state | macOS (via `app.getLoginItemSettings`) | Read back from the OS on every `app:getLoginItem` and after every `app:setLoginItem`; no local copy persisted |
| Dependency versions | The root `catalog:` in `pnpm-workspace.yaml` | `"electron": "catalog:"` etc.; never a floating version in `apps/desktop/package.json` |
| Health-from-checks derivation | **New value introduced here.** Owner: `src/main/health.ts`, one exported function | Both the tray glyph and the popover scoreboard render from the single `SessionSnapshot` that function produces — the renderer never recomputes health from `checks[]` |
| Poll interval (`POLL_INTERVAL_MS`, default 60 s), poll timeout (`POLL_TIMEOUT_MS`), kill grace (`POLL_KILL_GRACE_MS`), notification-suppression rules | **New values introduced here.** Owner: `src/main/constants.ts` | Referenced by the poller and by tests; not duplicated into the renderer or into docs as literals. The detection guarantee is expressed **relative to** `POLL_INTERVAL_MS`, never as a wall-clock number, so tuning the constant cannot invalidate a stated bound |
| The current session state + the session generation counter | **New state introduced here.** Owner: the main process's single `EngineSession` instance | The renderer holds only a cached copy delivered via `session:changed`/`session:get`; it never derives or mutates session state. Reconciliation direction is strictly main → renderer |

**Deliberately not duplicated:** the app introduces **no new store, table, cache, or config file**. It reads the projection DB read-only and holds no persistent state of its own except the app-log file and Electron's own window-state — neither of which shadows Atlas data.

**Config write ownership.** The app writes `brain.config.yaml` but does not *own* it: the schema owns the shape, and every write is validated by that schema before landing. The app is one of two writers of that file (the other being the owner's editor); there is no lock, and last-write-wins is accepted at this tier — but the app always re-reads the file immediately before applying edits, so it cannot resurrect a stale copy of keys it does not manage.

## security — Security & Trust

**Trust model.** Consistent with **ADR-0003**: v2 has **no security boundary beyond git history** — single operator, single machine, personal vault. The desktop app **adds no new privilege boundary and no new writer** of Atlas-managed state. It runs as the invoking user with that user's full filesystem privileges, exactly as `brain` does. There is no network listener, no server, no IPC to any other user's process, no OS identity, no daemon, no launchd service. **No retired fortress machinery is revived** — no brokers, no scan gate, no ledger, no trust tiers, no capabilities, no signer.

**Trust boundaries that exist:**
1. **Renderer ↔ main.** The renderer is treated as the less-trusted side. `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, remote module off. The preload exposes only the closed channel list in `interfaces` — no generic "run this command" or "read this file" channel. Renderer inputs (config field values) are validated in main by `AtlasConfigSchema` before any write.
2. **App ↔ `brain` CLI.** Argv is constructed from a fixed literal (`["status", "--json"]`) — never from user input, never through a shell. The CLI is spawned with `shell: false` and an explicit argv array, so no string interpolation or injection surface exists. The binary path and `ATLAS_ROOT` are resolved from the app's own install layout, not from `PATH`, so a `PATH`-shadowed `brain` cannot be picked up.
3. **App ↔ Keychain.** `security` is likewise spawned with `shell: false` and an argv array; the secret travels on **stdin only**, never as an argv element (which would be world-readable in the process table). The `-a` account argument is the login username from `os.userInfo()` — a non-secret, machine-local value, not user-supplied text, so it introduces no injection surface even though it is interpolated into argv.

**Authentication / authorization.** None, by design and proportional to the tier: a local single-user GUI whose privileges are already the invoking user's. Adding an app-level passcode would protect nothing an attacker with that user's session could not already reach directly through the filesystem. The macOS Keychain's own ACL is the only access control in play, and it is the OS's to enforce.

**Data classification and handling.**

| Data | Class | Handling |
|---|---|---|
| Gemini API key | Credential | **Keychain-only.** Never rendered in the UI (presence boolean only), never written to disk, never in logs, never in git, never returned over IPC, never held in app state beyond the single write call's stdin. There is deliberately **no IPC channel that can return it.** |
| Vault note contents | Personal/proprietary | v1 reads **none** of it — the DB handle is opened read-only and only probed with `SELECT 1`. No note text reaches the renderer. |
| Config values (paths, model names) | Non-sensitive | Displayed and edited; logged by key name on write |
| Status check output | Non-sensitive | Displayed; may contain a vault path, which is logged |

**Secrets management.** Storage: macOS Keychain item `atlas-gemini-api-key` (or the `ATLAS_GEMINI_API_KEY` env override, which the CLI owns). Access: presence-probed via `security find-generic-password` **without `-w`**, so the value is never printed. Set/replace: `security add-generic-password -U` with the value on stdin, targeting the login-user account so the existing item is updated rather than duplicated. **Rotation is manual and out of scope** — a playground-tier decision; the app's set/replace *is* the rotation affordance.

**Encryption.** In transit: nothing leaves the machine — the app makes no network calls whatsoever (the Gemini calls are made by the CLI, in-process, when the owner runs a command). At rest: the credential is at rest only in the Keychain, which the OS encrypts. Vault and projection are plaintext on disk, unchanged from v2's existing posture (ADR-0003).

**Input validation.** Config edits are zod-validated pre-write. `brain status --json` output is parsed and shape-validated before use; malformed output is a `broken` state, not a crash and not a partially-trusted read. The renderer performs **no** `innerHTML`-style injection of CLI-derived strings — all CLI text is inserted as text nodes, so a hostile check `detail` cannot become markup.

**Least privilege.** The DB handle is `readonly: true`. Git access is read-only queries only. The app requests no macOS entitlements beyond notifications and login-item; no Full Disk Access, no camera/mic/contacts, no accessibility API. The app is never run with `sudo`.

**Audit.** git history remains the sole audit trail for vault state, and the app cannot write to it — so there is nothing new to audit there. The app-local log (poll results, restarts, config-key-name changes, credential-set outcomes) is a debugging aid, explicitly **not** a security ledger, and is sanitized as described in `behavior`.

**Residual risks (accepted, unchanged from ADR-0003 — do not re-add retired machinery to close them).**
- Agents write directly into the real brain; git history is the only undo. The app does not change this and does not weaken it (it adds no writer).
- Ingest is unsandboxed and unscanned. **v1 adds no ingest path**, so this surface is not widened. (When drag-drop ingest is later built, it *will* widen it, and that is a decision for that phase's ADR — not this one.)
- **New, accepted:** a persistent GUI process now runs continuously as the owner. It holds no secret in memory and opens no listener, so its resident attack surface is the Electron runtime itself. Accepted at playground tier.

## test-plan — Test Plan

**Strategy.** Unit + integration via **vitest** in `apps/desktop` (`pnpm -r test` picks it up). The main-process logic is deliberately factored so that health derivation, exit-code mapping, the poller/session lifecycle, the single-instance gate, config writing, and log sanitization are **pure/injectable modules testable without launching Electron** — the CLI spawn, the `security` spawn, `powerMonitor`, the login-item API, and the `app` object's single-instance surface (`requestSingleInstanceLock` / `on('second-instance')` / `quit`) are all injected fakes, and timers are vitest fake timers. Electron-window E2E is **not** automated in v1 (playground tier); the window and menubar are covered by the mandatory **live drive**, which is the integration backstop for every stubbed dependency. Both CI legs must stay green, so every automated test must be platform-neutral or explicitly macOS-gated.

**Acceptance criteria per capability** are the six numbered success criteria in `intent`; each maps to at least one test or live-drive step below.

### Automated — health derivation (`src/main/health.ts`)

Table-driven, one case per row of the health table, each asserting `health` **and** `reason`:

| Input | Expect | Breaks silently without this test |
|---|---|---|
| all four checks `pass`, config loaded, db open | `healthy` / `ok` | — |
| `index-not-stale` = `warn`, rest pass | `degraded` / `check-warn:index-not-stale` | A warn silently rendering green; the owner never learns the index is stale |
| `vault-reachable` = `fail` | `broken` / `check-failed:vault-reachable` | A missing vault showing amber, not red |
| `dbOpen: false`, all checks pass | `degraded` / `projection-unreadable` | A corrupt projection reading fully healthy |
| `configLoaded: false` (plus otherwise-passing input) | `broken` / `config-invalid` — **precedence**: config wins over every check | A broken config being masked by stale check data |
| both a `fail` and a `warn` present | `broken` (fail dominates) | A red condition downgraded to amber |
| `checks: []` with CLI unreachable | `broken` / `cli-unreachable` | An empty check list vacuously satisfying "no check failed" ⇒ **green with zero evidence**. This is the highest-value single test in the plan. |

### Automated — exit-code mapping (`src/main/cli.ts`)

One case per code in the table in `interfaces`, driven by a stubbed spawn. Plus:
- exit `0` with **non-JSON stdout** ⇒ `broken` / `status-unparseable` (not a thrown exception, not a crash).
- exit `0` with JSON of the **wrong shape** (e.g. `checks` missing) ⇒ `status-unparseable`.
- exit `4` with `retryable: true, retryAfterMs: N` ⇒ snapshot is `broken` **and** the next poll is scheduled ≥ N. *(Breaks silently: the app hammering a backing-off CLI every interval.)*
- spawn `ENOENT` ⇒ `cli-unreachable`, no unhandled rejection.
- a poll exceeding `POLL_TIMEOUT_MS` ⇒ `SIGTERM` sent; a child that ignores it gets `SIGKILL` after `POLL_KILL_GRACE_MS`; the result is `cli-unreachable`. *(Breaks silently: a hung `brain` pinning the glyph on a stale green forever.)*
- **argv assertion**: the wrapper spawns exactly `["status","--json"]` with `shell: false`. *(Breaks silently: a shell-interpolated argv, i.e. the injection surface `security` claims does not exist.)*

### Automated — polling & notification rules

All cases use **fake timers**; assertions about detection are expressed **relative to `POLL_INTERVAL_MS`** (advance the fake clock by that constant), never against a literal 60 000 ms — so retuning the constant cannot break the suite or invalidate the guarantee.

- **Single-flight**: two refreshes issued while one poll is in flight ⇒ exactly **one** spawn. *(Breaks silently: N overlapping `brain` processes on a slow vault.)*
- **Interval detection guarantee**: with a stub whose result flips from healthy to a failing check, advancing the clock by `POLL_INTERVAL_MS` and letting the poll complete ⇒ the snapshot reflects the failure. Advancing by less than the interval with no poll in flight ⇒ the snapshot is unchanged. *(Breaks silently: an armed-but-never-firing interval, i.e. an indicator frozen on the launch-time state.)*
- `healthy`→`degraded`→`degraded` ⇒ exactly **one** notification. *(Breaks silently: a notification every interval until the owner disables notifications entirely.)*
- `degraded`→`broken` ⇒ a second notification; `broken`→`healthy` ⇒ a recovery notification.
- Non-healthy with the failing-check **set changing** (`{vault}` → `{vault, git}`) ⇒ a new notification.
- First poll after launch returning `healthy` ⇒ **zero** notifications.
- `lastCheckedAt` advances only on a *completed* poll. *(Breaks silently: a scoreboard that looks fresh while every poll is failing.)*

### Automated — single instance

Covers the "a second launch focuses the existing instance and exits" claim in `behavior` → *Other lifecycle behavior*. The Electron `app` single-instance surface is injected as a fake exposing `requestSingleInstanceLock()`, `on('second-instance', …)`, `quit()`, and a `show/focus` spy for the existing window.

- **`lock denied ⇒ the process quits without initializing`**: with `requestSingleInstanceLock()` returning `false`, assert `app.quit()` is called and that the session **never initializes** — no DB open, no `brain status` spawn, no interval armed, no tray created, no `security` invocation. *(Breaks silently: two live instances each polling on their own interval and each holding a config form — doubled `brain status` processes, duplicate notifications for every transition, and two concurrent last-write-wins writers of `brain.config.yaml`, which is exactly the concurrency exposure `ssot` accepts only because there is one app writer.)*
- **`lock granted ⇒ normal init, and the second-instance handler is registered`**: with the lock returning `true`, assert the session initializes exactly once and a `'second-instance'` handler is registered exactly once. *(Breaks silently: the gate "passing" by never wiring the handler, so a second launch spawns a real second app.)*
- **`second-instance event focuses, it does not re-init`**: emit `'second-instance'` on the fake and assert the existing window is shown/focused **and** that the session generation counter is unchanged, no additional DB handle is opened, no additional interval is armed, and no additional `brain status` spawn occurs. *(Breaks silently: every re-launch stacking another poller onto the same process — the "why is it spawning four `brain`s" failure with no visible second window to explain it.)*
- **`repeated second-instance events are idempotent`**: N emissions ⇒ N focus calls, still one session, still one interval.

### Automated — wake-from-sleep refresh

Covers the `powerMonitor` `'resume'` claim in `behavior` → *Other lifecycle behavior*. `powerMonitor` is injected as a fake event emitter; timers are fake.

- **`wake triggers an immediate poll`**: arm the session, let the first poll complete, then advance the fake clock by a **small fraction of `POLL_INTERVAL_MS`** (e.g. 10%, far from the next tick), emit `'resume'`, and assert a `brain status` spawn occurs **at resume + ε** — i.e. within the same tick, with no further clock advance and with the interval timer demonstrably not yet due (assert the remaining timer delay is still > 0). *(Breaks silently: after every lid-close the glyph shows a pre-sleep state for up to a full interval — the single most common way the indicator is wrong exactly when the owner looks at it.)*
- **`wake refresh obeys single-flight`**: emit `'resume'` while a poll is already in flight ⇒ **no second spawn**; the in-flight poll's result is used.
- **`wake re-arms the interval from the wake poll`**: after the wake-triggered poll completes, assert the next scheduled tick is `POLL_INTERVAL_MS` from that completion, not from the pre-sleep schedule. *(Breaks silently: a double-cadence poller after each wake, or a timer that fires immediately on top of the wake poll.)*
- **`no resume subscription leak`**: a session Restart does not accumulate `'resume'` listeners — assert the listener count on the fake `powerMonitor` is 1 after N restarts. *(Breaks silently: N polls fired per wake after N restarts.)*

### Automated — poll cancellation on Restart

Covers the supersession claim in `behavior` → *Poll cancellation*. The CLI spawn is a controllable fake whose child exit and stdout delivery are driven manually by the test.

- **`restart terminates the in-flight child`**: a Restart issued mid-poll ⇒ the in-flight child receives `SIGTERM`, and a child that does not exit receives `SIGKILL` after `POLL_KILL_GRACE_MS` (advanced on the fake clock). *(Breaks silently: orphaned `brain` processes accumulating on every restart.)*
- **`restart supersedes the in-flight poll — late result is fully discarded`** (the named lifecycle test): start a poll and hold its result; trigger `session:restart` while it is in flight; then deliver the superseded poll's stdout + exit **after** the restart. Assert, for the superseded result specifically: `health`, `checks`, `reason`, and `lastCheckedAt` are **unchanged by it**, **no** `session:changed` is emitted for it, and **no** notification fires from it. Run the case in **both orderings** — the stale result arriving before the post-Restart poll completes, and after it — and assert the post-Restart snapshot survives in both. *(Breaks silently: clicking Restart on a broken vault shows green, then flips back to red seconds later from a zombie poll — the exact bug that makes the indicator untrustworthy.)*
- **`single-flight holds across the restart boundary`**: during the same scenario, assert that at **no point do two `brain status` children exist concurrently** — the new session's poll is spawned only **after** the old child's `exit`/`error` event has been observed. Drive it by delaying the old child's `exit` and asserting the spawn count stays at 1 until that event fires, then becomes 2. *(Breaks silently: the restart doubling `brain` processes and, on a slow vault, racing two pollers.)*
- **`stale generation is discarded without a signal`**: a poll result carrying a **stale generation counter** is discarded by the generation rule even when the process was never signalled — proving the generation check, not just the kill, is load-bearing.

### Automated — restart-on-config-change

Covers the "a successful write triggers an immediate session Restart, then a refresh of the indicator" claim in `behavior` → *Configuration*. Fake timers; the config file lives in a temp dir; the CLI spawn is stubbed.

- **`successful config:write restarts immediately, with no clock advance`**: with the session healthy and idle, call `config:write` with a valid edit, then — **without advancing the fake clock at all** — assert the session generation counter incremented by exactly one, the previous DB handle was closed and a new one opened, and a new `brain status` spawn occurred. Assert further that the interval timer's remaining delay before the write was still large (near a full `POLL_INTERVAL_MS`), proving the new poll came from the write and not from a due tick. *(Breaks silently: the owner fixes a bad vault path in the form, the save reports success, and the glyph stays red for up to a full interval — the form reads as broken and the owner re-saves or restarts by hand, exactly the friction the config surface exists to remove.)*
- **`the restarted session reads the new config`**: the post-write session's `loadConfig` observes the just-written values (assert via the injected loader receiving the new file contents, and the new DB handle opening at the path derived from the new config). *(Breaks silently: a restart that re-uses the in-memory config it already had, so the change appears to take effect only after a full app relaunch.)*
- **`successful config:create restarts identically`**: from the `missing` state, `config:create` success ⇒ the same immediate restart (one generation increment, one new poll, no clock advance). *(Breaks silently: the create path being the one route that leaves the session pointing at nothing.)*
- **`a failed config:write triggers no restart`**: an invalid edit, a `config-exists` create, and a `config-unreadable` refusal each ⇒ `ok: false`, generation counter **unchanged**, no new DB handle, **no** new spawn. *(Breaks silently: a rejected save still tearing the session down and re-polling, so a typo in the form churns the indicator and the log.)*
- **`a no-op save triggers no restart`**: a save producing byte-identical YAML ⇒ `changed: false` and no restart. *(Breaks silently: opening the form and pressing Save with nothing typed restarting the engine every time.)*
- **`successful credential:set refreshes but does not restart`**: `credential:set` success ⇒ exactly one immediate poll with no clock advance, and the generation counter **unchanged** (a refresh, not a restart — the DB handle is not recycled). *(Breaks silently: either a needless full teardown on every key entry, or no refresh at all, leaving `provider-key-present` red until the next tick.)*
- **`restart-on-write is single-flight-safe`**: a config write issued while a poll is in flight ⇒ the in-flight child is superseded per the cancellation rules and exactly one poll exists afterwards. *(Breaks silently: two concurrent pollers after a save on a slow vault.)*

### Automated — config read & write (`src/main/config-read.ts`, `src/main/config-write.ts`), against a temp dir

**Read — every `ConfigState` branch, proving the mapping is total:**
- Valid file ⇒ `state.kind === 'loaded'` with all four `ConfigValues` fields populated.
- No file (`ENOENT`) ⇒ `state.kind === 'missing'`.
- File present but unreadable — simulate `EACCES` (and, separately, an `EISDIR` where the path is a directory) ⇒ `state.kind === 'unreadable'` carrying the errno and the OS message; **`config:read` does not reject**, and the branch is distinct from `missing`. *(Breaks silently: a permission problem being reported as "no config", the form offering **Create config**, and the app then either failing confusingly or — worse, if the write path did not also refuse — clobbering a file it could not read.)*
- An error with no `errno` ⇒ `state.kind === 'unreadable'` with `errno: 'UNKNOWN'`, still no rejection.
- Unparseable YAML ⇒ `state.kind === 'unparseable'` carrying the parser message.
- Parses but fails the schema ⇒ `state.kind === 'invalid'`; and specifically: a file where `vault.path` is valid but `note_globs` is a number ⇒ `values.vaultPath` is present, `values.noteGlobs` is **absent** (not `[]`, not the schema default), and `issues[]` contains an entry at the `note_globs` path. *(Breaks silently: the form rendering a fabricated default in a field the file never set, so a Save writes a value the owner never chose — the precise hazard of typing the branch with a fully-required `ConfigValues`.)*
- **Every omitted `PartialConfigValues` key has a matching `issues[]` entry** — assert over several malformed files that `issues[]` explains each absent field. *(Breaks silently: an unexplained blank field the owner reads as "not set" rather than "unreadable from your file".)*

**Write:**
- Valid edit ⇒ file written, and re-reading it through `loadConfig` **succeeds** (round-trip, not just "we wrote bytes").
- **Invalid edit** (e.g. `note_globs` given a non-string element) ⇒ `ok: false`, issues populated, and the on-disk file is **byte-identical** to before. *(Breaks silently: a half-validated write bricking the config and, with it, every `brain` command.)*
- **Unmanaged keys preserved**: a config containing keys the app does not manage survives a vault-path edit verbatim. *(Breaks silently: the app silently deleting config the owner set by hand.)*
- **No-op save**: identical values ⇒ `changed: false` and the file's mtime is unchanged.
- **Write refused on an unreadable file**: with the pre-write read failing `EACCES` ⇒ `ok: false, reason: 'config-unreadable'`, nothing written, and no file created. *(Breaks silently: a write composed only from the form's fields, silently dropping every unmanaged key.)*
- **`ATLAS_EXPECT_VAULT` pin**: with the pin set and a candidate path that canonicalizes elsewhere ⇒ rejected pre-write, nothing written, the pin value named in the issue. Also cover the case where the candidate differs textually but canonicalizes **to** the pin (symlink / trailing slash / `~` expansion) ⇒ accepted. Assert the pre-check calls the **CLI-exported canonicalization helper** (`ssot`), not a local copy. *(Breaks silently: the app writing a config that `loadConfig` will fail-closed reject, leaving Atlas unusable with a confusing exit 2.)*
- **Atomicity**: a simulated failure between temp-write and rename leaves the original intact and no stray temp file in a state the loader would read.
- **No Atlas-state write**: assert the config-write path touches only the config file — it opens no git process, spawns no `brain` (beyond the post-write restart's own poll), and writes nothing under the vault path. *(Breaks silently: a future refactor letting the config form mutate the vault outside `runMutation`, violating the state boundary in `behavior`.)*
- Missing config file ⇒ no implicit write; only `config:create` writes, and `config:create` in a `loaded`/`unparseable`/`invalid` state ⇒ `ok: false, reason: 'config-exists'`, in an `unreadable` state ⇒ `ok: false, reason: 'config-unreadable'`, nothing written in either case.
- Unparseable existing YAML ⇒ write refused, nothing written. *(Breaks silently: clobbering a config the owner was mid-edit on.)*

### Automated — credential handling (the security-relevant tests)

- `credential:set` passes the value on **stdin**, and the argv array provably contains no element equal to the value. *(Breaks silently: the API key visible in `ps` output to every process on the machine.)*
- **Keychain account**: the `add-generic-password` argv contains `-a` followed by the value of `os.userInfo().username` (the injected fake's username), and the literal string `aryeh` appears nowhere in the source. Also assert `-U` is present, so an existing item is updated. *(Breaks silently: a duplicate Keychain item under a second account, making "replace" update the wrong entry while the CLI keeps reading the old one.)*
- **`os.userInfo()` throwing** ⇒ `credential:set` returns `{ ok: false, reason: 'keychain-account-unresolved' }` and **no `security` process is spawned**. *(Breaks silently: a guessed fallback account creating a duplicate item.)*
- The presence probe invokes `security find-generic-password` **without `-w`** and **without `-a`** (lookup is by service only). *(Breaks silently: the secret printed to a captured stdout and thence into a log or a crash report; or a probe that misses the item because it over-constrains on account.)*
- **`security` nonzero exit on set** (stub `add-generic-password` exiting `1` with a stderr line, e.g. a denied Keychain ACL) ⇒ `credential:set` resolves `{ ok: false, reason: 'keychain-write-failed' }` with the stderr line as `message`, the error is surfaced in the config form, and the credential state is **not** flipped to present. *(Breaks silently: the owner sees "Key: present" after a Keychain write that never landed, then every model call fails with no obvious cause.)*
- **`security` nonzero exit on the presence probe** (stub `find-generic-password` exiting nonzero) ⇒ `CredentialStatus` is `{ present: false, source: 'none' }` — never `present: true` on an unproven probe, and never a thrown exception. Combined with the check above, this is the credential failure path end to end: a failing security command can neither report the key as present nor crash the session. *(Breaks silently: a probe failure being read as success, so the indicator claims the key is there when it is not.)*
- **No IPC channel returns the secret**: an assertion over the exported channel/handler map that no handler's response type or runtime value contains the credential; `credential:status` returns only `CredentialStatus`.
- **Log sanitization**: feed a known sentinel value through `credential:set` (both the success and the nonzero-exit path) and a config write, capture the logger, and assert the sentinel appears **nowhere** in the emitted lines; assert config-write lines contain key names and not values. *(Breaks silently: the key sitting in plaintext in the app-log file forever.)*
- `ATLAS_GEMINI_API_KEY` set ⇒ presence is `{ present: true, source: 'env' }` without any Keychain call, and the UI-facing view reports that the env override is in effect.

### Automated — login item and quit channels

- `app:getLoginItem` returns the OS-reported value, read fresh on each call; a stubbed `getLoginItemSettings` that throws ⇒ `{ enabled: false, readable: false }`, no rejection. *(Breaks silently: an unreadable setting rendering as a confident "off" the owner then toggles pointlessly.)*
- `app:setLoginItem` with the write succeeding and the read-back agreeing ⇒ `{ ok: true, enabled: <requested> }`.
- `app:setLoginItem` with `setLoginItemSettings` throwing ⇒ `{ ok: false, reason: 'login-item-write-failed' }` carrying the OS message, `enabled` = the observed state, and **no rejection**. *(Breaks silently: an unhandled rejection in the renderer, and a toggle that shows "on" while login-at-launch is off.)*
- `app:setLoginItem` where the write returns cleanly but the read-back disagrees ⇒ `{ ok: false, reason: 'login-item-unverified', enabled: <observed> }`. *(Breaks silently: the exact "I toggled it and it silently didn't take" failure, invisible until the next reboot.)*
- Setting the value already in effect ⇒ `ok: true`, idempotent, no error.
- `app:quit` runs the full teardown (handle closed, poll terminated, interval cleared) before termination; a teardown step that throws is logged and termination still proceeds. *(Breaks silently: an app that refuses to quit because one cleanup step threw.)*

### Automated — session lifecycle

- Restart from a healthy session ⇒ the old DB handle is closed exactly once, a new one is opened, and the poller interval count stays at one. *(Breaks silently: leaked handles and doubled pollers after a few restarts — the classic "why is it spawning four `brain`s".)*
- Restart while `config-invalid` ⇒ terminates at step 2 with `dbOpen: false`, no exception, button re-enabled.
- Restart is single-flight: a second concurrent request does not start a second sequence.
- **Non-destructiveness by construction**: assert the set of commands the restart sequence can spawn is exactly `{brain status --json, security find-generic-password}` — no mutating command is reachable. *(Breaks silently: a future refactor slipping `brain sync` into the restart path and mutating the vault on a button the spec promises is safe.)*
- Quit ⇒ handle closed, in-flight poll terminated, interval cleared.

### Automated — renderer

- The scoreboard renders from the delivered `SessionSnapshot` and **never recomputes** health from `checks[]` (assert the renderer module exports no health-derivation function and imports the shared type only).
- Each `ConfigState` branch renders its specified form: `missing` ⇒ Create-config action only; `unreadable` ⇒ read-only with the OS error, Reveal-in-Finder and retry, **no Create-config action**; `unparseable` ⇒ read-only with the parse error and Reveal-in-Finder; `invalid` ⇒ editable with the flagged fields marked and any absent field rendered empty (never defaulted); `loaded` ⇒ normal edit.
- The login-item toggle renders the value returned by the channel, including after an `ok: false` result (it shows `enabled` as observed, not as requested).
- CLI-derived strings are inserted as text, not markup — a `detail` containing `<img onerror=…>` renders literally.
- Accessibility assertions are listed under `accessibility`.

### Automated — repo-level gates (must not regress)

- `pnpm -r build` and `pnpm -r test` green on **both** `ubuntu-latest` and `macos-15`. The desktop package's tests must therefore skip (with an explicit, visible skip reason) any case that requires macOS — Keychain, notification, and login-item cases are macOS-gated; health/exit-code/poller/wake/cancellation/single-instance/config-read/config-write/restart-on-write/lifecycle cases are platform-neutral (all their dependencies are injected fakes) and run everywhere.
- The `better-sqlite3` **Electron native rebuild** must be gated so the ubuntu portability leg never attempts it, and app packaging is macOS-only. A CI run on ubuntu that fails on a native rebuild is a plan failure, not a flake.
- `node tools/gen-cli-contract.ts --check` still passes — v1 adds **no** command, so `commands.json` must be unchanged. A test or the existing gate proves the 24-command surface did not grow.
- The existing `no-retired-reference.test.ts` gate must pass with the new package in tree (no reference to retired v1 subsystems).

### External dependencies — real vs doubles

`brain`, `security`, `powerMonitor`, the login-item API, and the Electron single-instance lock are **stubbed/injected** in automated tests — deterministic, fast, and CI-portable, at the cost of not proving the real contracts (a real `SIGTERM` on a real `brain`, a real macOS sleep/wake, a real Keychain ACL prompt, a real double-launch of the packaged `.app`). That gap is closed by the live drive, which is why the live drive is a mandatory delivery step rather than optional.

### Live drive (mandatory, on the real Mac — "test live" house rule; NOT CI)

Run against the real `main-vault`, the real `brain` binary, and the real Keychain. Each step records observed evidence:

1. Launch; glyph green; accessible label reads `Atlas: healthy`; scoreboard shows four passing checks and a fresh `lastCheckedAt`.
2. `mv` the vault aside → by the next completed poll (within one poll interval) the glyph turns red, exactly one notification fires with a self-contained message; restore the vault → recovery notification, glyph green.
3. Delete the Keychain item → `provider-key-present` fails, glyph red; re-set the key through the config form → glyph green; confirm via `security find-generic-password -s atlas-gemini-api-key` that **exactly one** item exists (no duplicate under a second account), and grep the app log for the key value → **zero hits**.
4. Click Restart on a healthy session; capture `git -C <vault> status --porcelain` and `SELECT count(*) FROM notes` before and after → identical.
5. Click Restart while the vault is dirty and again while a `brain` command is running in a terminal → no error, no interference, no lock contention. Also click Restart during a deliberately-slowed poll and confirm no stale result lands afterwards and no orphan `brain` process survives (`pgrep -f 'brain status'` → empty).
6. Edit the vault path to a bogus value → save → the glyph goes red **promptly on the post-save restart, without waiting for the next tick** (confirm in the app log that a restart + poll line follows the write line immediately); edit back → green, again immediately.
7. With `ATLAS_EXPECT_VAULT` exported, attempt a vault path elsewhere → rejected in-form with the pin named; nothing written (verify by file mtime).
8. Edit `models.generation_model`, save, then run `brain` in a terminal and confirm it loads the new config without a `ConfigError`.
9. `chmod 000` the config file and reopen the config window → the form renders the **unreadable** branch with the OS error, offers Reveal in Finder, and offers **no** Create-config action; restore permissions and retry → the form recovers. Confirm nothing was written while unreadable (file mtime unchanged).
10. Toggle launch-at-login; confirm the toggle's rendered state matches `osascript`/System Settings; log out and back in; confirm the app starts and the glyph settles green. Toggle back off and confirm the item is removed.
11. Measure `brain status --json` wall-clock over ~20 runs on the real vault and confirm `POLL_TIMEOUT_MS` sits comfortably above the observed p99 (resolves the timeout open question).
12. **Real sleep/wake**: close the lid (or `pmset sleepnow`), break a check while asleep, wake → confirm the glyph updates from a wake-triggered poll promptly rather than after a full idle interval, and that exactly one poll fired on wake (check the app log).
13. **Real double-launch**: with the app running, launch it again from Finder → the existing menubar item is focused/shown, no second menubar glyph appears, `pgrep` shows exactly one app process, and the app log shows **no** second session init and no doubling of the poll cadence.
14. Full VoiceOver + keyboard-only pass (see `accessibility`).
15. Build and launch the packaged `.app`; confirm it resolves the `brain` binary and `ATLAS_ROOT` correctly outside a `pnpm dev` context, and repeat step 13 against the packaged build (the single-instance lock is the one behavior most likely to differ between `pnpm dev` and a real `.app`).

**Not specified (proportional to tier):** load/perf tests (there is no throughput claim), migration/rollout tests (no data migration, no feature flags, no canary — playground posture), and staging-parity tests (there is one environment: the owner's Mac).

## accessibility — Accessibility

The app has a real user-facing surface — menubar glyph, popover/status window, config form, notifications — so this section is **normative**, and the bar is high.

**Target: WCAG 2.2 AA** for all text and meaningful non-text content, in **both light and dark menubars** and in both light and dark app appearance.

### Menubar glyph

- **Never color-alone.** The three states are distinguished by **shape/symbol first, color second**: healthy = a **check**, degraded = a **caret/exclamation**, broken = a **cross**. The symbol must be legible at menubar size (template-image rendering so it inverts correctly on dark and light menubars).
- Carries an **accessible label and tooltip stating the state in words**, e.g. `Atlas: healthy`, `Atlas: degraded — index stale`, `Atlas: unreachable — vault not found`. The label is the snapshot's `message`, so it is always specific, never just "error".
- Contrast: the glyph's rendered form must meet the ≥ 3:1 non-text contrast bar against both menubar backgrounds.

### Popover / status window

- **Fully keyboard operable.** The popover opens with the keyboard, takes focus on open, has a logical tab order (checks → Restart → Configuration → Quit), and **dismisses with Escape** returning focus sensibly. Nothing is reachable by mouse only.
- **Visible focus indicator** on every interactive element, meeting the non-text contrast bar; the system focus ring is not suppressed.
- **Semantic HTML first, ARIA only where HTML is insufficient.** The scoreboard is a real list or table with a programmatic association between each check's **name** and its **state** — each row announces name + state + detail (e.g. "index-not-stale, warning, index is 3 commits behind"). State is conveyed textually, not by a colored dot alone; each row carries a status symbol as well as a color.
- The **Restart** button is a real `<button>`, announces its name, and announces its **busy/disabled state** while a restart is in flight (via `aria-busy`/`aria-disabled` and a text status, not by graying alone).
- **Live-region announcements** for asynchronous change: when a poll completes and the health state changes, a polite live region announces the new state and reason. It is polite, not assertive, and it does not fire on every unchanged poll (no announcement spam).
- **Headings and landmarks**: the status window uses a correct heading hierarchy and named regions so VoiceOver rotor navigation is useful.

### Configuration form

- Every field is a labeled form control with a **programmatically associated `<label>`** — no placeholder-as-label.
- **Errors are programmatically associated with their field** (`aria-describedby` to the message, `aria-invalid` on the control) and are announced when they appear; the message text names the field and the remediation, not just "invalid".
- The credential field is `type="password"`, write-only, and its purpose and behavior are stated in associated help text ("the value is stored in the macOS Keychain and never displayed"). Its **presence indicator** ("Key: present" / "Key: not set") is text, not an icon alone.
- The launch-at-login control is a real labeled checkbox/switch whose checked state is the OS-observed value; when a set fails, the associated error message states the observed state in words.
- The `ATLAS_EXPECT_VAULT` pin, when set, is announced as a read-only constraint associated with the vault field.
- Save/cancel are keyboard-reachable; **Return** submits, **Escape** cancels with no write.
- **Text scaling / zoom**: layout survives 200% zoom without loss of content or functionality; no fixed-height clipping.
- **Touch targets** are not a primary concern (no touch surface on macOS), but click targets are ≥ 24×24 CSS px and generously padded.

### Notifications

- Delivered through the **native macOS notification center**, so they inherit system accessibility (VoiceOver announcement, notification-center review, Do-Not-Disturb honoring).
- Text is **self-contained**: no "see above", no reference to UI state the listener cannot see.

### System preferences

- **`prefers-reduced-motion`** is respected: no popover animation, no spinner rotation, no transition on state change when it is set — state changes are instantaneous.
- **`prefers-color-scheme`** and macOS **Increase Contrast** are respected; the app does not hardcode a single-theme palette.
- No information is conveyed by color alone **anywhere** in the app (checks, key presence, and glyph all carry a symbol and text).

### Verification

Accessibility is verified two ways: (a) **automated** — renderer tests assert label association, `aria-invalid`/`aria-describedby` wiring on error, the live region's presence and politeness, the reduced-motion branch, and the presence of a non-color state indicator on every status row; (b) **live** — a full **VoiceOver + keyboard-only** pass in the live drive, driving all three capabilities end-to-end without touching the mouse, plus a contrast check of the glyph on light and dark menubars.

## open-questions — Open Questions

Each is stated concretely enough that resolving it yields a decision. Owner is the repo owner (Aryeh) unless noted; all are non-blocking for drafting the plan, and each names the phase by which it must be settled.

1. **Config-write mechanism — recommendation stated, confirmation needed.**
   *Recommended:* import `AtlasConfigSchema` + `loadConfig` from `@atlas/cli` and write a schema-validated `brain.config.yaml` from the app, reusing the single config owner. This is consistent with the state boundary in `behavior` — the config file is CLI *input*, not Atlas-managed state — so it does not create a second writer of vault/git/projection state.
   *Rejected alternative:* add a minimal `brain config get`/`brain config set` command pair. Cost: it touches the 24-command CLI-contract SSOT (`commands.json`), requires a new fixture line and schema file per command, and must clear the registry↔fixture↔schema bijection gates plus `contract-lint.test.ts` and `command-registration.test.ts` — a meaningful surface expansion for a v1 whose only writer of that file is a local GUI. It would, however, put the write behind the same contract every other command lives under, and would let a terminal user do the same edit.
   *Decision needed by:* start of phase 3 (the configuration surface). **Owner: repo owner.**

2. **Should credential set/replace verify the key with a probe call before saving?**
   A probe would catch a typo'd key immediately rather than at the next `brain` invocation, but it makes the app perform a **network call to Gemini** — which v1's security section currently states it never does — and it would need a model/endpoint to probe against. *Leaning:* no probe in v1; rely on `provider-key-present` plus the owner's next real command. If yes, the `security` section's "the app makes no network calls" claim must be amended in the same change.
   *Decision needed by:* start of phase 3. **Owner: repo owner.**

3. **Should amber on `index-not-stale` offer to run `index rebuild`?**
   Purely advisory in v1 (current spec position) vs an in-popover action. Running it would make the app spawn its **first mutating command**, which is doctrinally fine (it goes through the CLI and `runMutation`, per the state boundary in `behavior`) but expands v1's scope and needs progress/cancel UI for a long-running command. *Leaning:* advisory only in v1.
   *Decision needed by:* start of phase 1 (it affects the popover layout). **Owner: repo owner.**

4. **Confirmation of `POLL_TIMEOUT_MS` against a live measurement.**
   The spec sets `POLL_TIMEOUT_MS = 15_000` and `POLL_KILL_GRACE_MS = 2_000` in `src/main/constants.ts` (the SSOT) so the behavior is fully specified. Open only as a *tuning* question: live-drive step 11 measures `brain status --json` wall-clock on the real `main-vault`, and if the observed p99 is not comfortably below 15 s, the constant is adjusted in that same phase. `POLL_INTERVAL_MS` stays at its 60 s default unless the live drive shows a reason to change it; because every guarantee is stated relative to the interval, retuning either constant invalidates nothing.
   *Decision needed by:* the phase-1 live check. **Owner: implementer, informed by the live measurement.**

5. **Presence-probe and pin-canonicalization exports from `@atlas/cli`.**
   `ssot` requires the app to *import* the CLI's key-presence resolution and its vault-pin canonicalization rather than fork them. Unresolved: whether those are currently exported, and if not, the exact shape of the extraction (a presence-only wrapper that never returns the value; a `canonicalizeVaultPath` helper lifted out of `loadConfig`). Both extractions are internal refactors of `@atlas/cli` with no CLI-surface change, so they do not touch `commands.json`.
   *Decision needed by:* start of phase 1 (presence probe) and phase 3 (canonicalization). **Owner: implementer.**

6. **`brain` binary + `ATLAS_ROOT` resolution in the packaged `.app`.**
   In-repo (`pnpm dev`) resolution is straightforward. For a packaged `.app`, it must be settled whether the CLI's `dist/` is bundled into the app's resources (and `ATLAS_ROOT` pointed at the bundled `docs/specs/cli-contract/` tree) or whether the app resolves a repo checkout on disk. The second is simpler and honest for a playground, but makes the `.app` non-portable off the owner's machine.
   *Decision needed by:* the packaging step at the end of the phase sequence. **Owner: repo owner.**

7. **Concurrent config edits (app vs. the owner's editor).**
   The spec accepts last-write-wins with a re-read immediately before applying edits. Unresolved: whether the config window should additionally watch the file and warn when it changed underneath an open form. *Leaning:* out of scope for v1; note it.
   *Decision needed by:* phase 3, decidable at implementation time. **Owner: implementer.**

8. **ADR-0004 title and scope wording.**
   The ADR must state the persistent-desktop-surface decision **and** the engine-access doctrine (read-only reads, CLI-spawn for Atlas-managed state, one surviving writer, config-file writes explicitly outside that boundary), and must explicitly state that it does **not** supersede or weaken ADR-0003. Whether it is one ADR or two (surface vs. doctrine) is open; *leaning:* one, since the doctrine is the reason the surface is acceptable.
   *Decision needed by:* the first PR (the ADR lands with phase 1). **Owner: repo owner.**

9. **`better-sqlite3` Electron native-rebuild approach.** *(Named as the one real build risk, not a design unknown.)*
   The module's ABI is tied to the Node version and must be rebuilt for Electron's bundled Node. Open: `electron-rebuild` vs. a prebuilt binary, and exactly how the rebuild step is gated so the **ubuntu portability leg never attempts it** and `pnpm install --frozen-lockfile` stays clean on both legs. This must be proven green on both CI legs in phase 1, not discovered at packaging time.
   *Decision needed by:* phase 1. **Owner: implementer.**