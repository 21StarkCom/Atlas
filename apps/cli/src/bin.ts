#!/usr/bin/env node
/**
 * The `brain` executable launcher (Task 1.8 / #24).
 *
 * This is the entry the installed `brain` command runs (package.json `bin` maps
 * `brain` → `dist/bin.js`). It is a thin shell: parse nothing, hold no logic —
 * just hand argv/env to {@link main}, which runs one invocation and exits with
 * the plan §2.5 mapped exit code.
 */
import { main } from "./main.js";

void main();
