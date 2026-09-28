/**
 * A `revenue-desk` process with the fake services: the same entry sequence
 * as src/cli/main.ts (guard first, everything else imported after it), with
 * the composition root replaced. Run as `node --import tsx fake-cli.ts …`.
 *
 * FAKE_SCENARIO picks the scripted run; FAKE_RECORD_LOG receives every
 * recorded event as a JSON line. noisy-module.ts prints while it is
 * imported, as a careless dependency would.
 */
import { installStdoutGuard } from "../../../../src/cli/stdout-guard.js";

const stdout = installStdoutGuard();
const { runCliProcess } = await import("../../../../src/cli/process.js");
const { createFakeServices, SCENARIOS } = await import("./fake-services.js");
await import("./noisy-module.js");

const scenario = SCENARIOS.find((name) => name === process.env.FAKE_SCENARIO) ?? "reply";
const recordLog = process.env.FAKE_RECORD_LOG;
const fake = createFakeServices({
  scenario,
  announceWaiting: true,
  ...(recordLog === undefined ? {} : { recordLog }),
});
await runCliProcess(stdout, { loadServices: fake.loadServices });
