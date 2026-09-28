// Discord runtime: the guild, name -> channel/role lookup (names come from
// server-config.json, which ClaudeBot keeps in sync), and small helpers.
import {
  ChannelType, type Client, type ForumChannel, type Guild, type GuildMember, type Role, type TextChannel, type ThreadChannel,
  ThreadAutoArchiveDuration,
} from 'discord.js';
import type { Logger } from '../logger.js';
import { one, type Q } from '../db/pool.js';
import { listGames, upsertBinding } from '../services/catalog.js';
import type { Ctx } from '../services/context.js';

export interface Runtime {
  client: Client<true>;
  guild: Guild;
  ctx: Ctx;
  log: Logger;
}

export const CHANNELS = {
  welcome: 'welcome', rules: 'rules', support: 'support', directOrder: 'direct-order', marketplace: 'marketplace',
  providerApply: 'provider-apply', providerPanel: 'provider-panel', providerDesks: 'provider-desks', providerApplications: 'provider-applications',
  staffRoom: 'staff-room', managers: 'managers', execReports: 'exec-reports', finance: 'finance', auditLog: 'audit-log', execChat: 'exec-chat',
  systemAlerts: 'system-alerts', integrationEvents: 'integration-events',
} as const;

export function textChannel(rt: Runtime, name: string): TextChannel | null {
  const c = rt.guild.channels.cache.find((x) => x.name === name && (x.type === ChannelType.GuildText || x.type === ChannelType.GuildAnnouncement));
  return (c as TextChannel) ?? null;
}

export function forumChannel(rt: Runtime, idOrName: string | null | undefined): ForumChannel | null {
  if (!idOrName) return null;
  const c = rt.guild.channels.cache.get(idOrName) ?? rt.guild.channels.cache.find((x) => x.name === idOrName && x.type === ChannelType.GuildForum);
  return c?.type === ChannelType.GuildForum ? (c as ForumChannel) : null;
}

export function channelById(rt: Runtime, id: string | null | undefined): TextChannel | null {
  if (!id) return null;
  const c = rt.guild.channels.cache.get(id);
  return c && (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement) ? (c as TextChannel) : null;
}

export function role(rt: Runtime, name: string): Role | null {
  return rt.guild.roles.cache.find((r) => r.name === name) ?? null;
}

export async function member(rt: Runtime, discordUserId: string | null | undefined): Promise<GuildMember | null> {
  if (!discordUserId) return null;
  return rt.guild.members.fetch(discordUserId).catch(() => null);
}

export async function thread(rt: Runtime, id: string | null | undefined): Promise<ThreadChannel | null> {
  if (!id) return null;
  const c = await rt.guild.channels.fetch(id).catch(() => null);
  return c?.isThread() ? c : null;
}

export async function discordIdOfUser(q: Q, userId: string | null | undefined): Promise<string | null> {
  if (!userId) return null;
  return (await one(q, 'SELECT discord_user_id FROM discord_identities WHERE user_id = $1', [userId]))?.discord_user_id ?? null;
}

// ------------------------------------------------------------------ bot state (panel message ids etc.)

export async function getState(q: Q, key: string): Promise<any> {
  return (await one(q, 'SELECT value FROM system_settings WHERE key = $1', [`bot.${key}`]))?.value ?? null;
}

export async function setState(q: Q, key: string, value: unknown): Promise<void> {
  await q.query(
    `INSERT INTO system_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [`bot.${key}`, JSON.stringify(value)],
  );
}

// ------------------------------------------------------------------ bindings

/** Finds each game's channels and roles by name and stores their ids (§4 discord_bindings). */
export async function discoverBindings(rt: Runtime): Promise<string[]> {
  await rt.guild.channels.fetch();
  await rt.guild.roles.fetch();
  const missing: string[] = [];
  for (const g of await listGames(rt.ctx.db, true)) {
    const find = (suffix: string, type: ChannelType) => rt.guild.channels.cache.find((c) => c.name === `${g.channel_prefix}-${suffix}` && c.type === type)?.id ?? null;
    const b = {
      orders_forum_id: find('orders', ChannelType.GuildForum),
      order_rooms_channel_id: find('order-rooms', ChannelType.GuildText),
      dashboard_channel_id: find('dashboard', ChannelType.GuildText),
      ops_channel_id: find('ops', ChannelType.GuildText),
      team_role_id: role(rt, `${g.short_name} Team`)?.id ?? null,
      provider_role_id: role(rt, `${g.short_name} Provider`)?.id ?? null,
    };
    for (const [k, v] of Object.entries(b)) if (!v) missing.push(`${g.name}: ${k}`);
    await upsertBinding(rt.ctx.db, g.id, b);
  }
  return missing;
}

/** The provider's private desk thread, created on first use (§6). */
export async function ensureDesk(rt: Runtime, providerId: string): Promise<ThreadChannel | null> {
  const p = await one(rt.ctx.db, `SELECT p.id, p.code, p.desk_thread_id, d.discord_user_id FROM providers p JOIN discord_identities d ON d.user_id = p.user_id WHERE p.id = $1`, [providerId]);
  if (!p) return null;
  const existing = await thread(rt, p.desk_thread_id);
  if (existing) return existing;
  const parent = textChannel(rt, CHANNELS.providerDesks);
  if (!parent) throw new Error('#provider-desks not found');
  const t = await parent.threads.create({
    name: `desk-${p.code ?? p.id.slice(0, 8)}`,
    type: ChannelType.PrivateThread,
    invitable: false,
    autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
    reason: 'provider desk',
  });
  await t.members.add(p.discord_user_id);
  await rt.ctx.db.query('UPDATE providers SET desk_thread_id = $2 WHERE id = $1', [providerId, t.id]);
  await t.send(`Welcome to your private desk, <@${p.discord_user_id}>. Opportunities, selections and balance updates for **${p.code}** arrive here. Only you (and executives) can see this thread.`);
  return t;
}
