// Placeholder for `pnpm db:seed`. The real seed writes only the default
// workspace settings and default policies (docs/ARCHITECTURE.md §8); it never
// fabricates conversations, runs or tool data. Until the schema exists there
// is nothing to seed, so this exits non-zero rather than pretending to succeed.
process.stderr.write("db:seed is not implemented yet: src/db/schema.ts is still a placeholder.\n");
process.exitCode = 1;
