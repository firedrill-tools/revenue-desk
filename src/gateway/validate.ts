// Argument validation before approval (docs/ARCHITECTURE.md §5, §14).
//
// The Claude CLI forwards a proxied tool's arguments without checking them,
// and the SDK checks an API tool's zod shape only after canUseTool approved
// the call, so a person could approve an invalid refund. The gateway compiles
// the exact JSON schema it offers the model and checks every call in a
// PreToolUse hook, before the policy runs; the model gets a compact message.
//
// Dialects: `$schema` picks draft-07 (the default, used by HubSpot 0.4.0,
// Composio and zod's draft-7 output), 2019-09 or 2020-12. Unknown keywords
// are ignored (strict: false); formats come from ajv-formats; Ajv never logs.

import { Ajv, type ErrorObject, type Options, type ValidateFunction } from "ajv";
import { Ajv2019 } from "ajv/dist/2019.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsPlugin from "ajv-formats";

export type SchemaIssue = {
  /** JSON pointer of the offending value, "" for the arguments object. */
  readonly path: string;
  readonly message: string;
};

/** Returns the issues of one input; an empty list means valid. */
export type ArgumentValidator = (input: unknown) => readonly SchemaIssue[];

type Dialect = "draft-07" | "2019-09" | "2020-12";

const AJV_OPTIONS: Options = {
  strict: false,
  allErrors: true,
  logger: false,
  addUsedSchema: false,
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false,
  validateSchema: false,
};

type AjvInstance = Ajv | Ajv2019 | Ajv2020;
type FormatsPlugin = (ajv: AjvInstance) => AjvInstance;

// ajv-formats is CommonJS with `exports.default`; under NodeNext the default
// import is the module object or the function depending on the loader.
const addFormats: FormatsPlugin =
  typeof addFormatsPlugin === "function"
    ? (addFormatsPlugin as unknown as FormatsPlugin)
    : (addFormatsPlugin as { default: FormatsPlugin }).default;

const instances = new Map<Dialect, AjvInstance>();

function ajvFor(dialect: Dialect): AjvInstance {
  let instance = instances.get(dialect);
  if (instance === undefined) {
    instance =
      dialect === "2020-12"
        ? new Ajv2020(AJV_OPTIONS)
        : dialect === "2019-09"
          ? new Ajv2019(AJV_OPTIONS)
          : new Ajv(AJV_OPTIONS);
    addFormats(instance);
    instances.set(dialect, instance);
  }
  return instance;
}

function dialectOf(schemaUri: unknown): Dialect {
  if (typeof schemaUri !== "string") return "draft-07";
  if (schemaUri.includes("2020-12")) return "2020-12";
  if (schemaUri.includes("2019-09")) return "2019-09";
  return "draft-07";
}

export class SchemaCompileError extends Error {
  override readonly name = "SchemaCompileError";
}

const compiled = new Map<string, ValidateFunction>();

function describe(error: ErrorObject): SchemaIssue {
  const path = error.instancePath;
  const params = error.params as Record<string, unknown>;
  switch (error.keyword) {
    case "additionalProperties":
      return {
        path,
        message: `has an unexpected property "${String(params.additionalProperty)}"`,
      };
    case "required":
      return {
        path,
        message: `is missing the required property "${String(params.missingProperty)}"`,
      };
    case "enum": {
      const allowed = Array.isArray(params.allowedValues)
        ? params.allowedValues.map((value) => JSON.stringify(value)).join(", ")
        : "";
      return { path, message: `must be one of ${allowed}` };
    }
    default:
      return { path, message: error.message ?? `fails ${error.keyword}` };
  }
}

/**
 * Compiles the validator of one offered JSON schema. Identical schemas share
 * one compiled validator. Throws SchemaCompileError when the schema is
 * unusable; such a tool must not be offered, since its calls cannot be checked.
 */
export function compileArgumentValidator(schema: unknown): ArgumentValidator {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    throw new SchemaCompileError("The tool's input schema is not a JSON object.");
  }
  const key = JSON.stringify(schema);
  let validate = compiled.get(key);
  if (validate === undefined) {
    const { $schema, $id: _id, ...rest } = schema as Record<string, unknown>;
    try {
      validate = ajvFor(dialectOf($schema)).compile(rest);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new SchemaCompileError(`The tool's input schema does not compile: ${message}`);
    }
    compiled.set(key, validate);
  }
  const check = validate;
  return (input) => {
    if (check(input)) return [];
    return (check.errors ?? []).map(describe);
  };
}

const MAX_LISTED_ISSUES = 5;

function where(path: string): string {
  if (path === "") return "The call";
  return `\`${path.slice(1).split("/").join(".")}\``;
}

/** The compact message the model receives for invalid arguments. Nothing was run. */
export function invalidArgumentsMessage(toolTitle: string, issues: readonly SchemaIssue[]): string {
  const unique = [...new Set(issues.map((issue) => `${where(issue.path)} ${issue.message}`))];
  const listed = unique.slice(0, MAX_LISTED_ISSUES);
  const more = unique.length - listed.length;
  const details = listed.join("; ") + (more > 0 ? `; and ${more} more` : "");
  return `Invalid arguments for "${toolTitle}": ${details}. Nothing was run. Fix the arguments to match the tool's schema and call it again.`;
}
