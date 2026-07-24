# Atlas Desktop (`@atlas/desktop`) — Implementation Plan

*Plan — 2026-07-24 · `docs/plans/2026-07-24-atlas-desktop-app-plan.md` · **playground tier** · from [`docs/specs/2026-07-24-atlas-desktop-app-spec.md`](../specs/2026-07-24-atlas-desktop-app-spec.md) + [ADR-0004](../adr/0004-persistent-desktop-surface-and-engine-access.md) · 6 phased PRs, merge-when-green.*

## 1. Overview

**Approach: readiness first, then interaction, then surface polish.** The single non-negotiable ordering constraint is that the app must be a **pure `brain status` client** end-to-end (ADR-0004) before any interactive capability is added — the readiness predicate is the whole product, and every later capability (restart, config, launch-at-login) hangs off the engine session that Phase 1 stands up. So Phase 1 stands up the workspace, the engine session, the CLI-spawn wrapper, the health/severity derivation, the poller, and the menubar indicator behind injected fakes, plus the first `@atlas/models` export. (ADR-0004 and this plan land in their own docs PR — a prerequisite, not a phase.) Phases 2–4 add the three remaining capabilities (restart+lifecycle, configuration, launch-at-login) on that session. Phase 5 makes the normative accessibility surface real. Phase 6 packages the `.app` and runs the mandatory live drive — the integration backstop for every stubbed dependency.

**Key architectural decisions (made by the spec + ADR-0004, honored here):**
- **Pure `brain status` client — no direct read of Atlas-managed state.** The app holds **no** `better-sqlite3` handle and issues **no** direct git query; readiness comes only from `brain status --json`. `@atlas/desktop` therefore declares **no native dependency** and neither CI leg performs a native rebuild (a gate asserts this — §2.5).
- **One writer, one reader.** Atlas-managed state is written only by `brain` via `runMutation` and read for readiness only by `brain status`. `brain.config.yaml` is CLI *input*, not Atlas-managed state, so `config:*` writes are not a second writer and bypass nothing.
- **Five CLI checks, binary `ok`, app-owned severity.** `brain status` emits five checks (`vault-reachable`, `git-healthy`, `provider-key-present`, `index-not-stale`, `migrations-current`) as binary `{name, ok, detail}`. The app owns a `CHECK_SEVERITY` map (`src/main/health.ts`) that derives `warn`/`fail` from `ok` — `index-not-stale` + `migrations-current` ⇒ amber, the other three ⇒ red, unknown names ⇒ red. It re-runs no check.
- **Four capabilities.** Running indicator, Restart Atlas, Configuration, Launch-at-login. Launch-at-login is a first-class capability (not scaffolding), with its own success criterion.
- **Everything main-side is injectable.** Health derivation, exit-code mapping, poller/session lifecycle, single-instance gate, config read/write, credential module, `powerMonitor`, login-item API, and the Electron single-instance surface are all injected fakes in tests, with vitest fake timers. Electron-window E2E is **not** automated in v1 — the live drive (Phase 6) is the backstop.
- **Three upstream extractions from the CLI packages** land where first needed, each an internal refactor with **no** CLI-surface change (so `commands.json` never moves): the `@atlas/models` presence probe (Phase 1), the `@atlas/models` `setGeminiApiKey` write helper + service-id/`KEYCHAIN_ACCOUNT` ownership (Phase 3), and the `@atlas/cli` `canonicalizeVaultPath` helper lifted out of `loadConfig`'s pin enforcement (Phase 3).

