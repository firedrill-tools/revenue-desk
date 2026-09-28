// The composition root of `revenue-desk ask`: the agent core (W1), the
// integrations (W2) and the database (W3) behind the AskServices port
// (src/cli/ports.ts).
//
// Not wired yet. Those workstreams land in parallel; the integration stage
// replaces this body with their implementations. Until then `ask` stops with
// this error. There is deliberately no fallback to fakes or sample data.

import type { AskServices } from "./ports.js";

export function createServices(): Promise<AskServices> {
  return Promise.reject(
    new Error("the agent core, integrations and database are not wired into the CLI yet"),
  );
}
