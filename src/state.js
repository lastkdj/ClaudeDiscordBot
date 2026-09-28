// Reads the live state of the guild plus what the bot itself is allowed to do.
import { ADMINISTRATOR, ALL_KNOWN } from './permissions.js';

export async function fetchLiveState(client, guildId) {
  const guild = await client.get(`/guilds/${guildId}`, { query: { with_counts: 'true' } });
  const channels = await client.get(`/guilds/${guildId}/channels`);
  const me = await client.get('/users/@me');
  const botMember = await client.get(`/guilds/${guildId}/members/${me.id}`);

  const roles = guild.roles;
  const everyone = roles.find((r) => r.id === guildId);
  const botRoles = roles.filter((r) => botMember.roles.includes(r.id));
  let botPerms = BigInt(everyone.permissions);
  for (const r of botRoles) botPerms |= BigInt(r.permissions);
  const isOwner = guild.owner_id === me.id;
  const isAdmin = isOwner || (botPerms & ADMINISTRATOR) === ADMINISTRATOR;
  if (isAdmin) botPerms = ALL_KNOWN;
  const botTop = Math.max(0, ...botRoles.map((r) => r.position));

  return { guild, roles, channels, me, botMember, botPerms, botTop, isAdmin, isOwner };
}
