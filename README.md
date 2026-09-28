# Discord server manager

Keeps a Discord server's structure (roles, categories, channels, permission
overwrites) in `server-config.json` and syncs it to the live server through
the Discord REST API. Node 20+, no dependencies.

## Setup

1. Set `DISCORD_TOKEN` (and optionally `DISCORD_GUILD_ID`) in the environment,
   or copy `.env.example` to `.env`. `.env` is gitignored, so never commit the token.
2. `server-config.json` holds the guild ID.

## Commands

| Command | What it does |
| --- | --- |
| `npm run inspect` | Read-only summary of the live server (roles, channel tree, bot permissions). |
| `node scripts/inspect.js --export live.json` | Also write the live state in config format. |
| `npm run plan` | Same as `node scripts/sync.js --dry-run`: shows what would be created, changed or deleted. |
| `node scripts/sync.js --apply` | Applies non-destructive changes, then logs them in `CHANGELOG.md`. |
| `... --apply --prune` | Also deletes channels, categories and roles that aren't in the config. |
| `... --apply --allow-everyone` | Also changes `@everyone`'s server-wide permissions. |
| `npm run audit` | Read-only permission audit of the live server (no Administrator anywhere, bot limits, private categories hidden, provider isolation, config in sync). |
| `npm test` | Runs the tests against an in-memory fake Discord API. |

## Config format

```jsonc
{
  "guildId": "1554075315104514120",
  "roles": [                        // listed highest -> lowest; sync enforces this order
    { "name": "Mod", "color": "#3498db", "hoist": true, "mentionable": true,
      "permissions": ["KICK_MEMBERS", "MODERATE_MEMBERS", "MANAGE_MESSAGES"] }
  ],
  "everyone": { "permissions": ["VIEW_CHANNEL", "SEND_MESSAGES"] },   // optional, gated
  "categories": [
    {
      "name": "Staff",
      "overwrites": [
        { "role": "@everyone", "deny": ["VIEW_CHANNEL"] },
        { "role": "Mod", "allow": ["VIEW_CHANNEL"] }
      ],
      "channels": [
        { "name": "mod-chat", "topic": "Staff only", "slowmode": 0 },
        { "name": "Staff Voice", "type": "voice", "userLimit": 5 }
      ]
    }
  ],
  "channels": [],                                   // channels with no category
  "ignore": { "roles": [], "channels": [] }         // live items --prune must never delete
}
```

- **Channel types:** `text` (the default), `voice`, `announcement`, `stage`, `forum`.
- **Forum and thread options:** `tags` (forum only, up to 20, e.g. `{ "name": "Bidding", "emoji": "🪙", "moderated": true }`; existing tags keep their ids), `requireTag` (forum only), `defaultAutoArchive` (60, 1440, 4320 or 10080 minutes).
- **Server settings** (`"guild"` block): `community`, `verificationLevel` (`NONE`…`VERY_HIGH`), `explicitContentFilter`, `defaultNotifications`, and `rulesChannel` / `publicUpdatesChannel` / `systemChannel` by channel name. Bots need Administrator to turn Community on, so when `community` is true and it's off, the plan lists it as a manual step for the owner. Until then, `announcement` channels are created as text channels and converted on the next sync.
- **Bot roles:** a role entry with only `"name"` and `"managed": true` places a bot's managed role in the hierarchy without editing it.
- **Channel fields:** `topic`, `slowmode` (seconds), `nsfw`, `userLimit` and `bitrate` (voice only), `overwrites`.
- **Overwrites:** each entry is `{ "role": "<name>" | "@everyone", allow, deny }` or `{ "member": "<user id>", allow, deny }`.
  A channel without `overwrites` inherits its category's overwrites. If neither is set, overwrites are left as they are.
- **Matching:** items are matched by an optional `id`, otherwise by name. Include `id` if you want renames to work. `inspect --export` writes ids for you.
- **Unset fields:** a field that isn't in the config (topic, color, ...) is left as it is.
- **Permission names:** see `src/permissions.js`.

## Safety

- `ADMINISTRATOR` is rejected unless the role explicitly sets `"allowAdministrator": true`.
- The bot can't grant or revoke permissions it doesn't have itself, or edit roles at or above its own highest role. The plan warns about these and leaves them unchanged.
- Deletions and `@everyone` changes always appear in the dry run, but only run when you pass their flag.
- Requests are sent one at a time. The client waits out Discord's rate limits, both per route and global, and retries 429s and 5xx errors with backoff.
- The token is never logged.
