// The shared contracts (src/contracts), re-exported so components import them
// as "@/lib/contracts" instead of a deep relative path. Contracts carry no
// Node-only globals and no implementation imports, so the bundle stays clean.

export * from "../../../src/contracts/api.js";
export type { AgentEffort } from "../../../src/contracts/env.js";
export { EFFORT_LEVELS } from "../../../src/contracts/env.js";
export * from "../../../src/contracts/events.js";
export * from "../../../src/contracts/integration.js";
export * from "../../../src/contracts/json.js";
