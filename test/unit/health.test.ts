import { describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app.js";

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

  it("returns a JSON 404 for unknown API routes", async () => {
    const app = createApp({ version: "1.2.3" });
    const response = await app.request("/api/nope");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "not_found", message: "Unknown API route" },
    });
  });
});
