// Runs and Stop (docs/ARCHITECTURE.md §7, §9).

import type { Hono } from "hono";
import { z } from "zod";
import { API_PATHS, type StopRunResponse } from "../../contracts/api.js";
import { RUN_STATUSES } from "../../contracts/events.js";
import { decodeCursor, MAX_PAGE_LIMIT } from "../../db/repos/pagination.js";
import { getRun, runDetailView, runPage } from "../../db/repos/runs.js";
import { apiError, parseJsonBody, parseQuery } from "../http.js";
import type { ApiServices } from "../services.js";

const listQuery = z.object({
  conversationId: z.string().max(128).optional(),
  status: z.enum(RUN_STATUSES).optional(),
  source: z.enum(["ui", "cli"]).optional(),
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).optional(),
});

const emptyBody = z.strictObject({});

export function registerRunRoutes(app: Hono, services: ApiServices): void {
  app.get(API_PATHS.runs, (c) => {
    const query = parseQuery(c, listQuery);
    if (!query.ok) return query.response;
    const cursor = query.data.cursor === undefined ? undefined : decodeCursor(query.data.cursor);
    if (cursor === null) return apiError(c, "invalid_request", "The cursor is not valid.");
    return c.json(runPage(services.db, { ...query.data, cursor }));
  });

  app.get(API_PATHS.run, (c) => {
    const row = getRun(services.db, c.req.param("runId"));
    if (row === undefined) return apiError(c, "not_found", "No run has this id.");
    return c.json(runDetailView(services.db, row));
  });

  app.post(API_PATHS.runStop, async (c) => {
    const body = await parseJsonBody(c, emptyBody);
    if (!body.ok) return body.response;
    const runId = c.req.param("runId");
    const active = services.registry.get(runId);
    if (active?.stop("user", services.registry.stopGraceMs)) {
      const response: StopRunResponse = { runId, status: "stopping" };
      return c.json(response, 202);
    }
    const row = getRun(services.db, runId);
    if (row === undefined) return apiError(c, "not_found", "No run has this id.");
    return apiError(
      c,
      "run_not_active",
      row.status === "running" && active === undefined
        ? "This run belongs to another process (the CLI) and cannot be stopped here."
        : "This run is not running.",
    );
  });
}
