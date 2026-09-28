/**
 * JSON-schema checks for test support: the Composio fake validates tool
 * arguments against the captured schemas (as Composio does server-side), and
 * the scripted model checks every scripted tool call against the schema the
 * agent actually offered. Draft-07 unless `$schema` names 2020-12.
 */
import { Ajv, type ErrorObject, type Options, type ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsPlugin from "ajv-formats";

type AjvInstance = Ajv | Ajv2020;
type FormatsPlugin = (ajv: AjvInstance) => AjvInstance;

// ajv-formats is CommonJS with `exports.default`; the default import is the
// function or the module object depending on the loader.
const addFormats: FormatsPlugin =
  typeof addFormatsPlugin === "function"
    ? (addFormatsPlugin as unknown as FormatsPlugin)
    : (addFormatsPlugin as { default: FormatsPlugin }).default;

function options(useDefaults: boolean): Options {
  return { strict: false, allErrors: true, logger: false, validateSchema: false, useDefaults };
}

const instances = new Map<string, AjvInstance>();
const compiled = new WeakMap<object, Map<string, ValidateFunction>>();

function ajvFor(schema: object, useDefaults: boolean): AjvInstance {
  const uri = (schema as { $schema?: unknown }).$schema;
  const dialect = typeof uri === "string" && uri.includes("2020-12") ? "2020-12" : "draft-07";
  const key = `${dialect}:${useDefaults}`;
  let instance = instances.get(key);
  if (instance === undefined) {
    instance =
      dialect === "2020-12" ? new Ajv2020(options(useDefaults)) : new Ajv(options(useDefaults));
    addFormats(instance);
    instances.set(key, instance);
  }
  return instance;
}

function validatorFor(schema: object, useDefaults: boolean): ValidateFunction {
  let byMode = compiled.get(schema);
  if (byMode === undefined) {
    byMode = new Map();
    compiled.set(schema, byMode);
  }
  const mode = String(useDefaults);
  let validate = byMode.get(mode);
  if (validate === undefined) {
    validate = ajvFor(schema, useDefaults).compile(schema);
    byMode.set(mode, validate);
  }
  return validate;
}

function describe(error: ErrorObject): string {
  const path = error.instancePath === "" ? "(arguments)" : error.instancePath;
  if (error.keyword === "additionalProperties") {
    return `${path}: unexpected property "${String((error.params as { additionalProperty?: unknown }).additionalProperty)}"`;
  }
  if (error.keyword === "required") {
    return `${path}: missing required property "${String((error.params as { missingProperty?: unknown }).missingProperty)}"`;
  }
  return `${path}: ${error.message ?? error.keyword}`;
}

/** The problems of a value against a schema; an empty list means valid. */
export function schemaIssues(schema: object, value: unknown): string[] {
  const validate = validatorFor(schema, false);
  return validate(value) ? [] : (validate.errors ?? []).map(describe);
}

/**
 * Validates a copy of `value` and fills in schema defaults, as a server does
 * before running a tool. Returns the defaulted value, or the problems.
 */
export function withDefaults<T extends Record<string, unknown>>(
  schema: object,
  value: T,
): { readonly ok: true; readonly value: T } | { readonly ok: false; readonly issues: string[] } {
  const copy = structuredClone(value);
  const validate = validatorFor(schema, true);
  return validate(copy)
    ? { ok: true, value: copy }
    : { ok: false, issues: (validate.errors ?? []).map(describe) };
}
