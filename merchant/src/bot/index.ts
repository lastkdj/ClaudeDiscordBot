// TheMerchant gateway bot. Intents: Guilds + GuildMembers only; everything goes
// through interactions, so Message Content is not needed (§24).
import { Client, Events, GatewayIntentBits, Partials } from 'discord.js';
import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';
import type { Ctx } from '../services/context.js';
import { bootstrapOwner, snowflakeTime } from '../services/users.js';
import type { JobRunner } from '../worker/runner.js';
import { registerDiscordEffects } from './effects.js';
import { createInteractionHandler } from './interactions.js';
import { ensurePanels } from './panels.js';
import { CHANNELS, discoverBindings, type Runtime, textChannel } from './runtime.js';

export async function startBot(cfg: AppConfig, ctx: Ctx, log: Logger, runner: JobRunner | null): Promise<{ client: Client; ready: () => boolean; stop: () => Promise<void> }> {
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers], partials: [Partials.GuildMember] });
  let isReady = false;

  client.once(Events.ClientReady, async (c) => {
    try {
      const guild = await c.guilds.fetch(cfg.guildId!);
      const rt: Runtime = { client: c, guild, ctx, log };
      const missing = await discoverBindings(rt);
      const missingPanels = await ensurePanels(rt);
      if (cfg.ownerDiscordId) await bootstrapOwner(ctx, { id: cfg.ownerDiscordId, username: (await c.users.fetch(cfg.ownerDiscordId).catch(() => null))?.username ?? 'owner', createdAt: snowflakeTime(cfg.ownerDiscordId) });
      if (runner) registerDiscordEffects(runner, rt);
      const handle = createInteractionHandler(rt);
      c.on(Events.InteractionCreate, (i) => void handle(i));
      c.on(Events.ChannelCreate, () => void discoverBindings(rt).catch(() => {}));
      isReady = true;
      log.info({ guild: guild.name, missing, missingPanels }, 'TheMerchant ready');
      const problems = [...missing, ...missingPanels];
      if (problems.length) await textChannel(rt, CHANNELS.systemAlerts)?.send(`TheMerchant started, but these channels/roles are missing (run ClaudeBot's sync): ${problems.join(', ')}`);
    } catch (err) {
      log.error({ err: (err as Error).message }, 'startup failed');
    }
  });
  client.on(Events.ShardDisconnect, () => (isReady = false));
  client.on(Events.ShardResume, () => (isReady = true));
  client.on(Events.Error, (err) => log.error({ err: err.message }, 'discord client error'));

  await client.login(cfg.discordToken!);
  return { client, ready: () => isReady, stop: async () => void (await client.destroy()) };
}
