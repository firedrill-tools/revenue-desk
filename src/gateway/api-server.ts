// The in-process tools of the API integrations (Stripe) and of HubSpot's
// owners lookup.
//
// An ApiToolDefinition is a zod raw shape plus a typed `run`. The gateway
// offers the model the shape's JSON schema (draft-07, no undeclared
// properties), which is also the schema the PreToolUse hook validates against
// before any approval. `run` receives the parsed arguments and the call's
// ApiCallContext (runId, toolUseId, idempotencyKey, signal); it returns JSON
// data or throws ApiToolError for a provider error the model should see.
// Its HTTP exchanges report the provider's status (2xx included) and the
// idempotency key a write actually sent, for the action log (http-report.ts).

import type { AnyZodRawShape, InferShape } from "@anthropic-ai/claude-agent-sdk";
import type { CallToolResult, Tool, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type {
  ApiCallContext,
  IntegrationId,
  ToolDescriptor,
  ToolFailure,
} from "../contracts/integration.js";
import type { JsonObject } from "../contracts/json.js";
import { reportingHttp } from "./http-report.js";
import { errorResult, type GatewayTool, type ToolExecution } from "./types.js";

/** What an API tool's `run` receives besides its arguments: exactly the frozen ApiCallContext. */
export type ApiToolContext = ApiCallContext;

/**
 * One in-process tool of an API integration. `run` returns plain data, which
 * the model receives as JSON text; it throws ApiToolError for a provider error.
 */
export interface ApiToolDefinition<Shape extends AnyZodRawShape = AnyZodRawShape> {
  /** The name after `mcp__<integration>__`; equal to its ToolSpec name. */
  readonly name: string;
  readonly description: string;
  /** A zod 4 raw shape. */
  readonly input: Shape;
  /** Reads run concurrently and carry readOnlyHint; everything else is a write. */
  readonly readOnly: boolean;
  readonly destructive?: boolean;
  run(args: InferShape<Shape>, context: ApiToolContext): Promise<unknown>;
}

/** Keeps the zod shape's inferred argument type for `run`. */
export function defineApiTool<Shape extends AnyZodRawShape>(
  definition: ApiToolDefinition<Shape>,
): ApiToolDefinition<Shape> {
  return definition;
}

/** A provider error, normalised so the model and the action log see the same fields. */
export class ApiToolError extends Error {
  readonly provider: string;
  readonly status: number | undefined;
  readonly code: string | undefined;

  constructor(
    provider: string,
    message: string,
    details: { readonly status?: number; readonly code?: string } = {},
  ) {
    super(message);
    this.name = "ApiToolError";
    this.provider = provider;
    this.status = details.status;
    this.code = details.code;
  }

  toJSON(): Record<string, unknown> {
    return {
      provider: this.provider,
      ...(this.status === undefined ? {} : { status: this.status }),
      ...(this.code === undefined ? {} : { code: this.code }),
      message: this.message,
    };
  }

  toFailure(): ToolFailure {
    return {
      provider: this.provider,
      status: this.status ?? null,
      code: this.code ?? null,
      message: this.message,
    };
  }
}

export class ApiToolDefinitionError extends Error {
  override readonly name = "ApiToolDefinitionError";
}

function isZod4Schema(value: unknown): value is z.ZodType {
  return typeof value === "object" && value !== null && "_zod" in value;
}

/** The strict zod object of a shape; refuses zod 3 shapes, which cannot produce the offered schema. */
function strictObject(name: string, shape: AnyZodRawShape): z.ZodObject {
  const entries = Object.entries(shape);
  for (const [key, schema] of entries) {
    if (!isZod4Schema(schema)) {
      throw new ApiToolDefinitionError(`API tool ${name}: "${key}" is not a zod 4 schema.`);
    }
  }
  return z.strictObject(shape as z.ZodRawShape);
}

/** The JSON schema the model sees for an API tool's arguments (draft-07, closed). */
export function apiInputSchema(definition: ApiToolDefinition): Tool["inputSchema"] {
  const schema = z.toJSONSchema(strictObject(definition.name, definition.input), {
    target: "draft-7",
    io: "input",
    unrepresentable: "any",
  });
  return { ...(schema as Record<string, unknown>), type: "object" } as Tool["inputSchema"];
}

function annotationsOf(descriptor: ToolDescriptor): ToolAnnotations {
  return descriptor.readOnly
    ? { readOnlyHint: true }
    : { readOnlyHint: false, destructiveHint: descriptor.baseClass === "destructive" };
}

function failureOf(integration: IntegrationId, error: unknown): ToolFailure {
  if (error instanceof ApiToolError) return error.toFailure();
  const message = error instanceof Error ? error.message : String(error);
  return { provider: integration, status: null, code: null, message };
}

function failureResult(failure: ToolFailure): CallToolResult {
  return errorResult(JSON.stringify({ error: failure }));
}

function zodIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join(".") || "(arguments)"}: ${issue.message}`)
    .join("; ");
}

/**
 * The gateway tool of one API tool definition. The zod shape parses the
 * arguments again (after the PreToolUse schema check) to apply defaults and
 * give `run` typed values.
 */
export function apiGatewayTool(
  definition: ApiToolDefinition,
  descriptor: ToolDescriptor,
): GatewayTool {
  if (definition.name !== descriptor.name) {
    throw new ApiToolDefinitionError(
      `API tool ${definition.name} does not match its profile entry ${descriptor.name}.`,
    );
  }
  const parser = strictObject(definition.name, definition.input);
  const toolDefinition: Tool = {
    name: descriptor.name,
    description: definition.description,
    inputSchema: apiInputSchema(definition),
    annotations: annotationsOf(descriptor),
    _meta: { "anthropic/alwaysLoad": true },
  };
  return {
    descriptor,
    definition: toolDefinition,
    async execute(args: JsonObject, context): Promise<ToolExecution> {
      const parsed = parser.safeParse(args);
      if (!parsed.success) {
        const failure: ToolFailure = {
          provider: descriptor.integration,
          status: null,
          code: "invalid_arguments",
          message: `Invalid arguments: ${zodIssues(parsed.error)}`,
        };
        return {
          result: failureResult(failure),
          error: failure,
          httpStatus: null,
          idempotencyKey: null,
        };
      }
      // The HTTP layer reports the last status and the key a write sent (http-report.ts).
      const outcome = await reportingHttp(() =>
        definition.run(parsed.data as InferShape<AnyZodRawShape>, {
          runId: context.runId,
          toolUseId: context.toolUseId,
          idempotencyKey: context.idempotencyKey,
          signal: context.signal,
        }),
      );
      const { report } = outcome;
      if (outcome.ok) {
        return {
          result: { content: [{ type: "text", text: JSON.stringify(outcome.value ?? null) }] },
          error: null,
          httpStatus: report.httpStatus,
          idempotencyKey: report.idempotencyKey,
        };
      }
      const failure = failureOf(descriptor.integration, outcome.error);
      return {
        result: failureResult(failure),
        error: failure,
        httpStatus: failure.status ?? report.httpStatus,
        idempotencyKey: report.idempotencyKey,
      };
    },
  };
}
