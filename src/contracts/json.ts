// JSON value types shared by every contract.
//
// Contracts under src/contracts are imported by the server, the CLI and the
// web client, so they must not use Node-only globals or import implementation
// modules. Type-only imports from "ai" are allowed.

export type JsonPrimitive = string | number | boolean | null;

/** A value that survives JSON.stringify / JSON.parse unchanged. */
export type JsonValue = JsonPrimitive | readonly JsonValue[] | JsonObject;

// A type alias (not an interface) so it is assignable to the AI SDK's JSONObject.
export type JsonObject = { readonly [key: string]: JsonValue };
