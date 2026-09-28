/**
 * Checks an AgentEvent stream against the ordering rules of
 * src/contracts/events.ts. Returns the violations (empty when the stream
 * keeps the contract), so a failing test shows every broken rule at once.
 */
import type { AgentEvent, AgentEventOf } from "../../src/contracts/events.js";

type CallEvent = Extract<AgentEvent, { toolCallId: string }>;

export function eventContractViolations(events: readonly AgentEvent[]): string[] {
  const problems: string[] = [];
  const types = events.map((event) => event.type);
  if (types[0] !== "run.started") problems.push("the first event is not run.started");
  if (types.at(-1) !== "run.finished") problems.push("the last event is not run.finished");
  for (const type of ["run.started", "run.finished"] as const) {
    const count = types.filter((candidate) => candidate === type).length;
    if (count !== 1) problems.push(`${type} appears ${count} times`);
  }
  const usageAt = types.indexOf("usage");
  if (usageAt !== -1 && types.lastIndexOf("usage") !== usageAt)
    problems.push("usage appears twice");

  let stepOpen = false;
  let stepsFinished = 0;
  const openBlocks = new Map<string, string>();
  const calls = new Map<
    string,
    {
      readonly seen: string[];
      availableAtStep: number | null;
    }
  >();
  events.forEach((event, index) => {
    switch (event.type) {
      case "step.start":
        if (stepOpen) problems.push(`#${index}: step.start inside an open step`);
        stepOpen = true;
        return;
      case "step.finish":
        if (!stepOpen) problems.push(`#${index}: step.finish without step.start`);
        stepOpen = false;
        stepsFinished += 1;
        return;
      case "text.start":
      case "reasoning.start":
        if (openBlocks.has(event.id))
          problems.push(`#${index}: ${event.type} twice for ${event.id}`);
        openBlocks.set(event.id, event.type.split(".")[0] ?? "");
        return;
      case "text.delta":
      case "reasoning.delta":
      case "text.end":
      case "reasoning.end": {
        const kind = event.type.split(".")[0];
        if (openBlocks.get(event.id) !== kind)
          problems.push(`#${index}: ${event.type} outside its block`);
        if (event.type.endsWith(".end")) openBlocks.delete(event.id);
        return;
      }
      default:
        break;
    }
    if (!("toolCallId" in event)) return;
    const callEvent = event as CallEvent;
    let call = calls.get(callEvent.toolCallId);
    if (call === undefined) {
      call = { seen: [], availableAtStep: null };
      calls.set(callEvent.toolCallId, call);
    }
    const seen = call.seen;
    const id = callEvent.toolCallId;
    const has = (type: string) => seen.includes(type);
    const outcome = has("tool.output") || has("tool.denied");
    switch (callEvent.type) {
      case "tool.input.start":
        if (seen.length > 0) problems.push(`${id}: tool.input.start is not the first call event`);
        break;
      case "tool.input.delta":
        if (!has("tool.input.start") || has("tool.input.available")) {
          problems.push(`${id}: tool.input.delta outside the input stream`);
        }
        break;
      case "tool.input.available":
        if (!has("tool.input.start")) problems.push(`${id}: tool.input.available before start`);
        if (has("tool.input.available")) problems.push(`${id}: tool.input.available twice`);
        call.availableAtStep = stepOpen ? stepsFinished : null;
        break;
      case "approval.requested":
        if (!has("tool.input.available")) problems.push(`${id}: approval before input available`);
        if (call.availableAtStep !== null && stepsFinished <= call.availableAtStep) {
          problems.push(`${id}: approval.requested before its step finished`);
        }
        if (has("approval.requested")) problems.push(`${id}: approval.requested twice`);
        break;
      case "approval.resolved":
        if (!has("approval.requested")) problems.push(`${id}: approval.resolved without a request`);
        if (outcome) problems.push(`${id}: approval.resolved after the outcome`);
        break;
      case "tool.progress":
        if (!has("tool.input.available") || outcome)
          problems.push(`${id}: tool.progress out of place`);
        break;
      case "tool.output":
      case "tool.denied":
        if (!has("tool.input.available")) problems.push(`${id}: outcome before input available`);
        if (outcome) problems.push(`${id}: a second outcome`);
        if (has("approval.requested") && !has("approval.resolved")) {
          problems.push(`${id}: outcome before approval.resolved`);
        }
        if (call.availableAtStep !== null && stepsFinished <= call.availableAtStep) {
          problems.push(`${id}: outcome before its step finished`);
        }
        break;
    }
    seen.push(callEvent.type);
  });
  if (stepOpen) problems.push("a step is still open at the end");
  for (const [id, kind] of openBlocks) problems.push(`${kind} block ${id} never ended`);
  for (const [id, call] of calls) {
    if (!call.seen.includes("tool.output") && !call.seen.includes("tool.denied")) {
      problems.push(`${id}: no outcome`);
    }
  }
  return problems;
}

export function ofType<T extends AgentEvent["type"]>(
  events: readonly AgentEvent[],
  type: T,
): AgentEventOf<T>[] {
  return events.filter((event): event is AgentEventOf<T> => event.type === type);
}

export function forCall(events: readonly AgentEvent[], toolCallId: string): AgentEvent[] {
  return events.filter((event) => "toolCallId" in event && event.toolCallId === toolCallId);
}

export async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}