**Six phases, each an independently-green, independently-mergeable PR** (mirrors the spec's four capabilities + a11y + packaging):

| # | Phase | Delivers | Gate | Effort |
|---|---|---|---|---|
| 1 | Scaffold + readiness indicator (capability 1) | `apps/desktop` workspace, engine session, CLI-spawn wrapper, health/`CHECK_SEVERITY`, poller, menubar glyph + popover scoreboard; `@atlas/models` presence probe | suite green both legs; **no native dep**; `contract:check` unchanged | L |
| 2 | Restart + lifecycle (capability 2) | Restart, single-instance, quit, sleep/wake, poll cancellation/supersession, post-mutation reconciliation, config-generation coherence, backoff rule | lifecycle + cancellation + coherence tests green | M |
| 3 | Configuration surface (capability 3) | `config:read/write/create` (CST YAML, pin pre-check), credential set/replace; `@atlas/models.setGeminiApiKey` + `@atlas/cli.canonicalizeVaultPath` exports | config round-trip + pin + credential + IPC-validation tests green | L |
| 4 | Launch-at-login + notifications + observability (capability 4) | login-item toggle + failure semantics, notification rules, app-log + sanitization, IPC runtime validation | login-item + notification + sanitization tests green | M |
| 5 | Accessibility | menubar glyph rendering, keyboard/focus, live regions, semantic scoreboard, config-form a11y, reduced-motion/contrast/zoom | automated a11y assertions green | M |
| 6 | Packaging + live drive | `.app` bundle with a **standalone `brain` artifact** (launcher + production dependency closure + contracts), mandatory live drive on the real Mac | packaged `.app` spawns the self-contained CLI with no repo checkout on `PATH`; live-drive evidence recorded (human-run) | M |

## 2. Prerequisites

- Node ≥ 24, pnpm **11.15.0** (the pin gotcha — a broken 11.12.0 exited 127/1). CI is Node 26.
- **The docs PR carrying ADR-0004 + this plan is merged to `main`** (the reviewed spec landed in #355). That merge is a hard prerequisite for filing the phase issues and for all six implementation PRs.
- The real vault at `~/Code/Vaults/main-vault` and the Keychain item `atlas-gemini-api-key` (account `aryeh`) exist on the owner's Mac — Phase 6's live drive uses both. No onboarding recurs.
- `brain status --json` + the exit-code set (`{0,1,2,4,5}`; `7` only from `jobs run`) + `status.schema.json` are stable `apps/cli` contracts (do not modify them for the app).

**Parallelizable (after the docs prerequisite merges):** Phase 5 (a11y) drafting can begin against the spec any time, but merges after the surfaces it covers exist (Phases 1–4).

## 2.5 Global Constraints

Every task's requirements implicitly include this section. Values are copied verbatim from the spec / repo constitution.

- **Tier:** playground. Single-user, single trusted machine (the owner's Mac), single trusted operator, one vault at a time. No HA, multi-user auth, rotation, telemetry, notarization ceremony, or 10×-scale — their absence is the point.
- **Platform:** **macOS only.** The Keychain and menubar are macOS-specific. The `ubuntu-latest` runner is a **portability canary** for the platform-neutral suite: Keychain / notification / login-item tests are macOS-gated (with a visible skip reason); health / severity / exit-code / poller / coherence / wake / cancellation / single-instance / config-read / config-write / restart / lifecycle / IPC-validation tests are platform-neutral (injected fakes) and run everywhere.
- **No native dependency.** `@atlas/desktop` depends on **no** `better-sqlite3` and no other native addon; **neither CI leg performs a native rebuild** and `pnpm install --frozen-lockfile` stays clean on both. A test asserts the desktop `package.json` declares no native dependency. (Electron is fetched as a prebuilt binary; app packaging is macOS-only.)
- **Toolchain:** TypeScript **strict / ESM / NodeNext** (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `isolatedModules`); compile with `tsc`. Narrow types over `any`. `src/shared/` imports no Node/Electron. Bash: `set -euo pipefail`, lowercase-with-dashes filenames.
- **Deps** pinned **once** in the root `catalog:` (`electron`, the `yaml` document library if not already cataloged); packages reference `"electron": "catalog:"`. Never a floating version in `apps/desktop/package.json`.
- **CI** (`.github/workflows/ci.yml`): `ubuntu-latest` + `macos-15`, Node 26; `pnpm install --frozen-lockfile` → `pnpm -r build` → `pnpm -r test` → `node tools/gen-cli-contract.ts --check`. **v1 adds no command**, so `commands.json` is unchanged and `contract:check` must stay green; a gate proves the 24-command surface did not grow. The existing `no-retired-reference.test.ts` gate must pass with the new package in tree.
- **Consumed contracts (do not restate/modify):** `brain status --json` + `status.schema.json` (owner: `apps/cli`); the exit-code set `{0,1,2,4,5}` + `7` from `jobs run` (owner: `apps/cli/src/errors/envelope.ts`); `AtlasConfigSchema` (`.strict()`) + `loadConfig` + `DEFAULT_VAULT_PATH` + model defaults (owner: `@atlas/cli`). The app **imports** these; it restates no field, type, or default.
- **Credential:** Keychain item `atlas-gemini-api-key`, mediated **only** through the `@atlas/models` credential module (presence probe + `setGeminiApiKey`); service id + `KEYCHAIN_ACCOUNT` (from `os.userInfo().username`, never the literal `aryeh`) owned there. The key value never reaches the UI, disk, logs, app state, or an IPC response (the sole argv exposure is the documented `security -w <value>` residual, ADR-0004).
- **App-owned SSOT values introduced here** (each has exactly one owner): `CHECK_SEVERITY` + the health function (`src/main/health.ts`); `POLL_INTERVAL_MS` (default 60 s) / `POLL_TIMEOUT_MS` (15 s) / `POLL_KILL_GRACE_MS` (2 s) / `nextEligiblePollAt` (`src/main/constants.ts`); the `EngineSession` state + generation counter + config fingerprint. Detection guarantees are expressed **relative to** `POLL_INTERVAL_MS`, never a wall-clock literal.
- **Version/authorship:** `version 0.0.0`, `private: true`. **Commits authored `Aryeh Stark <aryeh@21stark.com>`.** **Branch + PR for everything — no direct-to-main.** Every review finding posted on the PR (inline or summary). Update the relevant `CLAUDE.md` in the same change (the new `apps/desktop/CLAUDE.md` is required by house rules; the root map gets a row).

## 3. Phases

---

### Phase 1 — Scaffold + readiness indicator (capability 1) · L

**Delivers.** The `apps/desktop` workspace and the entire readiness path, testable without launching Electron; the first `@atlas/models` export. (ADR-0004 + this plan land in **their own docs PR**, which is a prerequisite — see §2 — not a Phase 1 task.)

**Tasks.**
1. **Workspace scaffold.** `apps/desktop/` (`package.json` name `@atlas/desktop`, `version 0.0.0`, `private true`; `tsconfig.json` extends `../../tsconfig.base.json`; `src/main/`, `src/renderer/`, `src/shared/`; `CLAUDE.md`). Add `electron` (+ the `yaml` doc library) to the root `catalog:`. Wire `pnpm -r build`/`test`. **Gate the Electron/native surface so the ubuntu leg never rebuilds anything** and `--frozen-lockfile` stays clean; add the "no native dependency" assertion test.
2. **CLI-spawn wrapper (`src/main/cli.ts`).** Spawn exactly `["status","--json"]`, `shell: false`, binary + `ATLAS_ROOT` resolved from the app's own layout (dev: sibling `apps/cli` build; packaged path deferred to Phase 6). Map exit codes in one place per interfaces §2 (incl. exit 5 → `app-cli-mismatch`; `retryable`+`retryAfterMs` on exit 4 → `nextEligiblePollAt`). Parse+shape-validate stdout; malformed ⇒ `status-unparseable`. Timeout (`POLL_TIMEOUT_MS`) → SIGTERM → SIGKILL after `POLL_KILL_GRACE_MS`.
3. **Health + severity (`src/main/health.ts`).** `CHECK_SEVERITY` map; one exported function producing a `SessionSnapshot` from `checks[]` + `configLoaded`. Table-driven tests (every health-table row, incl. `checks:[]`→`cli-unreachable`, unknown-check→fail, config-precedence, fail-dominates-warn).
4. **`@atlas/models` presence probe export.** A presence-only wrapper returning `CredentialStatus` (`present` + `source ∈ {env,keychain,none,unknown}`) — env else `security find-generic-password -s <service>` (no `-w`, no `-a`); item-not-found ⇒ `none`, other failure ⇒ `unknown`. Internal refactor, no CLI-surface change.
5. **Engine session + poller (`src/main/session.ts`).** Init sequence (load config → probe key presence → immediate poll → arm interval); single-flight poll; `lastCheckedAt` on completed polls only; the generation counter. (Restart, cancellation, coherence, reconciliation are Phase 2 — here just the forward path.)
6. **Menubar indicator (`src/main/tray.ts` + `src/renderer/`).** Glyph (green/amber/red) from the snapshot; popover scoreboard rendering the five checks + `lastCheckedAt`; on-demand refresh on popover open. Renderer renders from the delivered snapshot and **recomputes no health/severity**.

**Gate.** `pnpm -r build` + `pnpm -r test` green on **both** legs; no native rebuild on ubuntu; `contract:check` unchanged; `no-retired-reference` passes. **Resolves spec open-question:** the `@atlas/models` presence-probe extraction. **Live-check (informational):** measure `brain status --json` p99 on the real vault to confirm `POLL_TIMEOUT_MS` (spec open-question — implementer, may tune the constant this phase).

---

### Phase 2 — Restart + lifecycle (capability 2) · M

**Delivers.** Restart Atlas and the full session lifecycle on top of Phase 1's forward path.

**Tasks.**
1. **Restart** = the init sequence, single-flight; increments the generation counter; spawns only `status`/`security find-generic-password` (a "non-destructiveness by construction" test asserts the reachable command set). Non-destructive: `brain status` is lock-free, safe while the vault is dirty or a `brain` command runs.
2. **Poll cancellation / supersession.** Cancel on Restart **or** shutdown; Restart supersedes (SIGTERM→SIGKILL grace) and a superseded poll's result is discarded unconditionally (both orderings) — no `session:changed`, no notification, no `lastCheckedAt`. Stale-generation results discarded even when unsignalled. Single-flight holds across the restart boundary (new poll spawns only after the old child's `exit`/`error`).
3. **Post-mutation reconciliation.** A config write during an active Restart sets a **pending** Restart (not dropped); a credential set during an in-flight poll awaits a refresh that begins **after** the write; full Restart > refresh; callers await the final snapshot.
4. **Config-generation coherence — fenced on both sides of the poll.** Snapshots carry `configGeneration`. The pre-poll fingerprint comparison alone is **not** sufficient: the config can change *during* a poll, so `brain status` (which reads the config itself at spawn) could return a result describing config B while the session still stamps it generation A. The rule is therefore a **fence**: capture the fingerprint immediately before spawn, and **re-check it when the result arrives** — if the fingerprint (or the session generation) changed while the poll was in flight, **discard the result** (no snapshot update, no `session:changed`, no notification, no `lastCheckedAt`) and Restart instead. Tests must cover drift injected *mid-poll*, not just pre-poll.
5. **Backoff rule.** `nextEligiblePollAt` gates automatic (interval + wake) polls at `max(retryAfterMs, POLL_INTERVAL_MS)`; user-initiated refreshes bypass it.
6. **Single instance / quit / sleep-wake.** Single-instance lock (lock-denied ⇒ quit without initializing; `second-instance` focuses, does not re-init; idempotent); quit teardown (cancel poll, clear interval; a throwing step never blocks termination); `powerMonitor` `resume` ⇒ immediate refresh (subject to backoff), interval re-armed from that poll, `resume` subscription registered once (no leak across Restarts).

**Gate.** Lifecycle + cancellation (both orderings) + coherence + reconciliation + single-instance + wake tests green on both legs.

---

### Phase 3 — Configuration surface (capability 3) · L

**Delivers.** The config window and credential set/replace, with the two remaining upstream extractions.

**Tasks.**
1. **`@atlas/cli` `canonicalizeVaultPath` export** — lift the pin-canonicalization out of `loadConfig`'s enforcement into an exported helper (internal refactor, no CLI-surface change). The config form's pin pre-check and `config:create` call it, so a pre-check pass followed by a loader rejection is impossible.
2. **`@atlas/models` `setGeminiApiKey` + service-id/`KEYCHAIN_ACCOUNT` ownership** — a write-only helper (`security add-generic-password -U -s <service> -a <account> -w <value>`, `shell:false`); rejects empty/whitespace up front; `KEYCHAIN_ACCOUNT` from `os.userInfo().username` (`os.userInfo()` throwing ⇒ `keychain-account-unresolved`, nothing spawned). Documented argv residual (ADR-0004).
3. **`config:read` — total `ConfigState` mapping.** Five branches (`loaded`/`missing`/`unreadable`/`unparseable`/`invalid`); never rejects. `ConfigView` carries `defaults` + `createCandidate` (from the schema) so the renderer shows defaults without duplicating them. Absent-optional renders default-marked (no phantom issue); present-but-wrong renders empty + `issues[]`.
4. **`config:write` — CST round-trip.** Parse to a `yaml` Document, edit only managed nodes, materialize + validate with `AtlasConfigSchema`, stringify + atomic write (temp+fsync+rename). Comments/order/unmanaged keys preserved verbatim; byte-identical ⇒ `changed:false`, no write. Pre-write re-read; pre-write read failure (non-ENOENT) ⇒ `config-unreadable`, nothing written. Pin pre-check via the helper.
5. **`config:create`** — only from `missing`; seeds `vault.path` from the pin when set; runs the shared pin pre-check (`pin-conflict` ⇒ nothing written); `config-exists`/`config-unreadable` in other states.
6. **Credential set/replace + `credential:status`.** Write via `setGeminiApiKey`; on success clear the field, show `Key: present`, immediate refresh (not a Restart). `credential:status` returns `CredentialStatus` only (never the value; no channel can return it). `unknown` provenance rendered as "presence unknown".
7. **IPC surface + shared invocation wrapper.** The closed channel set (`src/shared/ipc.ts`); `contextIsolation:true`/`nodeIntegration:false`/`sandbox:true`. The wrapper runtime-validates each request; a malformed payload OR a handler/transport rejection returns that channel's declared shape with `reason:'app-internal'` and type-valid zero fields (validation short-circuit of `app:setLoginItem` ⇒ `enabled:false`). No expected call rejects.
8. **Config window renderer.** Per-`ConfigState` branch behavior; a successful write triggers exactly **one** Restart = one poll; CLI/config text inserted as text nodes (no markup injection).

**Gate.** Config round-trip (incl. comment/order/unmanaged preservation, note_globs clear-omits-key, no-op, atomicity, pre-write re-read under concurrent edit) + pin + credential (empty-key, account-unresolved, three-valued probe, and **secret-containment as actually specified**: the value never appears in an **IPC response**, in logs, on disk, in persistent app/UI state, or in any argv **other than** the documented `security -w <value>` call — it legitimately travels in the write-only `credential:set` IPC *request* and in that one `security` argv, per ADR-0004's accepted residual) + IPC-validation tests green. **Resolves spec open-questions:** the `setGeminiApiKey` + `canonicalizeVaultPath` extractions.

---

### Phase 4 — Launch-at-login + notifications + observability (capability 4) · M

**Delivers.** The fourth capability plus the notification and logging surfaces.

**Tasks.**
1. **Launch-at-login (`app:getLoginItem` / `app:setLoginItem`).** Read fresh each call (`readable:false` on OS-query throw, never a guessed `true`); write then re-read; `login-item-write-failed` / `login-item-unverified` / `login-item-readback-failed` (with `readable`) per interfaces §4; idempotent; a labeled real checkbox rendering the OS-observed (or "unknown") value.
2. **Notifications.** On any transition to a different health level (worse **and** recovery-to-healthy) or a failing/warning check-set change while non-healthy; exactly one per transition; self-contained text; first-poll-healthy suppressed.
3. **Observability + sanitization.** Line-oriented app log with the `app start: lock=acquired|denied` process-start marker (once per process, the single-instance oracle), `session restart: gen=<n>`, per-poll/cancel/timeout/config-write(keys only)/credential-set(ok|error)/login-item/notification/wake/fingerprint-drift lines. **Hard rule:** the credential value never reaches a logging call; a test asserts the sentinel is absent **and** each required event line is emitted.

**Gate.** Login-item (incl. readback-failure) + notification (incl. recovery + check-set-change) + sanitization/required-line tests green (macOS-gated where OS-bound, with visible skip reason on ubuntu).

---

### Phase 5 — Accessibility · M

**Delivers.** The normative accessibility surface (WCAG 2.2 AA, light/dark/Increase-Contrast).

**Tasks.**
1. **Menubar glyph** — shape-first (check/caret/cross), non-template light/dark image variants so color survives while shape conveys state independently; accessible label + tooltip = the snapshot `message`; ≥3:1 non-text contrast on both menubar backgrounds.
2. **Popover** — keyboard-openable via the menu-bar path; initial focus on Restart; Escape returns focus to the menubar item; scoreboard rows are **not** tab stops (semantic list / rotor order); tab order Restart→Configuration→Launch-at-login→Quit; visible focus rings; polite live region announcing on health/reason/check-set change and on user-refresh completion, silent on unchanged background polls; heading hierarchy + landmarks.
3. **Config form** — labeled controls (no placeholder-as-label); `aria-invalid`/`aria-describedby` on errors; `type="password"` write-only credential field with help text + text presence indicator; labeled login-item switch; pin announced as a read-only constraint; Return submits / Escape cancels; 200% zoom without clipping; ≥24×24 targets.
4. **System prefs** — `prefers-reduced-motion` (instantaneous state changes), `prefers-color-scheme` + Increase-Contrast respected; no color-alone anywhere.
5. **Automated a11y assertions** — label association, aria wiring, live-region presence/politeness + fire/suppress rules, reduced-motion branch, non-color state indicator per row, tab order excludes scoreboard rows, no fixed pixel heights that clip at 200%.

**Gate.** Automated a11y assertions green (the VoiceOver + zoom + contrast passes are in Phase 6's live drive).

---

### Phase 6 — Packaging + live drive · M

**Delivers.** A locally-built `.app` and the mandatory live drive — the integration backstop for every stubbed dependency.

**Tasks.**
1. **Packaging + resolution — a standalone `brain` artifact, not a bare `dist/` copy.** `apps/cli` builds with plain `tsc` and resolves workspace packages (`@atlas/contracts`, `@atlas/sqlite-store`, `@atlas/models`, …) plus external deps through the pnpm store, so copying `dist/` alone yields a **non-runnable** CLI. Phase 6 must therefore produce a self-contained artifact: the `bin.js` entrypoint, its **production dependency closure** (workspace packages + externals resolved to real directories, not pnpm symlinks into the repo), and the `docs/specs/cli-contract/` tree — placed in the `.app` `Resources` and, if `asar` is used, **unpacked** (a spawned child cannot execute from inside an `asar`). The app spawns that entrypoint with Electron's bundled Node (`ELECTRON_RUN_AS_NODE`) so **no host Node/pnpm is required**, and points `ATLAS_ROOT` at the bundled contract tree (dev resolves the sibling repo build). Absent/unrunnable resources ⇒ `cli-unreachable` + reinstall hint. **Verification is a real launch, not a file-exists check:** the packaged `.app` must run `brain status --json` successfully with the repo checkout renamed/off `PATH`. (Resolves spec open-question #2: packaging topology mechanics.)
2. **Live drive (human-run, on the real Mac — NOT CI).** Execute the spec's live-drive steps, recording observed evidence: healthy launch; vault-mv → red + one notification + restore recovery; index-stale/pending-migration → amber; delete/re-set the key → green + exactly-one-item oracle + zero key hits in app log **and** `brain.config.yaml`; Restart non-destructiveness (`git status` + `notes` count identical); Restart while dirty / mid-command / mid-slow-poll (no stale result, no orphan `brain`); bogus vault path → red on the post-save restart; pin rejection; both model edits load without `ConfigError`; note_globs add/clear; `chmod 000` → unreadable branch; launch-at-login toggle + logout/login; `POLL_TIMEOUT_MS` p99 confirmation; real sleep/wake; real double-launch (two oracles: main-process-only count + one `lock=acquired`); packaged-`.app` resolution + double-launch; full VoiceOver + keyboard-only + 200%-zoom + contrast pass.

**Gate.** Packaged `.app` resolves the bundled CLI + `ATLAS_ROOT` outside `pnpm dev`; live-drive evidence recorded for every step (the "test live" house rule). This is the terminal phase.

## 4. Cross-cutting acceptance (the seven success criteria)

Each maps to at least one automated test or live-drive step: SC1 (healthy glyph + label) → Phase 1 + live step 1; SC2 (red/amber transition + one notification within a poll interval) → Phase 4 notification tests + live steps 2–3; SC3 (Restart non-destructive) → Phase 2 + live step 5; SC4 (config edits: vault flips a check, models load without `ConfigError` + no transition, credential flips the check, note_globs clear-omits) → Phase 3 tests + live steps 7–10; SC5 (key never in UI/log/config file) → Phase 3/4 sanitization tests + live step 4 (greps app log **and** `brain.config.yaml`); SC6 (launch-at-login toggle + logout/login) → Phase 4 + live step 12; SC7 (both CI legs green) → every phase's gate.

## 5. Out of scope (v1, per the spec)

Usage-metrics dashboard, ask-a-question pane, drag-and-drop/clipboard ingest (adds no ingest path — ADR-0003's ingest risk is not widened), embedded MCP host, any direct read of Atlas-managed state, auto-update, crash reporting, multi-vault switching, running any mutating command from the UI (v1 spawns `status` only), Windows/Linux, and notarization/distribution beyond a locally-built `.app`.
