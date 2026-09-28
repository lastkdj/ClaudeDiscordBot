// discord.* job handlers: every Discord side effect runs here, after the
// business transaction committed (§24). Handlers are idempotent so retries are safe.
import { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, ChannelType, type ForumChannel, type MessageActionRowComponentBuilder, ThreadAutoArchiveDuration } from 'discord.js';
import { cid } from '../discord-ui/ids.js';
import { CLOSED, statusTag } from '../core/order-state.js';
import { formatMoney, fromDecimalString } from '../core/money.js';
import { many, one } from '../db/pool.js';
import * as V from '../discord-ui/views.js';
import { getBinding, getGame } from '../services/catalog.js';
import { balances, ledgerHistory } from '../services/ledger.js';
import { getOrder } from '../services/orders.js';
import { applicationView } from '../services/providers.js';
import { getQuote } from '../services/quotes.js';
import { financialReport, gameDashboard, operationalReport, reportRows, toCsv } from '../services/reports.js';
import { desiredRoleNames, managedRoleNames } from '../services/users.js';
import type { JobRunner } from '../worker/runner.js';
import { providerOrderView, staffOrderView } from './loaders.js';
import { CHANNELS, channelById, discordIdOfUser, ensureDesk, forumChannel, member, role, type Runtime, textChannel, thread } from './runtime.js';

const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const buttons = (...b: [string, string, ButtonStyle][]) =>
  new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(...b.map(([id, label, style]) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style)));

function tagIds(forum: ForumChannel, names: string[]): string[] {
  return forum.availableTags.filter((t) => names.includes(t.name)).map((t) => t.id).slice(0, 5);
}

