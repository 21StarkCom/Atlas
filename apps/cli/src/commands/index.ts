/**
 * Command-handler registration barrel. Importing this module registers every
 * implemented command handler with the router (via each module's
 * `registerCommand(...)` side effect). `main.ts` imports it before dispatch so the
 * handlers are available; unimplemented commands stay unhandled (→ not-implemented).
 */
import "./db-backup.js";
import "./db-restore.js";
import "./db-verify.js";
