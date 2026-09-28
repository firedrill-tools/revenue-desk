/**
 * Helpers for the real-SDK gates: the native CLI check, the subprocess
 * environment, and readers for the Messages API bodies the mock recorded.
 *
 * Provenance: `nativeSdkBinary`, `messageBodies`, `systemText`,
 * `offeredTools`, `turnIndex` and `firstUserText` are adapted from
 * firedrill-tools/firedrill-platform `apps/agent/test/sdk-gate-support.ts`
 * (worktree HEAD c7b9f1e8; the file last changed in 4644332e, 2026-09-27).
 * Same owner. Revenue Desk's gate FAILS when the native CLI is missing
 * (the platform's skipped), and adds `stepIndex`, `offeredTool`,
 * `strayTraffic` and `sdkTestEnvironment`.
 */
import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { MessagesBody, RecordedRequest } from "./mock-anthropic.js";

/**
 * The Claude Agent SDK's native CLI for this platform, when its optional
 * package is installed.
 */
export function nativeSdkBinary(): string | undefined {
  try {
    const require = createRequire(
      fileURLToPath(import.meta.resolve("@anthropic-ai/claude-agent-sdk")),
    );
    const variants = process.platform === "linux" ? ["", "-musl"] : [""];
    for (const variant of variants) {
      try {
        const manifest = require.resolve(
          `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}${variant}/package.json`,
        );
        const binary = join(
          dirname(manifest),
          process.platform === "win32" ? "claude.exe" : "claude",
        );
        if (existsSync(binary)) return binary;
      } catch {}
    }
  } catch {}
  return undefined;
}

/** The native CLI, or an error: a real-SDK gate must fail, never skip, without it. */
export function requireNativeSdkBinary(): string {
  const binary = nativeSdkBinary();
  if (binary === undefined) {
    throw new Error(
      `No native Claude Agent SDK binary for ${process.platform}-${process.arch} is installed ` +
        `(@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}). ` +
        "Reinstall with optional dependencies enabled; this gate fails rather than skips.",
    );
  }
  return binary;
}

/** Every Messages API body the SDK sent. */
export function messageBodies(requests: readonly RecordedRequest[]): MessagesBody[] {
  return requests
    .filter((request) => request.method === "POST" && /\/v1\/messages(\?|$)/.test(request.target))
    .map((request) => (request.body ?? {}) as MessagesBody);
}

/** Requests that are not a loopback `POST /v1/messages` (any CONNECT or other host is stray). */
export function strayTraffic(requests: readonly RecordedRequest[]): RecordedRequest[] {
  return requests.filter(
    (request) =>
      request.method !== "POST" || !/^\/v1\/messages(\/count_tokens)?(\?|$)/.test(request.target),
  );
}

/** The system prompt of one request as plain text. */
export function systemText(body: MessagesBody): string {
  const system = body.system;
  if (typeof system === "string") return system;
  if (!Array.isArray(system)) return "";
  return (system as { text?: unknown }[])
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .join("\n\n");
}

/** Names of the tools one request offered the model, sorted. */
export function offeredTools(body: MessagesBody): string[] {
  return (body.tools ?? []).map((tool) => tool.name).sort();
}

/** One offered tool definition, by name. */
export function offeredTool(body: MessagesBody, name: string) {
  return (body.tools ?? []).find((tool) => tool.name === name);
}

/** Assistant turns already in a request (the platform's step counter, for single-prompt runs). */
export function turnIndex(body: MessagesBody): number {
  return (body.messages ?? []).filter((entry) => entry.role === "assistant").length;
}

function isPrompt(entry: { readonly role: string; readonly content: unknown }): boolean {
  if (entry.role !== "user") return false;
  if (typeof entry.content === "string") return true;
  if (!Array.isArray(entry.content)) return false;
  const blocks = entry.content as { type?: unknown }[];
  return (
    blocks.some((block) => block.type === "text") &&
    !blocks.some((block) => block.type === "tool_result")
  );
}

/**
 * The scripted step within the current prompt: assistant messages after the
 * last user message that carries text and no tool results. Unlike
 * `turnIndex`, it stays correct when a resumed session replays history.
 */
export function stepIndex(body: MessagesBody): number {
  const messages = body.messages ?? [];
  let last = -1;
  messages.forEach((entry, index) => {
    if (isPrompt(entry)) last = index;
  });
  return messages.slice(last + 1).filter((entry) => entry.role === "assistant").length;
}

/** The first user message's text blocks. */
export function firstUserText(body: MessagesBody): string {
  const first = body.messages?.find((entry) => entry.role === "user");
  if (first === undefined) return "";
  if (typeof first.content === "string") return first.content;
  return (first.content as { text?: unknown }[])
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .join("\n");
}

/**
 * The whole environment of the Claude CLI child for a gate run. `env`
 * replaces the child's environment, so nothing ambient (keys, settings,
 * proxies) leaks in. HTTP(S)_PROXY point at the mock, which records and
 * refuses any non-loopback traffic.
 */
export function sdkTestEnvironment(options: {
  readonly mockUrl: string;
  readonly apiKey: string;
  /** A fresh directory; HOME and CLAUDE_CONFIG_DIR are created inside it. */
  readonly stateDir: string;
}): Record<string, string> {
  const home = join(options.stateDir, "home");
  const config = join(options.stateDir, "claude");
  mkdirSync(home, { recursive: true });
  mkdirSync(config, { recursive: true });
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    CLAUDE_CONFIG_DIR: config,
    ANTHROPIC_API_KEY: options.apiKey,
    ANTHROPIC_BASE_URL: options.mockUrl,
    HTTP_PROXY: options.mockUrl,
    HTTPS_PROXY: options.mockUrl,
    NO_PROXY: "127.0.0.1,localhost",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    CLAUDE_CODE_MAX_RETRIES: "0",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
    ENABLE_TOOL_SEARCH: "false",
    CLAUDE_AGENT_SDK_CLIENT_APP: "revenue-desk-test/0",
  };
}
