/**
 * Command-handler registration barrel. Importing this module registers every
 * implemented command handler with the router (via each module's
 * `registerCommand(...)` side effect). `main.ts` imports it before dispatch so the
 * handlers are available; unimplemented commands stay unhandled (→ not-implemented).
 * v2 (#333): the survivor set only — the retired-command handlers were deleted
 * atomically with their registry rows.
 */
import "./db-migrate.js";
import "./db-rebuild.js";
import "./status.js";
import "./jobs.js";
import "./ingest.js";
import "./source-add.js";
import "./source.js";
import "./sync.js";
import "./note.js";
import "./note-add.js";
import "./validate.js";
import "./query.js";
import "./enrich.js";
import "./link.js";
import "./maintain.js";
import "./index-ops.js";
import "./index-eval.js";
import "./evidence-review.js";
import "./evidence-retry.js";
import "./evidence-resolve.js";
