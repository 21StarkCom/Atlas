/**
 * Command-handler registration barrel. Importing this module registers every
 * implemented command handler with the router (via each module's
 * `registerCommand(...)` side effect). `main.ts` imports it before dispatch so the
 * handlers are available; unimplemented commands stay unhandled (→ not-implemented).
 */
import "./db-migrate.js";
import "./db-backup.js";
import "./db-rebuild.js";
import "./db-restore.js";
import "./db-verify.js";
import "./inspect.js";
import "./doctor.js";
import "./status.js";
import "./jobs.js";
import "./ingest.js";
import "./source-add.js";
import "./source.js";
import "./source-trust-promote.js";
import "./source-trust-revoke.js";
import "./purge.js";
import "./note.js";
import "./git-status.js";
import "./git-cleanup.js";
import "./git-verify.js";
import "./git-review.js";
import "./git-approve.js";
import "./git-reject.js";
import "./git-rollback.js";
import "./validate.js";
import "./query.js";
import "./index-ops.js";
