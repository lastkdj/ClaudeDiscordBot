// Registers the guild slash commands for TheMerchant.
//   npm run register-commands            show what would be registered (dry run)
//   npm run register-commands -- --apply register them
import { REST, Routes } from 'discord.js';
import { loadConfig } from '../config.js';
import { commandJson } from './commands.js';

const apply = process.argv.includes('--apply');
const cfg = loadConfig({ requireDiscord: apply });
const body = commandJson();
console.log(`${body.length} commands: ${body.map((c) => `/${c.name}`).join(', ')}`);
if (!apply) {
  console.log('Dry run. Pass --apply to register them in the guild.');
} else {
  const rest = new REST({ version: '10' }).setToken(cfg.discordToken!);
  await rest.put(Routes.applicationGuildCommands(cfg.applicationId, cfg.guildId!), { body });
  console.log('Registered.');
}
