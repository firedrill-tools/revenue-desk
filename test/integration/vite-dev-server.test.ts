// The development server (`pnpm dev`, vite.config.ts) in front of the real
// API app: a page on another localhost port must not be able to read
// conversations through the /api proxy, nor any file outside the web app,
// such as the SQLite database under ./data.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app.js";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const probeDir = join(repo, "data", "vite-dev-server-test");
const secretProbe = mkdtempSync(join(repo, "web", ".vite-secret-probe-"));

let vite: ViteDevServer;
let api: ReturnType<typeof serve>;
let base: string;

beforeAll(async () => {
  mkdirSync(probeDir, { recursive: true });
  writeFileSync(join(probeDir, "revenue-desk.sqlite"), "not a real database");
  writeFileSync(join(secretProbe, ".env"), "EXAMPLE_ONLY=not-a-secret\n");
  const app = createApp({ version: "0.0.0-test" });
  const apiPort = await new Promise<number>((resolve) => {
    api = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, (info: AddressInfo) =>
      resolve(info.port),
    );
  });
  vite = await createServer({
    configFile: join(repo, "vite.config.ts"),
    logLevel: "silent",
    server: {
      port: 0,
      strictPort: false,
      hmr: false,
      proxy: { "/api": { target: `http://127.0.0.1:${apiPort}`, changeOrigin: false } },
    },
  });
  await vite.listen();
  const address = vite.httpServer?.address() as AddressInfo;
  base = `http://127.0.0.1:${address.port}`;
}, 30_000);

afterAll(async () => {
  await vite?.close();
  await new Promise<void>((resolve) => api?.close(() => resolve()));
  rmSync(probeDir, { recursive: true, force: true });
  rmSync(secretProbe, { recursive: true, force: true });
});

describe("pnpm dev's Vite server", () => {
  it.each([["http://localhost:3000"], ["http://127.0.0.1:8080"], ["http://[::1]:5173"]])(
    "gives a page on %s no CORS access to the proxied API",
    async (origin) => {
      const response = await fetch(`${base}/api/health`, { headers: { origin } });
      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
      const preflight = await fetch(`${base}/api/health`, {
        method: "OPTIONS",
        headers: { origin, "access-control-request-method": "GET" },
      });
      expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
    },
  );

  it("serves no file outside the web app, contracts and dependencies", async () => {
    for (const path of [
      "README.md",
      "package.json",
      "data/vite-dev-server-test/revenue-desk.sqlite",
      "src/server/security.ts",
      relative(repo, join(secretProbe, ".env")),
    ]) {
      const response = await fetch(`${base}/@fs${join(repo, path)}`);
      expect(response.status, path).toBe(403);
      await response.body?.cancel();
    }
    // The SPA itself and the contracts it imports still load.
    const page = await fetch(`${base}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("img-src 'self' data:");
    const contract = await fetch(`${base}/@fs${join(repo, "src/contracts/api.ts")}`);
    expect(contract.status).toBe(200);
  });
});
