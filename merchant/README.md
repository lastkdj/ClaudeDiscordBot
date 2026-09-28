# TheMerchant

The operations bot for the TheMerchant shop. It runs orders, sealed provider bidding, provider selection, fulfillment, accounting, provider balances, reputation and reporting inside Discord. The design is in [`../docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md). ClaudeBot (the repo root) builds the server structure, and TheMerchant works inside it.

Stack: Node 20+, TypeScript (run with `tsx`), discord.js 14, PostgreSQL 16 (`pg`, plain SQL migrations), Fastify, Zod, pino and Vitest.

## Layout

```
src/
  core/          domain rules, no I/O: state machine, scoring, authz, ledger, reputation, levels, eligibility
  db/            migrations, seed catalog, pool/transactions
  services/      use cases; each owns its transaction and calls core + audit + job queue
  marketplace/   adapter contract, manual adapter, generic signed-webhook adapter
  discord-ui/    custom_id codec, formatting, message views (provider views carry no prices)
  bot/           gateway client, interaction router, slash commands, outbox effect handlers, panels
  api/           Fastify: POST /webhooks/:marketplace, GET /health
  worker/        job runner, business jobs, schedule
  main.ts        runs bot + API + worker (one process by default)
test/unit        core, authz matrix, adapter contract, views isolation, schedule, wiring
test/integration full lifecycle and webhooks against a real Postgres
```

## Setup

1. **Database.** Create a PostgreSQL 16 database. Supabase is the default choice (Q10). Put its connection string in `DATABASE_URL`. For least privilege, run `src/db/app-role.sql` once as an admin and point the app at the `merchant_app` role.
2. **Environment.** Copy `.env.example` to `.env` (gitignored) or set the values in your host's secret store. Generate the payout key with `openssl rand -hex 32`, and set `OWNER_DISCORD_ID` to your Discord user id.
3. **Install and migrate:** `npm ci`, `npm run migrate`, `npm run seed`. On start, `main.ts` also migrates and seeds, and both steps are idempotent.
4. **Slash commands:** `npm run register-commands` shows the list. `npm run register-commands -- --apply` registers them in the guild.
5. **Run:** `npm start`, or build the `Dockerfile` on an always-on host (Railway, Fly.io or a VPS). Vercel can't hold a gateway connection.

Before starting the bot, the server structure must exist. Run ClaudeBot's sync with the config in `../server-config.json` first. The bot finds channels and roles by name. It posts its panels (welcome, support, direct order, provider apply, provider panel) once and edits them in place after that.

## How work flows

| Who | Where | What |
| --- | --- | --- |
| New member | #welcome | **I'm a customer** gives the Customer role. **Become a provider** shows the rules; accepting them gives Provider Applicant. |
| Applicant | #provider-apply | **Apply** opens a modal (name, timezone, experience, proof, games), then category pickers per game. The application appears in #provider-applications, tagged per game. |
| Manager | #provider-applications | **Approve/Reject <game>** for their games only. The first approval creates the provider code (P-100 onwards), the roles and a private desk thread. |
| Provider | #provider-panel | Availability, balance, stats, capabilities, payout details (encrypted) and payout requests. Everything is ephemeral. |
| Staff | `/order import` | Marketplace order id, service, price, paid, then the requirements modal. The order validates and bidding opens for eligible providers. |
| Provider | desk thread | **Submit bid** opens a modal with price and ETA and returns a sealed ephemeral receipt. Providers can replace or withdraw until the window closes. |
| Staff | #<game>-orders post | Score table plus recommendation. **Assign recommended**, or **Select another** with a logged reason. HIGH risk or value ≥ €150 needs a manager. |
| Provider | desk thread | **Confirm** within 15 minutes, otherwise the order goes to the next bid. Confirming opens a private order room with the brief. |
| Provider / staff | order room / post | Start, **Mark delivered** (note required), **Record completion**. Completion writes the earning to PENDING, and it's released after the service's hold period. |
| Executive | #finance | Approve, mark paid (with the transfer reference) or reject payout requests. |
| Executives, game teams | #exec-reports, #<game>-dashboard | Daily 08:00, weekly Monday and monthly reports (Europe/Madrid) for executives; a live dashboard per game. |

Useful commands: `/order find|import|classify|note|price|cost|refund|cancel|complete|dispute|resolve`, `/staff set`, `/provider info|suspend|unsuspend|level|reveal-payout|adjust`, `/report`, `/dashboard`, `/settings show|set`, `/catalog map-listing|fee-rule|service`. Anyone can see the commands, but every action is authorized against the database (§3). To hide staff commands from customers, restrict them in Server Settings → Integrations → TheMerchant.

## Marketplace connection (Q8)

Until the marketplace is known, staff import orders with `/order import` and record completion by hand. To connect a marketplace (or a relay that posts on its behalf), set `MARKETPLACE_NAME` and `MARKETPLACE_WEBHOOK_SECRET`. The marketplace then posts signed events to `POST /webhooks/<MARKETPLACE_NAME>`. The format is documented at the top of `src/marketplace/generic.ts`, with a sample in `test/fixtures/`. Then map each listing to a service with `/catalog map-listing` and set commission rates with `/catalog fee-rule`. When `MARKETPLACE_API_BASE` and `MARKETPLACE_API_KEY` are set, the worker also reconciles open orders every 15 minutes and pushes deliveries. A marketplace-specific adapter implements the same `MarketplaceAdapter` interface.

## Tests

```
npm run typecheck
npm test                 # unit + integration (integration needs Postgres)
TEST_DATABASE_URL=postgres://user:pass@localhost:5432/merchant_test npm test
```

Integration tests drop and recreate the `public` schema of the test database, so never point `TEST_DATABASE_URL` at real data.

## Safety notes

- TheMerchant has no Administrator, Manage Channels or Manage Server. Structural changes go through ClaudeBot and `server-config.json`.
- Executive, Manager and Staff sit above TheMerchant in the role list, so the bot can't hand those roles out. It only manages Customer, Provider, Provider Applicant and the per-game Team and Provider roles, and an hourly job reconciles them against the database.
- The ledger and audit log are append-only. Database triggers reject UPDATE, DELETE and TRUNCATE on them.
- Secrets come only from the environment, and log lines are scrubbed of every configured secret.
