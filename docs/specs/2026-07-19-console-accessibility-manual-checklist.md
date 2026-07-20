# Atlas Console — manual accessibility checklist (#254)

**Scope: the host-requiring accessibility checks a SwiftPM `swift test` run CANNOT host.** A SwiftPM
package has no XCUI/VoiceOver host, so the in-process subset (accessible names/roles/traits on the
presentation layer, no color-only encoding, control-safe announcement vocabulary) is asserted by
`AccessibilityAcceptanceTests`; the checks below require a launched `.app` and a running screen reader and
are executed by hand on a provisioned machine.

This is the #254 checklist ONLY. It is deliberately **not** the full #257 live-drive retro (that task is
`ai:human-led` and deferred). When the live drive is run, its step 9 references this document.

**How to run:** build + launch the app (`scripts/assemble-app.sh && open console/.build/AtlasConsole.app`),
enable VoiceOver (Cmd-F5), and enable Full Keyboard Access (System Settings > Keyboard > Full Keyboard
Access). Work each row top to bottom. **Pass = the expected observation is seen exactly; any deviation
fails at that row.** Record the observation + a pass/fail verdict in the evidence column.

## 1 - Announcements (each `A11yEvent` speaks on its real trigger)

| # | Trigger (how to cause it) | Expected VoiceOver announcement | Verdict / evidence |
|---|---|---|---|
| 1.1 | A job reaches `succeeded` (stream a `job` event / complete a run) | "Job <id> succeeded" | PENDING |
| 1.2 | A job reaches `failed` | "Job <id> failed" | PENDING |
| 1.3 | `backup.healthy=false` heartbeat | "Backup is unhealthy" | PENDING |
| 1.4 | `sudo launchctl bootout system/com.atlas.egress` | "Daemon egress is unreachable" | PENDING |
| 1.5 | Begin a privileged op -> challenge reaches Display | "Authorization challenge ready for review" | PENDING |
| 1.6 | Broker restart at Display -> confirm -> nonce voided -> re-export | "Authorization challenge expired" | PENDING |
| 1.7 | `kill -9` the `brain watch` process | "Watch connection retrying, attempt 1" | PENDING |
| 1.8 | Watch exhausts retries / terminal fault | "Watch connection failed" | PENDING |
| 1.9 | Start any read/query/privileged action | "<label> in progress" (never a silent spinner) | PENDING |
| 1.10 | That action completes successfully | "<label> complete" | PENDING |
| 1.11 | A privileged flow FAILS | "Authorization: <reason> failed" (busy is closed out) | PENDING |
| 1.12 | Cancel a privileged flow at Display / decline biometry | "Authorization cancelled" (busy is closed out) | PENDING |

## 2 - Keyboard-only privileged flow (Full Keyboard Access, no pointer)

| # | Step (keyboard only) | Expected | Verdict / evidence |
|---|---|---|---|
| 2.1 | Tab to the Actions tab, select it | Focus lands on the tab; it activates via Space/Return | PENDING |
| 2.2 | Arrow/Tab through the authorizable-op list, select one | Selection is reachable and announced with its label | PENDING |
| 2.3 | Tab into the operand form, fill required fields | Every field is focusable, labelled, and required-ness announced | PENDING |
| 2.4 | Activate "Begin" via Return | Flow starts; no pointer needed | PENDING |

## 3 - Modal focus entry + restoration

| # | Step | Expected | Verdict / evidence |
|---|---|---|---|
| 3.1 | Challenge modal appears | Focus moves INTO the modal (first field / heading), not left behind the sheet | PENDING |
| 3.2 | Tab within the modal | Focus is trapped inside the modal (does not escape to the cockpit behind it) | PENDING |
| 3.3 | Confirm or Cancel via keyboard | Modal dismisses; focus RESTORES to the "Begin" control that opened it | PENDING |
| 3.4 | Every challenge field read by VoiceOver | Each field's accessibility label is the quoted, control-safe, full-length value (no control byte spoken) | PENDING |

## 4 - Layout & rendering policies (verify on the live app)

| # | Check | Expected | Verdict / evidence |
|---|---|---|---|
| 4.1 | Dynamic Type at the largest accessibility size | No text truncation or clipping in any surface | PENDING |
| 4.2 | Reduced Motion on | No essential information conveyed only by motion | PENDING |
| 4.3 | Light and dark appearance | Every badge/banner remains legible; state carried by symbol+text, never color alone | PENDING |
| 4.4 | Increase Contrast on | Controls + status indicators stay distinguishable | PENDING |
