# 0004 — Persistent desktop surface + the engine-access doctrine

- **Status:** accepted
- **Date:** 2026-07-24
- **Spec:** [`docs/specs/2026-07-24-atlas-desktop-app-spec.md`](../specs/2026-07-24-atlas-desktop-app-spec.md) (Atlas Desktop v1)
- **Plan:** [`docs/plans/2026-07-24-atlas-desktop-app-plan.md`](../plans/2026-07-24-atlas-desktop-app-plan.md)
- **Relates to:** [ADR-0003](0003-retire-security-architecture.md) (v2 single-process pivot) — **this ADR does NOT supersede or weaken ADR-0003; it extends it.**

## Context

ADR-0003 made Atlas a **single process**: `brain <cmd>` opens the vault, mutates, commits, exits. That deliberately demolished every persistent process on the machine — no daemon, no `brain serve`, no launchd service, no OS identities. It also left a real gap for the operator: **there is no ambient way to know Atlas is usable.** "Is my vault reachable, is git healthy, is the Gemini key present, is the index fresh, are migrations current?" is answerable only by remembering to type `brain status` in a terminal, and configuration (vault path, models, API key) has no surface beyond hand-editing `brain.config.yaml` and running `security add-generic-password`.

The tension: the operator wants a **persistent, always-present readiness indicator** (a menubar app), but reviving *any* supervised background process risks re-introducing exactly the daemon / OS-identity / privilege surface ADR-0003 tore out. The question this ADR answers is **how to add a persistent surface without re-arming a privilege boundary or a second writer.**

## Decision

Add a macOS Electron app, **`@atlas/desktop`**, that is **the only persistent Atlas-related process on the machine** — and constrain it to a strict **engine-access doctrine** so it adds no privilege boundary and no new writer or reader of Atlas-managed state.

**The doctrine (load-bearing):**

- **Atlas-managed state = the vault working tree, git history, the SQLite projection, and the LanceDB index.** These four are `runMutation`'s domain (ADR-0003).
- The app **never mutates** any of the four, and in v1 **never reads them directly either.** It holds **no projection DB handle** and issues **no direct git query.**
- **Readiness comes only from `brain status --json`.** `brain status` is the sole authority; the app polls that predicate and renders it. It re-runs no check and re-implements no readiness logic. (An earlier draft held a read-only `better-sqlite3` handle to `SELECT 1`; that was rejected — see below.)
- **Anything that must change Atlas-managed state → spawn the `brain` CLI.** Every such change continues to flow through `runMutation` (lock → `HEAD == refs/heads/main` → validate → ground → dirty-check → apply → one commit per ChangePlan → refresh LanceDB then SQLite → release). The app never re-implements that path. (v1 spawns exactly one command: `status --json`.)
- **`brain.config.yaml` is explicitly outside the Atlas-managed-state boundary.** It is CLI *input* — read at process start by `loadConfig`, not a projection of anything, not covered by a ChangePlan, not part of the commit-per-mutation audit trail. The app writes it directly (schema-validated, atomic, CST-preserving), and that is **not** a second writer of vault/git/projection state.
- **The Gemini credential** is Keychain-only, mediated by the `@atlas/models` credential module (presence probe + write helper) — the same package that resolves the key for `brain`, so lookup and mutation can never target different Keychain items.

**Net:** exactly **one writer** survives for Atlas-managed state (the CLI, via `runMutation`) and exactly **one reader** for readiness (the CLI, via `brain status`). git history remains the sole audit trail and undo. The desktop app is a persistent *client*, not an engine — it adds a GUI surface, not a boundary.

## Rejected alternatives

1. **Revive a daemon / `brain serve`.** Rejected outright. It directly contradicts ADR-0003 and reintroduces a supervised background process, OS identities, and a privilege surface the pivot deliberately demolished. "Persistent" here means a GUI client, not a supervised engine.

2. **The app opens the projection DB read-write and writes notes itself.** Rejected outright. It creates a second writer of Atlas-managed state, defeating one-commit-per-ChangePlan and the git-only undo.

3. **The app opens the projection DB read-only to probe readiness itself (`SELECT 1` for a `dbOpen` signal).** Rejected. `brain status` already opens the store read-only and is the designated readiness authority, so the handle duplicated the authority; it also dragged in a native module (`better-sqlite3`) with an Electron ABI-rebuild burden and a DB-handle lifecycle the four capabilities do not need. The app is a **pure `brain status` client**; projection-openability, if ever needed as a signal, is added as a **CLI-owned** status check, not an app-local probe.

## Accepted residual risks

The playground tier (single operator, single machine, personal vault) makes these acceptable; a real multi-tenant deployment would not. Both inherit ADR-0003's posture — **do not re-add retired machinery to close them.**

- **A persistent GUI process now runs continuously as the operator.** It holds no secret in memory and opens no listener, so its resident attack surface is the Electron runtime itself. Accepted at playground tier.

- **The Gemini key is briefly visible in the `security` process argv during a set/replace.** `security add-generic-password` has no stdin path for the password (verified: `-w` with no argument prompts on the controlling TTY and demands a retype), so the write passes the value as the `-w` argv element — visible to **same-user** processes for the duration of one `exec`. It is the only place the key touches argv; it never touches disk, logs, app state, or an IPC response, and the presence probe never uses `-w`. A native Keychain-binding hardening that avoids argv entirely is noted as a non-blocking open question in the spec.

## Relationship to ADR-0003

This ADR **does not supersede, amend, or weaken ADR-0003.** It accepts every one of ADR-0003's decisions and residual risks and adds a surface *on top of* the single-process engine without re-arming any retired subsystem — no broker, no scan gate, no ledger, no trust tiers, no capabilities, no signer, no daemon, no OS identity, no second writer. If a future desktop feature ever needs to change Atlas-managed state, it spawns `brain`; no exception to `runMutation` is granted here.
