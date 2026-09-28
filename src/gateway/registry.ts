// The run's tool registry: every offered tool by its model-visible name, with
// the validator of its offered schema and its classifier. The PreToolUse
// hook, canUseTool and the event mapper all look tools up here; a name that
// is not registered is refused.

import type { ToolMetadata } from "../contracts/events.js";
import type {
  Classification,
  ClassifierSettings,
  ToolDescriptor,
} from "../contracts/integration.js";
import type { JsonObject } from "../contracts/json.js";
import type { ToolSource } from "./catalog.js";
import { type ArgumentValidator, compileArgumentValidator } from "./validate.js";

export type RegisteredTool = {
  readonly descriptor: ToolDescriptor;
  /** Issues of one input against the offered JSON schema; empty when valid. */
  readonly validate: ArgumentValidator;
  /** The classification of one complete input; null (deny) when the classifier refuses or throws. */
  classify(input: JsonObject): Classification | null;
};

export class ToolRegistry {
  readonly #tools = new Map<string, RegisteredTool>();

  constructor(tools: readonly RegisteredTool[] = []) {
    for (const tool of tools) this.#tools.set(tool.descriptor.sdkName, tool);
  }

  get(sdkName: string): RegisteredTool | undefined {
    return this.#tools.get(sdkName);
  }

  get size(): number {
    return this.#tools.size;
  }

  names(): string[] {
    return [...this.#tools.keys()];
  }
}

/** The tool's metadata before its input is known (base class). */
export function baseMetadata(descriptor: ToolDescriptor): ToolMetadata {
  return {
    integration: descriptor.integration,
    connectionKind: descriptor.connectionKind,
    operation: descriptor.operation,
    actionClass: descriptor.baseClass,
  };
}

/** The tool's metadata for one classified input. */
export function classifiedMetadata(
  descriptor: ToolDescriptor,
  classification: Classification,
): ToolMetadata {
  return {
    integration: descriptor.integration,
    connectionKind: descriptor.connectionKind,
    operation: classification.operation,
    actionClass: classification.actionClass,
  };
}

/**
 * Registers one offered tool: compiles its schema (throws SchemaCompileError
 * when it cannot be checked, so it must not be offered) and binds its
 * integration's classifier to the workspace settings.
 */
export function registerTool(
  descriptor: ToolDescriptor,
  inputSchema: unknown,
  definition: Pick<ToolSource, "classify">,
  settings: ClassifierSettings,
): RegisteredTool {
  const validate = compileArgumentValidator(inputSchema);
  return {
    descriptor,
    validate,
    classify(input) {
      try {
        return definition.classify(descriptor.name, input, settings);
      } catch {
        return null;
      }
    },
  };
}
