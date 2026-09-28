# Server changelog

Structural changes applied to the Discord server, newest first.

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
