#!/usr/bin/env node
// `revenue-desk`: the headless CLI (docs/ARCHITECTURE.md §10).
//
// The stdout guard is installed first; every module with side effects is
// imported dynamically after it, so nothing a library prints can reach
// stdout, which carries only the reply or the --json summary.

import { installStdoutGuard } from "./stdout-guard.js";

const stdout = installStdoutGuard();
const { runCliProcess } = await import("./process.js");
await runCliProcess(stdout);
