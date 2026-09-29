/**
 * How Revenue Desk starts HubSpot's official MCP server (`@hubspot/mcp-server`)
 * as a stdio child process.
 *
 * Decision (spike S4):
 * - The server is a pinned dependency, resolved from node_modules at runtime.
 *   The command is `process.execPath` (the Node binary running Revenue Desk)
 *   and the only argument is the package's absolute `bin` file. There is no
 *   `npx`, no shell, no PATH lookup and no network fetch at startup.
 * - The child gets an explicit, minimal environment: the token, plus two
 *   dotenv settings, and never `BASE_URL_OVERRIDE`, so the server calls
 *   HubSpot's own default host (`https://api.hubspot.com`). 0.4.0 runs
 *   `import 'dotenv/config'`, which would otherwise read a `.env` from its
 *   working directory and could pick up Revenue Desk's own secrets or a
 *   `BASE_URL_OVERRIDE` that redirects the token to another host.
 *   `DOTENV_CONFIG_PATH` points dotenv at the null device and the working
 *   directory is the package directory.
 * - The MCP SDK's `StdioClientTransport` adds only its safe default variables
 *   (HOME, PATH, SHELL, TERM, USER, LOGNAME on POSIX) to `env`, so no other
 *   Revenue Desk secret reaches the child. Launch through that transport (the
 *   gateway's upstream client). The Agent SDK's stdio config has no `cwd`
 *   field, so do not hand this launch to the Claude CLI directly.
 * - No option chooses another host or another MCP server: this is the only
 *   way HubSpot is reached over MCP. `execPath` and `resolveFrom` exist for
 *   tests (no configuration sets them) and still launch only a package named
 *   `@hubspot/mcp-server` at 0.4.x.
 *
 * Nothing here reads `process.env`; configuration parsing belongs to the
 * config layer, which passes explicit options.
 */
import { readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { devNull } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const HUBSPOT_MCP_PACKAGE = "@hubspot/mcp-server";
export const HUBSPOT_MCP_BIN_NAME = "mcp-hubspot";

/**
 * The tool surface in `test/fixtures/surfaces/hubspot-mcp-0.4.0.json` and the
 * `hubspot-mcp-0.4` profile are only valid for 0.4.x. Another minor version
 * may rename tools, so it is refused rather than launched silently.
 */
export const SUPPORTED_HUBSPOT_MCP_VERSION = /^0\.4\.\d+$/;

export type HubSpotLaunchErrorCode =
  | "hubspot_mcp_not_installed"
  | "hubspot_mcp_invalid_package"
  | "hubspot_mcp_unsupported_version"
  | "hubspot_mcp_token_missing"
  | "hubspot_mcp_token_invalid"
  | "hubspot_mcp_invalid_override";

export class HubSpotLaunchError extends Error {
  readonly code: HubSpotLaunchErrorCode;

  constructor(code: HubSpotLaunchErrorCode, message: string) {
    super(message);
    this.name = "HubSpotLaunchError";
    this.code = code;
  }
}

export interface ResolvedHubSpotMcpServer {
  readonly packageName: typeof HUBSPOT_MCP_PACKAGE;
  readonly version: string;
  /** Real (symlink-free) path of the installed package directory. */
  readonly packageDir: string;
  /** Absolute path of the package's `mcp-hubspot` bin file. */
  readonly binPath: string;
}

export interface ResolveHubSpotMcpServerOptions {
  /** A file or directory to resolve from, as Node would. Defaults to this module. */
  readonly resolveFrom?: string;
}

/**
 * Finds the installed `@hubspot/mcp-server` the way Node's resolver would
 * (walking up `node_modules`), without going through the package's `exports`.
 */
export function resolveHubSpotMcpServer(
  options: ResolveHubSpotMcpServerOptions = {},
): ResolvedHubSpotMcpServer {
  const from = resolveFromFile(options.resolveFrom);
  const require = createRequire(from);
  const searchDirs = require.resolve.paths(HUBSPOT_MCP_PACKAGE) ?? [];

  let packageDir: string | undefined;
  for (const dir of searchDirs) {
    const candidate = join(dir, HUBSPOT_MCP_PACKAGE);
    if (isFile(join(candidate, "package.json"))) {
      packageDir = realpathSync(candidate);
      break;
    }
  }
  if (packageDir === undefined) {
    throw new HubSpotLaunchError(
      "hubspot_mcp_not_installed",
      `${HUBSPOT_MCP_PACKAGE} is not installed. Run pnpm install; it is a pinned dependency.`,
    );
  }

  const manifest = readPackageJson(join(packageDir, "package.json"));
  if (manifest.name !== HUBSPOT_MCP_PACKAGE) {
    throw invalidPackage(`package.json names ${JSON.stringify(manifest.name)}`);
  }
  if (typeof manifest.version !== "string" || manifest.version.length === 0) {
    throw invalidPackage("package.json has no version");
  }

  const binRelative = selectBin(manifest.bin);
  const binPath = resolve(packageDir, binRelative);
  const fromPackage = relative(packageDir, binPath);
  if (fromPackage.startsWith(`..${sep}`) || fromPackage === ".." || isAbsolute(fromPackage)) {
    throw invalidPackage(`bin ${JSON.stringify(binRelative)} points outside the package`);
  }
  if (!isFile(binPath)) {
    throw invalidPackage(`bin file ${JSON.stringify(binRelative)} is missing`);
  }

  return {
    packageName: HUBSPOT_MCP_PACKAGE,
    version: manifest.version,
    packageDir,
    binPath: realpathSync(binPath),
  };
}

export interface HubSpotStdioLaunchOptions {
  /** HubSpot private-app token or Service Key; sent to the child as PRIVATE_APP_ACCESS_TOKEN. */
  readonly accessToken: string;
  /** Node binary for the bundled server. Defaults to process.execPath. */
  readonly execPath?: string;
  readonly resolveFrom?: string;
}

/**
 * Structurally a `StdioServerParameters` from `@modelcontextprotocol/sdk`
 * (command, args, env, cwd), plus a description of where it came from.
 */
export interface HubSpotStdioLaunch {
  readonly command: string;
  readonly args: string[];
  readonly env: Record<string, string>;
  readonly cwd?: string;
  readonly source: {
    readonly kind: "bundled";
    readonly packageName: typeof HUBSPOT_MCP_PACKAGE;
    readonly version: string;
    readonly binPath: string;
  };
}

export function buildHubSpotStdioLaunch(options: HubSpotStdioLaunchOptions): HubSpotStdioLaunch {
  const env = childEnvironment(options);
  const execPath = options.execPath ?? process.execPath;
  if (!isAbsolute(execPath)) {
    throw new HubSpotLaunchError(
      "hubspot_mcp_invalid_override",
      "The Node executable path must be absolute",
    );
  }

  const server = resolveHubSpotMcpServer(
    options.resolveFrom === undefined ? {} : { resolveFrom: options.resolveFrom },
  );
  if (!SUPPORTED_HUBSPOT_MCP_VERSION.test(server.version)) {
    throw new HubSpotLaunchError(
      "hubspot_mcp_unsupported_version",
      `${HUBSPOT_MCP_PACKAGE} ${server.version} is installed, but Revenue Desk supports only 0.4.x ` +
        "(its tool names are pinned). Recapture the tool surface before upgrading.",
    );
  }

  return {
    command: execPath,
    args: [server.binPath],
    env,
    cwd: server.packageDir,
    source: {
      kind: "bundled",
      packageName: server.packageName,
      version: server.version,
      binPath: server.binPath,
    },
  };
}

/** A loggable view of a launch: environment values are replaced by their names. */
export function describeHubSpotStdioLaunch(launch: HubSpotStdioLaunch): {
  command: string;
  args: string[];
  cwd: string | null;
  envKeys: string[];
  source: HubSpotStdioLaunch["source"];
} {
  return {
    command: launch.command,
    args: [...launch.args],
    cwd: launch.cwd ?? null,
    envKeys: Object.keys(launch.env).sort(),
    source: launch.source,
  };
}

function childEnvironment(options: HubSpotStdioLaunchOptions): Record<string, string> {
  const token = options.accessToken;
  if (typeof token !== "string" || token.trim().length === 0) {
    throw new HubSpotLaunchError(
      "hubspot_mcp_token_missing",
      "A HubSpot access token is required to start the HubSpot MCP server",
    );
  }
  if (token !== token.trim() || /[\0\r\n]/.test(token)) {
    throw new HubSpotLaunchError(
      "hubspot_mcp_token_invalid",
      "The HubSpot access token contains whitespace or control characters",
    );
  }

  // Exactly these three: no BASE_URL_OVERRIDE, so the server keeps HubSpot's host.
  return {
    PRIVATE_APP_ACCESS_TOKEN: token,
    DOTENV_CONFIG_PATH: devNull,
    DOTENV_CONFIG_QUIET: "true",
  };
}

function resolveFromFile(resolveFrom: string | undefined): string {
  if (resolveFrom === undefined) return fileURLToPath(import.meta.url);
  const absolute = resolve(resolveFrom);
  // createRequire resolves relative to the file's directory; give a directory a
  // placeholder file name so lookups start inside it.
  return isDirectory(absolute) ? join(absolute, "__resolve__.js") : absolute;
}

function selectBin(bin: unknown): string {
  if (typeof bin === "string" && bin.length > 0) return bin;
  if (bin !== null && typeof bin === "object") {
    const entries = Object.entries(bin as Record<string, unknown>);
    const named = entries.find(([name]) => name === HUBSPOT_MCP_BIN_NAME);
    const chosen = named ?? (entries.length === 1 ? entries[0] : undefined);
    if (chosen !== undefined && typeof chosen[1] === "string" && chosen[1].length > 0) {
      return chosen[1];
    }
  }
  throw invalidPackage(`package.json has no ${HUBSPOT_MCP_BIN_NAME} bin`);
}

function readPackageJson(path: string): { name?: unknown; version?: unknown; bin?: unknown } {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed as { name?: unknown; version?: unknown; bin?: unknown };
  } catch {
    throw invalidPackage("package.json is not valid JSON");
  }
}

function invalidPackage(detail: string): HubSpotLaunchError {
  return new HubSpotLaunchError(
    "hubspot_mcp_invalid_package",
    `Installed ${HUBSPOT_MCP_PACKAGE} is unusable: ${detail}`,
  );
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
