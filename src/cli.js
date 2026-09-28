// Shared setup for the scripts: args, config, client, guild ID checks.
import { resolve } from 'node:path';
import { loadEnv, requireToken } from './env.js';
import { loadConfig } from './config.js';
import { createClient } from './client.js';

export function parseArgs(argv) {
  const flags = new Set();
  const values = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config' || a === '--export') values[a.slice(2)] = argv[++i];
    else if (a.startsWith('--')) flags.add(a.slice(2));
    else throw new Error(`Unexpected argument "${a}"`);
  }
  return { flags, values };
}

export function setup({ configPath, needConfig = true } = {}) {
  loadEnv();
  const path = resolve(configPath ?? 'server-config.json');
  const config = needConfig ? loadConfig(path) : null;
  const envGuild = process.env.DISCORD_GUILD_ID?.trim();
  const guildId = config?.guildId ?? envGuild;
  if (!guildId) throw new Error('No guild ID: set "guildId" in server-config.json or DISCORD_GUILD_ID.');
  if (config && envGuild && envGuild !== config.guildId) {
    throw new Error(`DISCORD_GUILD_ID (${envGuild}) does not match guildId in ${path} (${config.guildId}).`);
  }
  const client = createClient({ token: requireToken() });
  return { client, config, configPath: path, guildId };
}

export function run(main) {
  main().catch((err) => {
    console.error(`\nError: ${err.message}`);
    process.exit(1);
  });
}
