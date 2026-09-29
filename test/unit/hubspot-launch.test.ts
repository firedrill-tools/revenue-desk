import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildHubSpotStdioLaunch,
  describeHubSpotStdioLaunch,
  HubSpotLaunchError,
  resolveHubSpotMcpServer,
} from "../../src/integrations/hubspot/launch.js";

const TOKEN = "unit-test-dummy-token";

function expectLaunchError(run: () => unknown, code: HubSpotLaunchError["code"]): void {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(HubSpotLaunchError);
  expect((caught as HubSpotLaunchError).code).toBe(code);
}

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A throwaway project whose node_modules holds a package layout under test (no real code). */
function projectWith(packageJson: Record<string, unknown> | null, files: string[] = []): string {
  const root = mkdtempSync(join(tmpdir(), "revenue-desk-hubspot-launch-"));
  tempDirs.push(root);
  if (packageJson !== null) {
    const dir = join(root, "node_modules/@hubspot/mcp-server");
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify(packageJson));
    for (const file of files) writeFileSync(join(dir, file), "// placeholder\n");
  }
  return root;
}

describe("resolveHubSpotMcpServer", () => {
  it("finds the pinned 0.4.x dependency and its bin inside the package", () => {
    const server = resolveHubSpotMcpServer();
    expect(server.packageName).toBe("@hubspot/mcp-server");
    expect(server.version).toMatch(/^0\.4\.\d+$/);
    expect(isAbsolute(server.binPath)).toBe(true);
    expect(existsSync(server.binPath)).toBe(true);
    expect(relative(server.packageDir, server.binPath)).toBe(join("dist", "index.js"));
  });

  it("reports a missing installation", () => {
    const root = projectWith(null);
    expectLaunchError(
      () => resolveHubSpotMcpServer({ resolveFrom: root }),
      "hubspot_mcp_not_installed",
    );
  });

  it("refuses a package with another name", () => {
    const root = projectWith({ name: "evil", version: "0.4.0", bin: "dist/index.js" }, [
      "dist/index.js",
    ]);
    expectLaunchError(
      () => resolveHubSpotMcpServer({ resolveFrom: root }),
      "hubspot_mcp_invalid_package",
    );
  });

  it("refuses a bin that escapes the package directory", () => {
    const root = projectWith({
      name: "@hubspot/mcp-server",
      version: "0.4.0",
      bin: { "mcp-hubspot": "../../../outside.js" },
    });
    writeFileSync(join(root, "outside.js"), "// outside\n");
    expectLaunchError(
      () => resolveHubSpotMcpServer({ resolveFrom: root }),
      "hubspot_mcp_invalid_package",
    );
  });

  it("refuses a bin file that does not exist", () => {
    const root = projectWith({
      name: "@hubspot/mcp-server",
      version: "0.4.0",
      bin: { "mcp-hubspot": "dist/index.js" },
    });
    expectLaunchError(
      () => resolveHubSpotMcpServer({ resolveFrom: root }),
      "hubspot_mcp_invalid_package",
    );
  });
});

describe("buildHubSpotStdioLaunch", () => {
  it("runs the resolved bin with this Node binary, never npx or a shell", () => {
    const server = resolveHubSpotMcpServer();
    const launch = buildHubSpotStdioLaunch({ accessToken: TOKEN });
    expect(launch.command).toBe(process.execPath);
    expect(launch.args).toEqual([server.binPath]);
    expect(launch.cwd).toBe(server.packageDir);
    expect(launch.source).toEqual({
      kind: "bundled",
      packageName: "@hubspot/mcp-server",
      version: server.version,
      binPath: server.binPath,
    });
    // One argument: the bin file itself, not a package-manager shim or a shell wrapper.
    expect(launch.args).toHaveLength(1);
    expect(readFileSync(server.binPath, "utf8").startsWith("#!/usr/bin/env node")).toBe(true);
  });

  it("passes only the token and the dotenv guards to the child, never a host override", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "parent-secret");
    vi.stubEnv("BASE_URL_OVERRIDE", "https://attacker.invalid");
    vi.stubEnv("PRIVATE_APP_ACCESS_TOKEN", "parent-token");
    const launch = buildHubSpotStdioLaunch({ accessToken: TOKEN });
    expect(launch.env).toEqual({
      PRIVATE_APP_ACCESS_TOKEN: TOKEN,
      DOTENV_CONFIG_PATH: devNull,
      DOTENV_CONFIG_QUIET: "true",
    });
  });

  it("has no option that could point the server at another host", () => {
    // An unknown option (a caller that still passes the removed apiBaseUrl) is ignored.
    const options = { accessToken: TOKEN, apiBaseUrl: "https://hubspot.example" };
    const launch = buildHubSpotStdioLaunch(options);
    expect(Object.keys(launch.env)).not.toContain("BASE_URL_OVERRIDE");
    expect(JSON.stringify(launch)).not.toContain("hubspot.example");
  });

  it("requires a token and keeps it out of error messages", () => {
    expectLaunchError(
      () => buildHubSpotStdioLaunch({ accessToken: "" }),
      "hubspot_mcp_token_missing",
    );
    expectLaunchError(
      () => buildHubSpotStdioLaunch({ accessToken: "   " }),
      "hubspot_mcp_token_missing",
    );
    const secret = "pat-secret\nvalue";
    try {
      buildHubSpotStdioLaunch({ accessToken: secret });
      expect.unreachable();
    } catch (error) {
      expect((error as HubSpotLaunchError).code).toBe("hubspot_mcp_token_invalid");
      expect((error as Error).message).not.toContain("pat-secret");
    }
  });

  it("rejects a relative execPath", () => {
    expectLaunchError(
      () => buildHubSpotStdioLaunch({ accessToken: TOKEN, execPath: "node" }),
      "hubspot_mcp_invalid_override",
    );
  });

  it("refuses a version outside 0.4.x instead of launching an unknown tool surface", () => {
    const root = projectWith(
      { name: "@hubspot/mcp-server", version: "0.5.0", bin: { "mcp-hubspot": "dist/index.js" } },
      ["dist/index.js"],
    );
    expectLaunchError(
      () => buildHubSpotStdioLaunch({ accessToken: TOKEN, resolveFrom: root }),
      "hubspot_mcp_unsupported_version",
    );
  });

  it("accepts another 0.4.x patch release", () => {
    const root = projectWith(
      { name: "@hubspot/mcp-server", version: "0.4.7", bin: { "mcp-hubspot": "dist/index.js" } },
      ["dist/index.js"],
    );
    const launch = buildHubSpotStdioLaunch({ accessToken: TOKEN, resolveFrom: root });
    expect(launch.source).toMatchObject({ kind: "bundled", version: "0.4.7" });
    expect(launch.args[0]?.endsWith(join("@hubspot", "mcp-server", "dist", "index.js"))).toBe(true);
  });
});

describe("describeHubSpotStdioLaunch", () => {
  it("lists environment names without values", () => {
    const launch = buildHubSpotStdioLaunch({ accessToken: TOKEN });
    const description = describeHubSpotStdioLaunch(launch);
    expect(description.envKeys).toEqual([
      "DOTENV_CONFIG_PATH",
      "DOTENV_CONFIG_QUIET",
      "PRIVATE_APP_ACCESS_TOKEN",
    ]);
    expect(JSON.stringify(description)).not.toContain(TOKEN);
  });
});
