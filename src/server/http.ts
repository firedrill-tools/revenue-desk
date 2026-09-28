// JSON error bodies and request parsing shared by the routes
// (ApiErrorBody and API_ERROR_STATUS in src/contracts/api.ts).

import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { z } from "zod";
import {
  API_ERROR_STATUS,
  type ApiErrorBody,
  type ApiErrorCode,
  type ApiIssue,
} from "../contracts/api.js";

export function apiError(
  c: Context,
  code: ApiErrorCode,
  message: string,
  issues?: readonly ApiIssue[],
): Response {
  const body: ApiErrorBody = {
    error: { code, message, ...(issues === undefined || issues.length === 0 ? {} : { issues }) },
  };
  return c.json(body, API_ERROR_STATUS[code] as ContentfulStatusCode);
}

export function issuesOf(error: z.ZodError): ApiIssue[] {
  return error.issues.slice(0, 20).map((issue) => ({
    path: issue.path.map(String).join("."),
    message: issue.message,
  }));
}

export type Parsed<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly response: Response };

/** Parses the JSON body with `schema`; an empty body counts as `{}`. */
export async function parseJsonBody<T>(c: Context, schema: z.ZodType<T>): Promise<Parsed<T>> {
  let value: unknown;
  try {
    const text = await c.req.text();
    value = text.trim() === "" ? {} : JSON.parse(text);
  } catch {
    return { ok: false, response: apiError(c, "invalid_request", "The body is not valid JSON.") };
  }
  const result = schema.safeParse(value);
  if (!result.success) {
    return {
      ok: false,
      response: apiError(c, "invalid_request", "The request is not valid.", issuesOf(result.error)),
    };
  }
  return { ok: true, data: result.data };
}

export function parseQuery<T>(c: Context, schema: z.ZodType<T>): Parsed<T> {
  const result = schema.safeParse(c.req.query());
  if (!result.success) {
    return {
      ok: false,
      response: apiError(c, "invalid_request", "The query is not valid.", issuesOf(result.error)),
    };
  }
  return { ok: true, data: result.data };
}
