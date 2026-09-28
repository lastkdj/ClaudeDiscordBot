# Discord server manager: working rules

This repo manages the user's Discord server (guild `1554075315104514120`,
bot application `1554075562430169151`) from `server-config.json`. See
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
- Inspect done (2026-09-28): server is still Discord defaults; the ClaudeBot
  role currently HAS Administrator (owner to remove, see ARCHITECTURE Q13).
- The owner manages the server entirely through Claude Code chat. Make no
  Discord changes until the owner instructs, even non-destructive ones.
- Project: TheMerchant shop operations system. Proposal in
  `docs/ARCHITECTURE.md`, awaiting owner approval. Two bots: ClaudeBot
  (structure, this repo's sync tool) and TheMerchant (operations bot, to be
  built under `merchant/`). `server-config.json` holds an earlier gaming
  draft that will be replaced by the §1 tree once approved. Never apply it.
