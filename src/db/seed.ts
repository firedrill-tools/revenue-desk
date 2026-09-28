// Placeholder for `pnpm db:seed` (database workstream W3). The real seed opens
// the database with src/db/client.ts and writes only the default workspace
// settings row and the default policies (DEFAULT_POLICY in
// src/contracts/integration.ts), idempotently; it never fabricates
// conversations, runs or tool data (docs/ARCHITECTURE.md §8). Until it lands
// this exits non-zero rather than pretending to succeed.
process.stderr.write("db:seed is not implemented yet (database workstream W3).\n");
process.exitCode = 1;
