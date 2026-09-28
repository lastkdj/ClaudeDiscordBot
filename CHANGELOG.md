# Server changelog

Structural changes applied to the Discord server, newest first.

## 2026-09-28 — TheMerchant implementation and structure plan (no server changes)

- Owner instruction: "proceed with the plan, implement it fully". Q1–Q13 weren't answered individually, so the proposal's suggested answers were used. They are still to be confirmed.
- `server-config.json` replaced with the §1–3 tree: 14 roles (Executive, Manager and Staff placed above TheMerchant), 10 categories, 40 channels, forum status tags, server settings. Dry run: 62 create, 2 update, 2 reorder, 4 delete (5 gated: 4 prunes of the Discord defaults and 1 @everyone change). Not applied.
- Manual step for the owner before or after the first apply: enable Community (bots need Administrator for it).
- Sync tool extended: Community-aware announcement channels, forum tags / require-tag / auto-archive, server settings, managed bot-role placement, and a fix for role reordering after creating roles. New read-only `npm run audit`.
- TheMerchant built in `merchant/` (bot, webhook API, worker, PostgreSQL schema, 353 tests). Not deployed, and no connection to Discord was made.

## 2026-09-28 — read-only verification (no server changes)

- Environment: DISCORD_TOKEN, DISCORD_GUILD_ID and MERCHANT_DISCORD_TOKEN all set.
- `npm run inspect`: server still Discord defaults (3 members; roles ClaudeBot, TheMerchant, @everyone; #general and General voice in the default categories).
- ClaudeBot role no longer has Administrator. It now holds 47 permissions, more than invite option (a); extras include View Audit Log, Mention Everyone, Manage Nicknames, Mute/Deafen/Move Members, Manage Events, Manage Threads, Manage Expressions, Priority Speaker, Send TTS, Bypass Slowmode. Owner to decide whether to trim (ARCHITECTURE Q13).
- TheMerchant role unchanged: exactly the 14 invited permissions.
- TheMerchant application (GET /applications/@me): Public Bot off, Server Members intent on, no Interactions Endpoint URL. **Message Content intent is ON** (flag GATEWAY_MESSAGE_CONTENT_LIMITED), expected off; owner to disable in the Developer Portal. User Install is also enabled as an installation context.

## 2026-09-28 — TheMerchant bot invited (manual, by owner)

- TheMerchant (app 1554254355644026910) joined via the scoped invite link. Managed role "TheMerchant" (1554254767503441984) with exactly the 14 requested permissions: View Channels, Send Messages, Send Messages in Threads, Create Public/Private Threads, Manage Threads, Embed Links, Attach Files, Read Message History, Add Reactions, Manage Messages, Pin Messages, Manage Roles, Moderate Members. No Administrator.
- Verified read-only by ClaudeBot. Open items: ClaudeBot role still has Administrator; MERCHANT_DISCORD_TOKEN not yet set in the environment.

## 2026-09-28 — project setup

- Bot application created (ID 1554075562430169151) and invited with invite option (a): the requested permissions plus Read Message History, Add Reactions, Attach Files, Embed Links, Connect, Speak. No Administrator.
- Tooling added: `scripts/inspect.js`, `scripts/sync.js`, `server-config.json`. No server changes made yet.
