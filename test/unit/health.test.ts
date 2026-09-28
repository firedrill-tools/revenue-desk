import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app.js";
import { CONTENT_SECURITY_POLICY } from "../../src/server/security.js";

describe("GET /api/health", () => {
  it("reports the service as healthy with its version", async () => {
    const app = createApp({ version: "1.2.3" });
    const response = await app.request("/api/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      service: "revenue-desk",
      version: "1.2.3",
    });
  });

  it("answers other API routes only with the session cookie", async () => {
    const app = createApp({ version: "1.2.3" });
    const response = await app.request("/api/nope");
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "csrf_failed" } });
  });
});

describe("security headers", () => {
  it("sends the Content-Security-Policy with every response, API and SPA", async () => {
    const webRoot = mkdtempSync(join(tmpdir(), "rd-web-"));
    writeFileSync(join(webRoot, "index.html"), "<!doctype html><title>Revenue Desk</title>");
    try {
      const app = createApp({ version: "1.2.3", webRoot });
      for (const path of ["/api/health", "/api/nope", "/", "/runs"]) {
        const response = await app.request(path);
        const policy = response.headers.get("content-security-policy") ?? "";
        expect(policy, path).toBe(CONTENT_SECURITY_POLICY);
        // The browser may fetch images only from this origin: a remote Markdown image stays blank.
        expect(policy).toContain("img-src 'self' data:");
        expect(policy).toContain("connect-src 'self'");
        expect(policy).toContain("frame-ancestors 'none'");
        expect(response.headers.get("x-content-type-options"), path).toBe("nosniff");
        expect(response.headers.get("referrer-policy"), path).toBe("no-referrer");
      }
    } finally {
      rmSync(webRoot, { recursive: true, force: true });
    }
  });
});
