# Discord server manager: working rules

This repo manages the user's Discord server (guild `1554075315104514120`,
bot application `1554075562430169151`; TheMerchant
operations bot application `1554254355644026910`) from `server-config.json`. See
README.md for the commands and config format.

## Rules of engagement (from the owner, always apply)

- The config is the source of truth. Don't create anything that isn't in
  `server-config.json`. For changes, update the config first, then
  `npm run plan`, show the user the plan, wait for their confirmation, then
  `node scripts/sync.js --apply`.
- Always dry-run and show the plan before making any change.
- Get explicit confirmation before anything destructive or hard to undo:
  deleting channels or roles (`--prune`), kicking or banning, bulk message
  deletion, or changing @everyone permissions (`--allow-everyone`). Ask each
  time. Confirming one of these doesn't cover the next.
- Never grant ADMINISTRATOR to any role unless the user explicitly asks.
- Never print the token (`DISCORD_TOKEN`) in output, logs or commits, and
  never ask the user to paste it into chat. It lives in the environment
  settings or a gitignored `.env`.
- Handle rate limits by backing off. `src/client.js` already does this, so
  route every API call through it.
- After each apply, report what was done and any errors. `sync --apply`
  appends to `CHANGELOG.md`. Record manual actions (kicks, bans and so on)
  there too.

## Status

- 2026-09-29: the server structure from `server-config.json` is fully applied
  (roles, categories, 40 channels, Community on, @everyone tightened). Only
  `--prune` is outstanding. The owner will remove the default #general /
  General / their categories by hand, so don't run it.
- ClaudeBot has Administrator (owner's choice, ARCHITECTURE Q13). Recommend
  removing it once setup settles.
- The owner manages the server entirely through Claude Code chat. Make no
  Discord changes until the owner instructs, even non-destructive ones.
  Owner answers are in ARCHITECTURE.md "Decisions". Only answered questions
  are marked approved.
- Marketplace: MyGold.gg (API/webhook details to come; manual `/order import`
  until then).
- Database: Supabase project "TheMerchant", id `gkfqbthkfwefubfzlqxk`
  (eu-west-1, own organization). Migrations 001–004 are applied and the
  catalog is seeded (2026-09-29), and the advisors are clean apart from
  expected INFO notices. The Supabase connector reaches it by id only (it's
  not in the project list), and `DATABASE_URL` points at its session pooler.
  **Never write to "MyGold US Production" or "MyGold US Developer".** Check the
  project id before any write. New migrations must also insert their file
  name into `schema_migrations` when applied through the connector.
- TheMerchant (app `1554254355644026910`) is built in `merchant/` but not
  deployed, and it has never connected to Discord. Don't start the bot,
  register commands (`--apply`) or run anything that posts to Discord until
  the owner says so. Tests use a local Postgres and never touch Discord.
- Hosting (2026-09-29): Railway, free plan (a 30-day $5 trial, then $1/month;
  expect to move to Hobby at $5/month around go-live, and ask the owner first
  because it costs money). One service, "ClaudeDiscordBot": GitHub repo, branch
  `claude/eloquent-volta-houcu6`, root directory `merchant` (Dockerfile),
  region EU West, healthcheck `/health`, no public domain. It deliberately has
  no `MERCHANT_DISCORD_TOKEN`, so it stops at startup until the owner says go.
  Claude manages it through Railway's GraphQL API
  (`https://backboard.railway.com/graphql/v2`, header
  `Project-Access-Token: $RAILWAY_TOKEN`), a project token scoped to
  production. Never print it. Going live, registering commands, plan changes
  and deletions need the owner's explicit go.
- MyGold.gg is on hold until the owner has its API/webhook details.
