/**
 * A dependency that prints while it is imported, as careless libraries do
 * (version banners, debug lines). Imported by fake-cli.ts after the guard.
 */
console.log("noisy module: console.log at import (this must not reach stdout)");
console.info("noisy module: console.info at import");
process.stdout.write("noisy module: process.stdout.write at import\n");

export const NOISY_MODULE_LOADED = true;
