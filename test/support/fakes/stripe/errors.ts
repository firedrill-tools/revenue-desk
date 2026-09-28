/** Stripe's error envelope and the errors the fake raises. */
import type { JsonObject } from "../../../../src/contracts/json.js";

export type StripeErrorType =
  | "api_error"
  | "card_error"
  | "idempotency_error"
  | "invalid_request_error";

export class StripeError extends Error {
  constructor(
    readonly status: number,
    readonly type: StripeErrorType,
    message: string,
    readonly details: {
      readonly code?: string;
      readonly param?: string;
      readonly declineCode?: string;
      /** Whether an idempotent result is saved (false for parameter validation). */
      readonly saved?: boolean;
    } = {},
  ) {
    super(message);
  }

  envelope(): JsonObject {
    const { code, param, declineCode } = this.details;
    return {
      error: {
        ...(code === undefined ? {} : { code }),
        ...(declineCode === undefined ? {} : { decline_code: declineCode }),
        ...(code === undefined
          ? {}
          : { doc_url: `https://stripe.com/docs/error-codes/${code.replaceAll("_", "-")}` }),
        message: this.message,
        ...(param === undefined ? {} : { param }),
        type: this.type,
      },
    };
  }
}

export const invalid = (message: string, details: StripeError["details"] = {}) =>
  new StripeError(400, "invalid_request_error", message, details);

export const missing = (kind: string, id: string, param: string, status = 404) =>
  new StripeError(status, "invalid_request_error", `No such ${kind}: '${id}'`, {
    code: "resource_missing",
    param,
  });
