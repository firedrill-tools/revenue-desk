/**
 * Captures the Google-profile MCP surface that the Firedrill Gmail and Google
 * Calendar Tools expose into test/fixtures/surfaces/google-mcp.json.
 * Read-only: it reads Tool manifests from a local firedrill-tools checkout and
 * the MCP naming rule from a local firedrill engine checkout. No network.
 *
 *   pnpm exec tsx scripts/surfaces/capture-google-mcp.ts \
 *     [--firedrill-tools <dir>] [--firedrill <dir>]
 *   pnpm exec biome format --write test/fixtures/surfaces
 *
 * Firedrill's MCP binding lists every operation as `<packageId>.<operationId>`
 * and, when the manifest declares one, also under its alias. Aliases share the
 * operation's input schema; the alias description falls back to the operation's
 * (firedrill packages/protocol-mcp/src/server.ts). These are Firedrill's copies
 * of Google's names, not a capture from Google's OAuth-only preview servers.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const { values } = parseArgs({
  options: {
    "firedrill-tools": { type: "string", default: resolve(repoRoot, "../firedrill-tools") },
    firedrill: { type: "string", default: resolve(repoRoot, "../firedrill") },
  },
});

interface Operation {
  id: string;
  description?: string;
  inputSchema: unknown;
  mcp?: { name: string; description?: string };
}

const TOOLSETS = [
  {
    key: "gmail",
    packageDir: "packages/gmail",
    manifest: "packages/gmail/firedrill/tools/gmail/gmail.tool.json",
    aliasProvenance:
      "Google Gmail MCP tool and argument names as captured by the Firedrill Tool on 2026-09-13 " +
      "(packages/gmail/README.md).",
  },
  {
    key: "google-calendar",
    packageDir: "packages/google-calendar",
    manifest: "packages/google-calendar/firedrill/tools/google-calendar/google-calendar.tool.json",
    aliasProvenance:
      "Google Calendar MCP tool names and input field names, per packages/google-calendar/README.md.",
  },
] as const;

// Checked by hand on 2026-09-28 (a page-summarising fetch, not a verbatim copy); the pages
// were last updated 2026-09-18. Recheck before treating any of this as Google's contract.
const NOTES = [
  "Gmail has no alias for sending. Sending exists only as the canonical gmail.messages.send and " +
    "gmail.drafts.send.",
  "Google's own pages disagree with each other and with these aliases. " +
    "https://developers.google.com/workspace/gmail/api/guides/configure-mcp-server lists 9 Gmail " +
    "tools, without create_label, update_label, delete_label or get_message; " +
    "https://developers.google.com/workspace/guides/configure-mcp-servers lists 10, adding " +
    "get_message. https://developers.google.com/workspace/calendar/api/guides/configure-mcp-server " +
    "lists 8 Calendar tools without search_events; the Workspace overview lists 9 with it.",
];

function gitHead(dir: string): string {
  return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

function main(): void {
  const toolsDir = values["firedrill-tools"];
  const engineDir = values.firedrill;
  const allNames = new Map<string, string>();

  const toolsets = TOOLSETS.map((toolset) => {
    const document = JSON.parse(readFileSync(join(toolsDir, toolset.manifest), "utf8")) as {
      manifest: { id: string; version: string; operations: Operation[] };
    };
    const packageJson = JSON.parse(
      readFileSync(join(toolsDir, toolset.packageDir, "package.json"), "utf8"),
    ) as { name: string; version: string };
    const { id, operations } = document.manifest;

    const aliases = operations
      .filter((operation) => operation.mcp !== undefined)
      .map((operation) => ({
        name: operation.mcp?.name ?? "",
        canonicalName: `${id}.${operation.id}`,
        description: operation.mcp?.description ?? operation.description ?? null,
        inputSchema: operation.inputSchema,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const canonicalOnly = operations
      .filter((operation) => operation.mcp === undefined)
      .map((operation) => ({
        name: `${id}.${operation.id}`,
        description: operation.description ?? null,
        inputSchema: operation.inputSchema,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const name of [...aliases.map((a) => a.name), ...operations.map((o) => `${id}.${o.id}`)]) {
      const owner = allNames.get(name);
      if (owner !== undefined) throw new Error(`MCP name ${name} is exposed by ${owner} and ${id}`);
      allNames.set(name, id);
    }

    return {
      key: toolset.key,
      package: packageJson.name,
      packageVersion: packageJson.version,
      packageId: id,
      manifestVersion: document.manifest.version,
      manifest: toolset.manifest,
      aliasProvenance: toolset.aliasProvenance,
      aliasCount: aliases.length,
      aliases,
      canonicalOnly,
    };
  });

  const fixture = {
    schemaVersion: 1,
    surface: "google-mcp",
    capturedAt: new Date().toISOString(),
    source: {
      repository: "firedrill-tools (local checkout, read-only)",
      commit: gitHead(toolsDir),
      namingRule: {
        repository: "firedrill (local checkout, read-only)",
        commit: gitHead(engineDir),
        file: "packages/protocol-mcp/src/server.ts",
        rule:
          "Every operation is listed as <packageId>.<operationId>; a declared alias is listed as " +
          "well, with the same input schema and the alias description or else the operation's.",
      },
      method:
        "Read from Firedrill Tool manifests. No MCP server was started and no network was used.",
      script: "scripts/surfaces/capture-google-mcp.ts",
    },
    notes: NOTES,
    toolsets,
  };

  const out = join(repoRoot, "test/fixtures/surfaces/google-mcp.json");
  writeFileSync(out, `${JSON.stringify(fixture, null, 2)}\n`);
  process.stderr.write(
    `wrote ${out}\n${toolsets.map((t) => `${t.key}: ${t.aliasCount} aliases`).join("; ")}\n`,
  );
}

main();