export function registerDiscordEffects(runner: JobRunner, rt: Runtime): void {
  const db = rt.ctx.db;

  runner.register('discord.orderPost', async ({ orderId }) => {
    const o = await getOrder(db, orderId);
    if (!o || !o.game_id) return 'no game';
    const binding = await getBinding(db, o.game_id);
    const forum = forumChannel(rt, binding?.orders_forum_id);
    if (!forum) throw Object.assign(new Error(`orders forum for game ${o.game_id} not found`), { retryAfterMs: 300_000 });
    const view = await staffOrderView(db, o, rt.ctx.now());
    const payload = V.staffOrderPost(view);
    const tags = tagIds(forum, [statusTag(o.status)]);
    const existing = await thread(rt, o.forum_post_id);
    if (existing) {
      if (existing.archived && !CLOSED.has(o.status)) await existing.setArchived(false);
      const starter = await existing.fetchStarterMessage().catch(() => null);
      if (starter) await starter.edit({ content: null, embeds: payload.embeds, components: payload.components });
      if (tags.length && existing.appliedTags.join() !== tags.join()) await existing.setAppliedTags(tags);
      return 'edited';
    }
    const post = await forum.threads.create({
      name: truncate(`${o.internal_order_id} · ${view.service}`, 100),
      autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
      appliedTags: tags,
      message: { embeds: payload.embeds, components: payload.components },
    });
    await db.query('UPDATE orders SET forum_post_id = $2 WHERE id = $1', [orderId, post.id]);
    return 'created';
  });

  runner.register('discord.bidInvite', async ({ orderId, providerId, round }) => {
    const o = await getOrder(db, orderId);
    if (!o || o.status !== 'BIDDING' || o.bid_round !== round) return 'stale';
    const inv = await one(db, 'SELECT message_id FROM bid_invitations WHERE order_id = $1 AND provider_id = $2 AND round = $3', [orderId, providerId, round]);
    if (inv?.message_id) return 'already sent';
    const desk = await ensureDesk(rt, providerId);
    if (!desk) return 'no provider';
    const msg = await desk.send(V.bidInvite(await providerOrderView(db, o)));
    await db.query('UPDATE bid_invitations SET message_id = $4 WHERE order_id = $1 AND provider_id = $2 AND round = $3', [orderId, providerId, round, msg.id]);
    return 'sent';
  });

  runner.register('discord.deskThread', async ({ providerId }) => ((await ensureDesk(rt, providerId)) ? 'ok' : 'missing'));

  runner.register('discord.providerNotice', async ({ providerId, text }) => {
    const desk = await ensureDesk(rt, providerId);
    await desk?.send({ content: truncate(text, 1900), allowedMentions: { parse: [] } });
    return 'sent';
  });

  runner.register('discord.selectionNotice', async ({ assignmentId }) => {
    const a = await one(db, `SELECT a.*, b.amount FROM order_assignments a JOIN provider_bids b ON b.id = a.bid_id WHERE a.id = $1`, [assignmentId]);
    if (!a || a.status !== 'PENDING_CONFIRM') return 'stale';
    const o = (await getOrder(db, a.order_id))!;
    const desk = await ensureDesk(rt, a.provider_id);
    const pid = await one(db, 'SELECT d.discord_user_id FROM providers p JOIN discord_identities d ON d.user_id = p.user_id WHERE p.id = $1', [a.provider_id]);
    const view = V.selectionNotice({ ...(await providerOrderView(db, o)), assignmentId, bid: fromDecimalString(a.amount), confirmBy: a.confirm_deadline_at });
    await desk?.send({ ...view, content: `<@${pid?.discord_user_id}> ${view.content}` });
    return 'sent';
  });

  runner.register('discord.orderRoom', async ({ orderId }) => {
    const o = await getOrder(db, orderId);
    if (!o || !o.assigned_provider_id) return 'stale';
    if (await thread(rt, o.order_room_thread_id)) return 'exists';
    const binding = await getBinding(db, o.game_id!);
    const parent = channelById(rt, binding?.order_rooms_channel_id);
    if (!parent) throw Object.assign(new Error('order rooms channel not found'), { retryAfterMs: 300_000 });
    const p = await one(db, `SELECT p.code, d.discord_user_id FROM providers p JOIN discord_identities d ON d.user_id = p.user_id WHERE p.id = $1`, [o.assigned_provider_id]);
    const staffDiscord = await discordIdOfUser(db, o.assigned_staff_id);
    const room = await parent.threads.create({ name: truncate(`${o.internal_order_id} room`, 100), type: ChannelType.PrivateThread, invitable: false, autoArchiveDuration: ThreadAutoArchiveDuration.ThreeDays });
    await room.members.add(p.discord_user_id);
    if (staffDiscord) await room.members.add(staffDiscord).catch(() => {});
    await db.query('UPDATE orders SET order_room_thread_id = $2 WHERE id = $1', [orderId, room.id]);
    await room.send(V.orderRoomBrief({ ...(await providerOrderView(db, o)), configuration: o.configuration ?? {}, providerCode: p.code, staffMention: staffDiscord ? `<@${staffDiscord}>` : null }));
    const post = await thread(rt, o.forum_post_id);
    await post?.send(`🤝 ${p.code} confirmed. Order room: <#${room.id}>`);
    return 'created';
  });

  runner.register('discord.archiveOrder', async ({ orderId, keepPost }) => {
    const o = await getOrder(db, orderId);
    if (!o) return 'missing';
    const room = await thread(rt, o.order_room_thread_id);
    if (room && !room.archived) {
      await room.send(`Order room closed (${o.status.replace(/_/g, ' ').toLowerCase()}).`);
      await room.setLocked(true).catch(() => {});
      await room.setArchived(true);
    }
    if (keepPost) {
      await db.query('UPDATE orders SET order_room_thread_id = NULL WHERE id = $1', [orderId]);
      return 'room archived';
    }
    const post = await thread(rt, o.forum_post_id);
    if (post && CLOSED.has(o.status) && !post.archived) await post.setArchived(true);
    return 'archived';
  });

  runner.register('discord.alert', async ({ channel, gameId, text, mentionManagers }) => {
    let target = null;
    if (channel === 'ops' && gameId) target = channelById(rt, (await getBinding(db, gameId))?.ops_channel_id);
    if (!target) target = textChannel(rt, channel === 'ops' ? CHANNELS.systemAlerts : channel);
    if (!target) return 'no channel';
    const mgr = mentionManagers ? role(rt, 'Manager') : null;
    await target.send({ content: truncate(`${mgr ? `<@&${mgr.id}> ` : ''}${text}`, 1990), allowedMentions: { roles: mgr ? [mgr.id] : [] } });
    return 'sent';
  });

  runner.register('discord.audit', async (p) => {
    const ch = textChannel(rt, CHANNELS.auditLog);
    const who = p.actorUserId ? (await one(db, 'SELECT display_name FROM users WHERE id = $1', [p.actorUserId]))?.display_name : p.actorKind;
    await ch?.send({ content: truncate(`\`${p.action}\` ${p.objectType} ${p.objectId ?? ''} by ${who}${p.reason ? ` · reason: ${p.reason}` : ''}${p.newValue ? ` · ${JSON.stringify(p.newValue)}` : ''}`, 1990), allowedMentions: { parse: [] } });
    return 'sent';
  });

  runner.register('discord.dm', async ({ userId, text }) => {
    const did = await discordIdOfUser(db, userId);
    const m = await member(rt, did);
    const ok = await m?.send(truncate(text, 1900)).then(() => true).catch(() => false);
    if (!ok) {
      const p = await one(db, `SELECT id FROM providers WHERE user_id = $1 AND status <> 'APPLICANT'`, [userId]);
      if (p) (await ensureDesk(rt, p.id))?.send(truncate(text, 1900));
    }
    return ok ? 'dm' : 'fallback';
  });

  runner.register('discord.syncRoles', async ({ userId }) => syncMemberRoles(rt, userId));

  runner.register('discord.reconcileRoles', async () => {
    const members = await rt.guild.members.fetch();
    const managed = new Set(await managedRoleNames(db));
    let drift = 0;
    for (const m of members.values()) {
      if (m.user.bot) continue;
      const hasManaged = m.roles.cache.some((r) => managed.has(r.name));
      const u = await one(db, 'SELECT user_id FROM discord_identities WHERE discord_user_id = $1', [m.id]);
      if (!u && !hasManaged) continue;
      if (!u) {
        drift++;
        await m.roles.remove(m.roles.cache.filter((r) => managed.has(r.name)), 'role not backed by the database');
        continue;
      }
      if ((await syncMemberRoles(rt, u.user_id)) !== 'in sync') drift++;
    }
    if (drift) await textChannel(rt, CHANNELS.systemAlerts)?.send(`🔧 Role reconciliation fixed ${drift} member(s) whose roles differed from the database.`);
    return `drift ${drift}`;
  });

  runner.register('discord.applicationPost', async ({ applicationId }) => {
    const v = await applicationView(db, applicationId);
    if (!v) return 'missing';
    const forum = forumChannel(rt, CHANNELS.providerApplications);
    if (!forum) throw Object.assign(new Error('#provider-applications not found'), { retryAfterMs: 300_000 });
    const ageDays = v.app.account_created_at ? Math.floor((Date.now() - new Date(v.app.account_created_at).getTime()) / 86_400_000) : null;
    const payload = V.applicationPost({ id: applicationId, code: v.app.code, applicant: v.app.discord_user_id ? `<@${v.app.discord_user_id}>` : '?', accountAge: ageDays == null ? '?' : `${ageDays} days old`, answers: v.app.answers, status: v.app.status, caps: v.caps });
    const statusTagName = v.app.status === 'APPROVED' ? 'Approved' : v.app.status === 'REJECTED' ? 'Rejected' : 'Pending';
    const shortNames = (await many(db, 'SELECT DISTINCT g.short_name FROM provider_capabilities c JOIN games g ON g.id = c.game_id WHERE c.application_id = $1', [applicationId])).map((r) => r.short_name);
    const tags = tagIds(forum, [...shortNames, statusTagName]);
    const existing = await thread(rt, v.app.forum_post_id);
    if (existing) {
      const starter = await existing.fetchStarterMessage().catch(() => null);
      await starter?.edit({ embeds: payload.embeds, components: payload.components });
      if (tags.length) await existing.setAppliedTags(tags);
      if (v.app.status === 'APPROVED' || v.app.status === 'REJECTED') await existing.setArchived(true);
      return 'edited';
    }
    const post = await forum.threads.create({ name: truncate(`${v.app.answers.displayName ?? 'Applicant'} · ${shortNames.join(', ')}`, 100), appliedTags: tags, message: { embeds: payload.embeds, components: payload.components } });
    await db.query('UPDATE provider_applications SET forum_post_id = $2 WHERE id = $1', [applicationId, post.id]);
    return 'created';
  });

  runner.register('discord.payoutPost', async ({ payoutId }) => {
    const p = await one(db, 'SELECT pp.*, pr.code FROM provider_payouts pp JOIN providers pr ON pr.id = pp.provider_id WHERE pp.id = $1', [payoutId]);
    if (!p) return 'missing';
    const ch = textChannel(rt, CHANNELS.finance);
    if (!ch) throw Object.assign(new Error('#finance not found'), { retryAfterMs: 300_000 });
    const payload = V.payoutPost({ id: p.id, code: p.code, amount: fromDecimalString(p.amount), currency: p.currency, status: p.status, method: p.method, externalRef: p.external_ref, requestedAt: p.requested_at, balances: await balances(db, p.provider_id) });
    const existing = p.message_id ? await ch.messages.fetch(p.message_id).catch(() => null) : null;
    if (existing) {
      await existing.edit(payload);
      return 'edited';
    }
    const msg = await ch.send(payload);
    await db.query('UPDATE provider_payouts SET message_id = $2 WHERE id = $1', [payoutId, msg.id]);
    return 'created';
  });

  runner.register('discord.dashboard', async ({ gameId }) => {
    const b = await getBinding(db, gameId);
    const ch = channelById(rt, b?.dashboard_channel_id);
    if (!ch) return 'no channel';
    const game = (await getGame(db, gameId))!;
    const payload = V.dashboardView(game.name, await gameDashboard(db, gameId, rt.ctx.now()), rt.ctx.now());
    const existing = b?.dashboard_message_id ? await ch.messages.fetch(b.dashboard_message_id).catch(() => null) : null;
    if (existing) {
      await existing.edit(payload);
      return 'edited';
    }
    const msg = await ch.send(payload);
    await db.query('UPDATE discord_bindings SET dashboard_message_id = $2 WHERE game_id = $1', [gameId, msg.id]);
    return 'created';
  });

  runner.register('discord.report', async ({ from, to, label }) => {
    const ch = textChannel(rt, CHANNELS.execReports);
    if (!ch) return 'no channel';
    const range = { from: new Date(from), to: new Date(to) };
    const [f, o, rows] = [await financialReport(db, range), await operationalReport(db, range), await reportRows(db, range)];
    const files = rows.length ? [new AttachmentBuilder(Buffer.from(toCsv(rows)), { name: `report-${from.slice(0, 10)}.csv` })] : [];
    await ch.send({ embeds: V.reportEmbeds(label, f, o), files });
    return 'posted';
  });

  runner.register('discord.ticketThread', async ({ ticketId }) => {
    const t = await one(db, `SELECT t.*, d.discord_user_id, g.short_name FROM tickets t JOIN discord_identities d ON d.user_id = t.opener_user_id LEFT JOIN games g ON g.id = t.game_id WHERE t.id = $1`, [ticketId]);
    if (!t || t.thread_id) return 'skip';
    const parent = textChannel(rt, CHANNELS.support);
    if (!parent) throw new Error('#support not found');
    const th = await parent.threads.create({ name: truncate(`${t.code} · ${t.subject}`, 100), type: ChannelType.PrivateThread, invitable: false, autoArchiveDuration: ThreadAutoArchiveDuration.ThreeDays });
    await th.members.add(t.discord_user_id);
    await db.query('UPDATE tickets SET thread_id = $2 WHERE id = $1', [ticketId, th.id]);
    const staffRole = role(rt, t.short_name ? `${t.short_name} Team` : 'Staff');
    await th.send({ content: `🎫 **${t.code}** · ${t.subject}\n<@${t.discord_user_id}>, a staff member will reply here.${staffRole ? ` <@&${staffRole.id}>` : ''}`, allowedMentions: { users: [t.discord_user_id], roles: staffRole ? [staffRole.id] : [] }, components: [buttons([cid('ticket.close', ticketId), 'Close ticket', ButtonStyle.Secondary])] });
    return 'created';
  });

  runner.register('discord.quoteThread', async ({ quoteId }) => {
    const qt = await getQuote(db, quoteId);
    if (!qt) return 'missing';
    const cust = await discordIdOfUser(db, qt.customer_user_id);
    let th = await thread(rt, qt.thread_id);
    const game = (await getGame(db, qt.game_id))!;
    if (!th) {
      const parent = textChannel(rt, CHANNELS.directOrder);
      if (!parent) throw new Error('#direct-order not found');
      th = await parent.threads.create({ name: truncate(`${qt.code} · ${qt.service_name}`, 100), type: ChannelType.PrivateThread, invitable: false, autoArchiveDuration: ThreadAutoArchiveDuration.ThreeDays });
      if (cust) await th.members.add(cust);
      await db.query('UPDATE quotes SET thread_id = $2 WHERE id = $1', [quoteId, th.id]);
      const team = role(rt, `${game.short_name} Team`);
      const spec = Object.entries(qt.spec ?? {}).map(([k, v]) => `**${k}:** ${v}`).join('\n');
      await th.send({
        content: `💬 Quote request **${qt.code}** · ${game.name}${qt.version_name ? ` ${qt.version_name}` : ''} · ${qt.service_name}\n${spec}\n\n${team ? `<@&${team.id}>` : 'Staff'}: reply with **Send quote**.`,
        allowedMentions: { roles: team ? [team.id] : [] },
        components: [buttons([cid('quote.send', quoteId), 'Send quote', ButtonStyle.Primary], [cid('quote.close', quoteId), 'Close', ButtonStyle.Secondary])],
      });
      return 'created';
    }
    if (qt.status === 'QUOTED') {
      const price = formatMoney(fromDecimalString(qt.quoted_price), qt.currency);
      const how = qt.mode === 'REDIRECT'
        ? `Order it here: ${qt.listing_url}\nPut **${qt.code}** in the order note so we can link it.`
        : qt.mode === 'CONVERT' ? 'Staff will create the marketplace order for you and share the link.' : 'Staff will arrange payment with you directly.';
      await th.send({ content: `${cust ? `<@${cust}> ` : ''}Your quote **${qt.code}**: **${price}**.\n${how}`, allowedMentions: { users: cust ? [cust] : [] } });
    }
    return 'updated';
  });

  runner.register('discord.archiveThread', async ({ threadId }) => {
    const t = await thread(rt, threadId);
    if (t && !t.archived) {
      await t.setLocked(true).catch(() => {});
      await t.setArchived(true);
    }
    return 'ok';
  });

  runner.register('discord.customerMessage', async ({ orderId, text }) => {
    const o = await getOrder(db, orderId);
    const post = await thread(rt, o?.forum_post_id);
    if (!post) return 'no post';
    await post.send({
      content: truncate(`💬 **Customer message:**\n>>> ${text}`, 1990),
      allowedMentions: { parse: [] },
      components: o?.order_room_thread_id ? [buttons([cid('order.forward', orderId), 'Forward to provider', ButtonStyle.Secondary])] : [],
    });
    return 'posted';
  });
}

/** Makes a member's TheMerchant-managed roles match the database. */
export async function syncMemberRoles(rt: Runtime, userId: string): Promise<string> {
  const { discordUserId, roles } = await desiredRoleNames(rt.ctx.db, userId);
  const m = await member(rt, discordUserId);
  if (!m) return 'not in server';
  const managed = new Set(await managedRoleNames(rt.ctx.db));
  const want = new Set(roles);
  const add = rt.guild.roles.cache.filter((r) => want.has(r.name) && !m.roles.cache.has(r.id));
  const remove = m.roles.cache.filter((r) => managed.has(r.name) && !want.has(r.name));
  if (add.size) await m.roles.add(add, 'TheMerchant role sync');
  if (remove.size) await m.roles.remove(remove, 'TheMerchant role sync');
  return add.size || remove.size ? `+${add.size} -${remove.size}` : 'in sync';
}
