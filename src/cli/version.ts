import { readFileSync } from "node:fs";

/** The version in package.json. src/cli and dist/cli both sit two levels below it. */
export function packageVersion(): string {
  const pkg: unknown = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  );
  if (typeof pkg === "object" && pkg !== null && "version" in pkg) {
    const { version } = pkg;
    if (typeof version === "string") return version;
  }
  throw new Error("package.json has no version");
}
