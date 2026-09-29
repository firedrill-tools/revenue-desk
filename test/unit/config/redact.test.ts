import { describe, expect, it } from "vitest";
import { loadAgentEnv } from "../../../src/config/env.js";
import {
  createRedactor,
  createRedactorFor,
  MIN_SECRET_LENGTH,
} from "../../../src/config/redact.js";
import { REDACTED } from "../../../src/config/secret.js";

describe("the redactor", () => {
  it("scrubs configured secret values wherever they appear, longest first", () => {
    const redact = createRedactorFor(["composio-secret-key", "composio-secret-key-extended"]);
    expect(redact("a composio-secret-key-extended b composio-secret-key c")).toBe(
      `a ${REDACTED} b ${REDACTED} c`,
    );
  });

  it("scrubs token shapes that are not configured", () => {
    const redact = createRedactorFor([]);
    const cases: [string, string][] = [
      ["Authorization: Bearer abc.DEF-123_x/y=", `Authorization: Bearer ${REDACTED}`],
      ["bearer lowercase-token", `bearer ${REDACTED}`],
      ["key sk_test_51Hx0000abcdef", `key ${REDACTED}`],
      ["key sk_live_51Hx0000abcdef", `key ${REDACTED}`],
      ["restricted rk_test_abcdefgh123", `restricted ${REDACTED}`],
      ["slack xoxb-1234-5678-abcdef", `slack ${REDACTED}`],
      ["slack xoxp-1234-5678-abcdef", `slack ${REDACTED}`],
      ["hubspot pat-na1-11111111-2222-3333-4444-555555555555", `hubspot ${REDACTED}`],
      ["anthropic sk-ant-api03-abcdefghijkl", `anthropic ${REDACTED}`],
      ["composio ak_0123456789abcdefghij", `composio ${REDACTED}`],
    ];
    for (const [input, output] of cases) expect(redact(input)).toBe(output);
  });

  it("leaves ordinary words and ids alone", () => {
    const redact = createRedactorFor([]);
    const text =
      "task_123 desk_notes work_dir ch_3Pabc re_1 cus_ABC in_1 pat-down bearer of news, sk_ alone, ak_ alone, Composio's mask ak_**0000";
    expect(redact(text)).toBe(text);
    expect(createRedactorFor([]).json({ id: "ch_1", amount: 4900 })).toEqual({
      id: "ch_1",
      amount: 4900,
    });
  });

  it(`skips configured values shorter than ${MIN_SECRET_LENGTH} characters`, () => {
    expect(createRedactorFor(["short"])("a short note")).toBe("a short note");
  });

  it("walks JSON values, keys included, without mutating them", () => {
    const redact = createRedactorFor(["top-secret-value"]);
    const input = {
      headers: { authorization: "Bearer top-secret-value" },
      list: ["top-secret-value", 1, true, null],
      "top-secret-value": "as a key",
    } as const;
    const copy = JSON.parse(JSON.stringify(input));
    expect(redact.json(input)).toEqual({
      headers: { authorization: `Bearer ${REDACTED}` },
      list: [REDACTED, 1, true, null],
      [REDACTED]: "as a key",
    });
    expect(input).toEqual(copy);
  });

  it("builds from a snapshot's configured secrets", () => {
    const result = loadAgentEnv({
      COMPOSIO_API_KEY: "composio-project-key-value",
      COMPOSIO_USER_ID: "42",
    });
    if (!result.ok) throw new Error("unexpected problems");
    const redact = createRedactor(result.env);
    expect(redact("key=composio-project-key-value user=42")).toBe(`key=${REDACTED} user=42`);
  });
});
