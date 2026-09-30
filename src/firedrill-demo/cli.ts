#!/usr/bin/env node
/** Explicit headless Revenue Desk command using the same agent and approval gateway. */
import { installSignalBuffer } from "../cli/early-signals.js";
import { installStdoutGuard } from "../cli/stdout-guard.js";

const stdout = installStdoutGuard();
installSignalBuffer();
const { demoAgentEnvironment, catalogBindingsFromEnvironment } = await import("./runtime.js");
const { createFiredrillDemoCatalog } = await import("./catalog.js");
const { createServices } = await import("../cli/services.js");
const { runCliProcess } = await import("../cli/process.js");

demoAgentEnvironment();
const catalog = createFiredrillDemoCatalog(catalogBindingsFromEnvironment());
await runCliProcess(stdout, { loadServices: () => createServices({ catalog }) });
