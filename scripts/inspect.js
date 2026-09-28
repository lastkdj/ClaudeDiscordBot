#!/usr/bin/env node
// Read-only: prints a summary of the live server.
//   node scripts/inspect.js                      human-readable summary
//   node scripts/inspect.js --export live.json   also write the live state in config format
import { existsSync, writeFileSync } from 'node:fs';
import { parseArgs, setup, run } from '../src/cli.js';
import { fetchLiveState } from '../src/state.js';
import { fromBits, toBits } from '../src/permissions.js';
import { CHANNEL_TYPE_NAMES, VOICE_LIKE } from '../src/config.js';

// Permissions the bot was invited with (invite option "a").
const EXPECTED_BOT_PERMS = [
  'KICK_MEMBERS', 'BAN_MEMBERS', 'MANAGE_CHANNELS', 'MANAGE_GUILD', 'VIEW_CHANNEL', 'SEND_MESSAGES',
  'MANAGE_MESSAGES', 'MANAGE_ROLES', 'MANAGE_WEBHOOKS', 'MODERATE_MEMBERS', 'READ_MESSAGE_HISTORY',
  'ADD_REACTIONS', 'ATTACH_FILES', 'EMBED_LINKS', 'CONNECT', 'SPEAK',
];

const byPos = (a, b) => a.position - b.position || (a.id < b.id ? -1 : 1);
const isVoice = (c) => c.type === 2 || c.type === 13;

run(async () => {
  const { values } = parseArgs(process.argv.slice(2));
  const configPath = values.config ?? 'server-config.json';
  const { client, guildId } = setup({ configPath, needConfig: existsSync(configPath) });
  const live = await fetchLiveState(client, guildId);
  const { guild, roles, channels } = live;
  const roleName = (id) => (id === guildId ? '@everyone' : roles.find((r) => r.id === id)?.name ?? id);

  const out = [];
  out.push(`Server: ${guild.name} (${guild.id})`);
  out.push(`Members: ~${guild.approximate_member_count ?? '?'}   Owner ID: ${guild.owner_id}   Features: ${guild.features.join(', ') || 'none'}`);
  const botRole = roles.filter((r) => live.botMember.roles.includes(r.id)).sort((a, b) => b.position - a.position)[0];
  out.push(`Bot: ${live.me.username} (${live.me.id}), highest role "${botRole?.name ?? '-'}" at position ${live.botTop}`);
  if (live.isAdmin) out.push('  ! Bot has ADMINISTRATOR. Recommended: remove it from the bot role.');
  const missing = EXPECTED_BOT_PERMS.filter((p) => (live.botPerms & toBits([p])) === 0n);
  if (missing.length) out.push(`  ! Bot is missing: ${missing.join(', ')}`);

  out.push('', `Roles (${roles.length}, highest first):`);
  for (const r of roles.slice().sort((a, b) => b.position - a.position)) {
    const tags = [
      r.color ? `#${r.color.toString(16).padStart(6, '0')}` : null,
      r.hoist ? 'hoisted' : null,
      r.mentionable ? 'mentionable' : null,
      r.managed ? 'managed' : null,
      r.position >= live.botTop && r.id !== guildId ? 'above-bot' : null,
    ].filter(Boolean);
    const perms = fromBits(r.permissions);
    const permStr = perms.includes('ADMINISTRATOR') ? 'ADMINISTRATOR' : `${perms.length} perms`;
    out.push(`  [${String(r.position).padStart(2)}] ${r.name}${tags.length ? `  (${tags.join(', ')})` : ''} — ${permStr}`);
  }

  const describe = (c) => {
    const bits = [CHANNEL_TYPE_NAMES[c.type] ?? `type ${c.type}`];
    if (c.topic) bits.push(`topic: "${c.topic.slice(0, 60)}${c.topic.length > 60 ? '…' : ''}"`);
    if (c.rate_limit_per_user) bits.push(`slowmode ${c.rate_limit_per_user}s`);
    if (c.nsfw) bits.push('nsfw');
    if (isVoice(c)) bits.push(`limit ${c.user_limit || '∞'}`);
    const ow = (c.permission_overwrites ?? []).map((o) => `${o.type === 1 ? 'member ' + o.id : roleName(o.id)}(+${fromBits(o.allow).length}/-${fromBits(o.deny).length})`);
    if (ow.length) bits.push(`overwrites: ${ow.join(' ')}`);
    return bits.join(', ');
  };
  const kids = (parentId) => {
    const list = channels.filter((c) => c.type !== 4 && (c.parent_id ?? null) === parentId);
    return [...list.filter((c) => !isVoice(c)).sort(byPos), ...list.filter(isVoice).sort(byPos)];
  };
  out.push('', `Channels (${channels.length}):`);
  for (const c of kids(null)) out.push(`  #${c.name}  [${describe(c)}]`);
  for (const cat of channels.filter((c) => c.type === 4).sort(byPos)) {
    out.push(`  ▾ ${cat.name}  [${describe(cat)}]`);
    for (const c of kids(cat.id)) out.push(`      ${isVoice(c) ? '🔊' : '#'}${c.name}  [${describe(c)}]`);
  }
  console.log(out.join('\n'));

  if (values.export) {
    writeFileSync(values.export, JSON.stringify(toConfig(live, guildId, roleName, kids), null, 2) + '\n');
    console.log(`\nWrote live state in config format to ${values.export}`);
  }
});

function toConfig(live, guildId, roleName, kids) {
  const exportOw = (c) => (c.permission_overwrites ?? []).map((o) => ({
    ...(o.type === 1 ? { member: o.id } : { role: roleName(o.id) }),
    allow: fromBits(o.allow),
    deny: fromBits(o.deny),
  }));
  const exportChannel = (c, parentOw) => {
    const type = CHANNEL_TYPE_NAMES[c.type];
    if (!type) return null;
    const out = { id: c.id, name: c.name, type };
    if (c.topic) out.topic = c.topic;
    if (c.rate_limit_per_user) out.slowmode = c.rate_limit_per_user;
    if (c.nsfw) out.nsfw = true;
    if (VOICE_LIKE.has(type)) { out.userLimit = c.user_limit ?? 0; out.bitrate = c.bitrate; }
    const ow = exportOw(c);
    if (parentOw === undefined || JSON.stringify(sortOw(ow)) !== JSON.stringify(sortOw(parentOw))) out.overwrites = ow;
    return out;
  };
  const sortOw = (list) => list.slice().sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1);

  const everyone = live.roles.find((r) => r.id === guildId);
  return {
    guildId,
    roles: live.roles
      .filter((r) => r.id !== guildId && !r.managed)
      .sort((a, b) => b.position - a.position)
      .map((r) => ({
        id: r.id,
        name: r.name,
        color: r.color ? `#${r.color.toString(16).padStart(6, '0')}` : null,
        hoist: r.hoist,
        mentionable: r.mentionable,
        permissions: fromBits(r.permissions),
      })),
    everyone: { permissions: fromBits(everyone.permissions) },
    categories: live.channels.filter((c) => c.type === 4).sort(byPos).map((cat) => {
      const ow = exportOw(cat);
      return { id: cat.id, name: cat.name, overwrites: ow, channels: kids(cat.id).map((c) => exportChannel(c, ow)).filter(Boolean) };
    }),
    channels: kids(null).map((c) => exportChannel(c, undefined)).filter(Boolean),
    ignore: { roles: [], channels: [] },
  };
}
