# Revenue Desk

Revenue Desk is a back-office agent for the revenue-operations or billing lead
at a small B2B company. It reads and acts across Gmail and Google Calendar
(through Composio), HubSpot (through MCP) and Stripe, QuickBooks Online and
Slack (through their REST APIs), and asks for approval before anything that
moves money or leaves the company.

**Status: scaffold.** The toolchain builds and serves `/api/health` and an empty
app shell. The agent, integrations, database, chat UI and headless CLI are not
implemented yet. The design reference is [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Requirements

- Node.js 22.22.3 or later (developed on Node 24)
- pnpm 9.15.4 (`packageManager` is pinned in `package.json`)

## Commands

| Command | What it does |
|---|---|
| `pnpm install` | Install exact-pinned dependencies, including the Claude Agent SDK's native binary for this platform |
| `pnpm dev` | API server on 127.0.0.1:4320 (`tsx watch`) and Vite on 127.0.0.1:4321, which proxies `/api` |
| `pnpm build` | Build the SPA into `dist/web` and compile `src/` into `dist/` |
| `pnpm start` | Serve the API and the built SPA from 127.0.0.1:4320 |
| `pnpm typecheck` | Type-check server, web and tooling projects |
| `pnpm lint` / `pnpm lint:fix` | Biome lint and format check / apply fixes |
| `pnpm test` | Vitest unit and integration tests |
| `pnpm test:e2e` | Playwright UI tests (none yet; run `pnpm exec playwright install chromium` first) |
| `pnpm db:generate` / `pnpm db:migrate` | Drizzle migrations (the schema is still a placeholder) |
| `pnpm db:seed` | Not implemented yet; exits non-zero |
| `pnpm verify` | Typecheck, lint, unit tests and build (CLI and UI end-to-end suites join later) |

## Configuration and secrets

Configuration comes from environment variables; `.env.example` lists the names.
Real keys never enter this repository. For local runs that need them, keep an
env file outside the repository and point `DOTENV_PATH` at it. Integrations
without configuration show as not configured; there is no fallback to sample
data.

This repository is private and local-only. It has no licence file yet.
