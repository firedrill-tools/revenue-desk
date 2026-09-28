import { describe, expect, it, vi } from "vitest";

// Pretend no file exists, so the platform package's `claude` binary is "missing".
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  existsSync: () => false,
}));

const { nativeSdkBinary, requireNativeSdkBinary } = await import("../support/sdk-gate-support.js");

describe("real-SDK gate without the native CLI", () => {
  it("fails with an explanation instead of skipping", () => {
    expect(nativeSdkBinary()).toBeUndefined();
    expect(() => requireNativeSdkBinary()).toThrow(
      /No native Claude Agent SDK binary .* this gate fails rather than skips/,
    );
  });
});
