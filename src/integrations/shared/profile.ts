// Building ToolProfiles from the frozen §2 tables, and classifications that
// follow directly from a tool's spec.

import type {
  Classification,
  IntegrationId,
  ProfileIdOf,
  ToolProfile,
  ToolSpec,
} from "../../contracts/integration.js";

/** A profile keyed by tool name. Duplicate names are a programming error. */
export function defineProfile<I extends IntegrationId>(
  id: ProfileIdOf<I>,
  integration: I,
  specs: readonly ToolSpec[],
): ToolProfile<I> {
  const tools: Record<string, ToolSpec> = {};
  for (const spec of specs) {
    if (Object.hasOwn(tools, spec.name)) {
      throw new Error(`duplicate tool ${spec.name} in profile ${id}`);
    }
    if (!spec.operation.startsWith(`${integration}.`)) {
      throw new Error(
        `operation ${spec.operation} of ${spec.name} is not a ${integration} operation`,
      );
    }
    tools[spec.name] = spec;
  }
  return { id, integration, tools };
}

/** The spec of a tool in a profile; undefined for any other name (including prototype keys). */
export function specOf(profile: ToolProfile, tool: string): ToolSpec | undefined {
  return Object.hasOwn(profile.tools, tool) ? profile.tools[tool] : undefined;
}

/**
 * The classification of a read or internal write whose class, operation and
 * title do not depend on the input. Null for any other base class: those
 * always need details computed from the input.
 */
export function fromSpec(spec: ToolSpec): Classification | null {
  if (spec.baseClass !== "read" && spec.baseClass !== "internal_write") return null;
  return { actionClass: spec.baseClass, operation: spec.operation, title: spec.title };
}
