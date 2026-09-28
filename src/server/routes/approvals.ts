// POST /api/approvals/:approvalId (docs/ARCHITECTURE.md §7): the user's
// decision reaches the waiting gate; the run's stream then carries the
// tool-approval-response, the only source of truth for the UI.

import type { Hono } from "hono";
import { z } from "zod";
import { API_PATHS, type ApprovalDecisionResponse } from "../../contracts/api.js";
import { MAX_DECISION_REASON_LENGTH } from "../../policy/approvals.js";
import { apiError, parseJsonBody } from "../http.js";
import type { ApiServices } from "../services.js";

const decisionBody = z.strictObject({
  approved: z.boolean(),
  reason: z.string().trim().max(MAX_DECISION_REASON_LENGTH).optional(),
});

export function registerApprovalRoutes(app: Hono, services: ApiServices): void {
  app.post(API_PATHS.approval, async (c) => {
    const body = await parseJsonBody(c, decisionBody);
    if (!body.ok) return body.response;
    const approvalId = c.req.param("approvalId");
    const reason = body.data.reason ? body.data.reason : null;
    const result = services.approvals.decide(approvalId, { approved: body.data.approved, reason });
    if (result === "not_found") return apiError(c, "not_found", "No approval has this id.");
    if (result === "already_decided") {
      return apiError(c, "already_decided", "This approval was already decided.");
    }
    const response: ApprovalDecisionResponse = { status: "accepted", approvalId };
    return c.json(response);
  });
}
