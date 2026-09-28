import { describe, expect, it } from "vitest";
import { buildEnvironment } from "../../../src/cli/environment.js";

const CWD = "/work/revenue-desk";

function files(contents: Record<string, string>) {
  const reads: string[] = [];
  const readFile = (path: string) => {
    reads.push(path);
    const content = contents[path];
    if (content === undefined) {
      throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), {
        code: "ENOENT",
      });
    }
    return content;
  };
  return { readFile, reads };
}

describe("buildEnvironment", () => {
  it("copies the environment when DOTENV_PATH is unset and reads no file", () => {
    const { readFile, reads } = files({});
    const result = buildEnvironment(
      { AGENT_MODEL: "claude-a" },
      { cwd: CWD, stateDir: null, readFile },
    );
    expect(result).toEqual({ ok: true, environment: { AGENT_MODEL: "claude-a" } });
    expect(reads).toEqual([]);
  });

  it("fills unset and empty variables from the DOTENV_PATH file; set ones win", () => {
    const { readFile, reads } = files({
      "/secrets/revenue-desk.env": [
        "ANTHROPIC_API_KEY=from-file-key-000000",
        "AGENT_MODEL=claude-file",
        "STRIPE_SECRET_KEY=from-file-stripe",
        "DOTENV_PATH=/elsewhere.env",
      ].join("\n"),
    });
    const result = buildEnvironment(
      {
        DOTENV_PATH: "../../secrets/revenue-desk.env",
        AGENT_MODEL: "claude-env",
        STRIPE_SECRET_KEY: "",
      },
      { cwd: CWD, stateDir: null, readFile },
    );
    expect(reads).toEqual(["/secrets/revenue-desk.env"]);
    expect(result).toEqual({
      ok: true,
      environment: {
        ANTHROPIC_API_KEY: "from-file-key-000000",
        AGENT_MODEL: "claude-env",
        STRIPE_SECRET_KEY: "from-file-stripe",
        DOTENV_PATH: "../../secrets/revenue-desk.env",
      },
    });
  });

  it("reports an unreadable DOTENV_PATH by path and error code only", () => {
    const { readFile } = files({});
    const result = buildEnvironment(
      { DOTENV_PATH: "/missing.env", ANTHROPIC_API_KEY: "sk-ant-never-printed" },
      { cwd: CWD, stateDir: null, readFile },
    );
    expect(result).toEqual({
      ok: false,
      message: "DOTENV_PATH names /missing.env, which could not be read (ENOENT).",
    });
  });

  it("sets AGENT_STATE_DIR from --state-dir, resolved against the working directory", () => {
    const { readFile } = files({ "/f.env": "AGENT_STATE_DIR=/from-file" });
    const result = buildEnvironment(
      { DOTENV_PATH: "/f.env", AGENT_STATE_DIR: "/from-env" },
      { cwd: CWD, stateDir: "runs/one", readFile },
    );
    expect(result.ok && result.environment.AGENT_STATE_DIR).toBe("/work/revenue-desk/runs/one");
  });
});
