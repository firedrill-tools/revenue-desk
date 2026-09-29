#!/usr/bin/env node
// `revenue-desk`: the headless CLI (docs/ARCHITECTURE.md §10).
//
// The stdout guard is installed first; every module with side effects is
// imported dynamically after it, so nothing a library prints can reach
// stdout, which carries only the reply or the --json summary. SIGINT and
// SIGTERM are caught from the start too: one that arrives while the rest of
// the CLI loads is delivered to the run once it listens (early-signals.ts).

import { installSignalBuffer } from "./early-signals.js";
import { installStdoutGuard } from "./stdout-guard.js";

const stdout = installStdoutGuard();
installSignalBuffer();
const { runCliProcess } = await import("./process.js");
await runCliProcess(stdout);
