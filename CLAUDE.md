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

- Bot invited with option (a): the requested permissions plus
  READ_MESSAGE_HISTORY, ADD_REACTIONS, ATTACH_FILES, EMBED_LINKS, CONNECT, SPEAK.
  No Administrator.
- Inspect done (2026-09-28): server is still Discord defaults. The ClaudeBot
  role no longer has Administrator but holds 47 perms, more than option (a)
  (see ARCHITECTURE Q13). TheMerchant's Message Content intent was found ON;
  owner to turn it off.
- The owner manages the server entirely through Claude Code chat. Make no
  Discord changes until the owner instructs, even non-destructive ones.
- Project: TheMerchant shop operations system. Proposal in `docs/ARCHITECTURE.md`.
  On 2026-09-28 the owner said "proceed with the plan, implement it fully"
  without answering Q1–Q13 individually. Everything was built against the
  proposal's own suggested answers. Confirm them with the owner, and update
  ARCHITECTURE.md only once they have answered.
- 2026-09-29: owner approved the plan; first apply done (see CHANGELOG). 18
  channels failed on permissions; the config fix (wider ClaudeBot category
  overwrite) is dry-run only and waits for the owner. TheMerchant still sits
  above Executive/Manager/Staff. Marketplace (Q8) is MyGold.gg; more context
  to come from the owner.
- `server-config.json` holds the §1–3 tree (the gaming draft is gone). Applying needs the owner's go-ahead on the
  plan, then separate confirmations for `--allow-everyone` (tightens @everyone)
  and `--prune` (deletes the default #general / General / categories).
  Community must be enabled by the owner by hand (bots need Administrator).
- TheMerchant code is in `merchant/` (see merchant/README.md). It has not been
  deployed and has never connected to Discord. Don't start the bot, register
  commands (`--apply`) or run anything that posts to Discord until the owner
  says so. Tests use a local Postgres and never touch Discord.
