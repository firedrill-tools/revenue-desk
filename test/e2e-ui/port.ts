// Where `pnpm test:e2e` starts the built app: 127.0.0.1:4320, or E2E_PORT
// when set (a test-harness variable, not app configuration), so the suite can
// run beside a Revenue Desk that is already serving 4320. The suite never
// reuses a server already on its port.

function e2ePort(): number {
  const raw = process.env.E2E_PORT?.trim() ?? "";
  if (raw === "") return 4320;
  const port = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("E2E_PORT must be a port number from 1 to 65535.");
  }
  return port;
}

export const E2E_PORT = e2ePort();
