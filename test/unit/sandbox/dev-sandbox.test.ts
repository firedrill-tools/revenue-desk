/**
 * `pnpm dev:sandbox` without starting anything: the model choice (the real
 * model only when ANTHROPIC_API_KEY is in the environment), argument errors,
 * the banner, and the server environment for each model.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseSandboxArgs, SANDBOX_BANNER, sandboxBanner } from "../../../scripts/dev-sandbox.js";
import { type Fakes, startFakes } from "../../support/fakes/index.js";
import { harnessEnvironment } from "../../support/harness.js";

describe("dev:sandbox arguments", () => {
  it("uses the scripted model unless ANTHROPIC_API_KEY is set in the environment", () => {
    expect(parseSandboxArgs([], {})).toEqual({
      ok: true,
      options: { model: "scripted", hubspot: "stdio", stateDir: null, web: true, built: false },
    });
    expect(parseSandboxArgs([], { ANTHROPIC_API_KEY: "  " })).toMatchObject({
      ok: true,
      options: { model: "scripted" },
    });
    expect(parseSandboxArgs([], { ANTHROPIC_API_KEY: "sk-ant-x" })).toMatchObject({
      ok: true,
      options: { model: "real" },
    });
    expect(
      parseSandboxArgs(["--model", "scripted"], { ANTHROPIC_API_KEY: "sk-ant-x" }),
    ).toMatchObject({
      ok: true,
      options: { model: "scripted" },
    });
  });

  it("never looks for a key in a file: DOTENV_PATH does not enable the real model", () => {
    const parsed = parseSandboxArgs(["--model", "real"], { DOTENV_PATH: "/somewhere/.env" });
    expect(parsed).toMatchObject({
      ok: false,
      message: expect.stringContaining("never read from a file"),
    });
  });

  it("parses the other options and refuses unknown ones", () => {
    expect(
      parseSandboxArgs(["--hubspot", "http", "--state-dir", "data/sandbox", "--no-web"], {}),
    ).toMatchObject({
      ok: true,
      options: { hubspot: "http", stateDir: expect.stringMatching(/data\/sandbox$/), web: false },
    });
    expect(parseSandboxArgs(["--hubspot", "grpc"], {})).toMatchObject({ ok: false });
    expect(parseSandboxArgs(["--state-dir"], {})).toMatchObject({ ok: false });
    expect(parseSandboxArgs(["--real"], {})).toMatchObject({
      ok: false,
      message: "Unknown argument: --real",
    });
    expect(parseSandboxArgs(["--help"], {})).toEqual({ ok: "help" });
    // The production build serves the app itself: no Vite.
    expect(parseSandboxArgs(["--built"], {})).toMatchObject({
      ok: true,
      options: { built: true, web: false },
    });
  });
});

describe("dev:sandbox banner", () => {
  it("labels the demo, says where to go and which model runs, and lists the J1–J5 prompts", () => {
    const banner = sandboxBanner({
      webUrl: "http://127.0.0.1:4321",
      apiUrl: "http://127.0.0.1:4320",
      model: "scripted",
      hubspot: "stdio",
      stateDir: "/tmp/rd",
      keepsState: false,
      workspace: "applied",
    });
    expect(banner).toContain(SANDBOX_BANNER);
    expect(SANDBOX_BANNER).toBe("Local sandbox — no real services");
    expect(banner).toContain("http://127.0.0.1:4321");
    expect(banner).toContain("scripted J1–J5");
    expect(banner).toContain("(removed on exit)");
    expect(banner).toContain("Refund the duplicate");
    const real = sandboxBanner({
      webUrl: null,
      apiUrl: "http://127.0.0.1:4320",
      model: "real",
      hubspot: "http",
      stateDir: "/tmp/rd",
      keepsState: true,
      workspace: "unsupported",
    });
    expect(real).toContain("the real Anthropic API");
    expect(real).toContain("serves /api/health only");
    expect(real).not.toContain("removed on exit");
  });
});

describe("the server environment per model", () => {
  let fakes: Fakes;
  beforeAll(async () => {
    fakes = await startFakes();
  });
  afterAll(async () => {
    await fakes.close();
  });

  it("scripted: the model and the CLI's proxy are the local scripted API", () => {
    const env = harnessEnvironment({
      fakes,
      model: { kind: "scripted", url: "http://127.0.0.1:9" },
      stateDir: "/tmp/rd",
      port: 4320,
      sandbox: true,
    });
    expect(env).toMatchObject({
      ANTHROPIC_BASE_URL: "http://127.0.0.1:9",
      HTTP_PROXY: "http://127.0.0.1:9",
      HTTPS_PROXY: "http://127.0.0.1:9",
      AGENT_SANDBOX: "1",
    });
  });

  it("real: the key from the caller, no base URL and no proxy; integrations still local", () => {
    const env = harnessEnvironment({
      fakes,
      model: { kind: "real", apiKey: "sk-ant-from-env" },
      stateDir: "/tmp/rd",
      port: 4320,
      sandbox: true,
    });
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-from-env");
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.HTTP_PROXY).toBeUndefined();
    expect(env.HTTPS_PROXY).toBeUndefined();
    expect(new URL(env.STRIPE_API_BASE_URL ?? "").hostname).toBe("127.0.0.1");
    expect(env.AGENT_SANDBOX).toBe("1");
  });
});
