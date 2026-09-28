// Interaction router. Every handler resolves the actor from the database and
// calls a service; services enforce authorization (§26). Replies about money,
// bids and stats are ephemeral.
import {
  ActionRowBuilder, type AutocompleteInteraction, ButtonBuilder, type ButtonInteraction, ButtonStyle, type ChatInputCommandInteraction,
  EmbedBuilder, type Interaction, LabelBuilder, MessageFlags, ModalBuilder, type ModalSubmitInteraction, type MessageActionRowComponentBuilder,
  StringSelectMenuBuilder, type StringSelectMenuInteraction, TextInputBuilder, TextInputStyle, type User,
} from 'discord.js';
import { can } from '../core/authz.js';
import { fromDecimalString, parseMoney } from '../core/money.js';
import { type Actor, DomainError, type Level, type RiskTier, type ScoringProfile } from '../core/types.js';
import { many, one } from '../db/pool.js';
import { cid, mid, parseCid } from '../discord-ui/ids.js';
import { clip, money, pct } from '../discord-ui/format.js';
import * as V from '../discord-ui/views.js';
import { closeBiddingNow, declineInvitation, myBid, reopenBidding, submitBid, withdrawBid } from '../services/bidding.js';
import { getGameByCode, getService, listCategories, listGames, listServices, mapListing, setFeeRule, updateService } from '../services/catalog.js';
import type { Ctx } from '../services/context.js';
import { cancelOrder, markDelivered, markProviderFailed, openDispute, recordCompletion, recordRefund, resolveDispute, startWork } from '../services/fulfillment.js';
import { classifyOrder, confirmPayment, importManualOrder } from '../services/intake.js';
import { enqueue } from '../services/jobs.js';
import { adjustBalance, balances, decidePayout, ledgerHistory, requestPayout } from '../services/ledger.js';
import { addCost, addNote, authorizeOrder, editMoney, findOrder, getOrder } from '../services/orders.js';
import { acceptProviderRules, getProviderByUser, liftSuspension, providerStats, requestCapabilities, revealPayoutDetails, reviewApplication, setAvailability, setLevelManually, setPayoutDetails, submitApplication, suspendProvider, type CapabilityRequest } from '../services/providers.js';
import { closeQuote, closeTicket, openTicket, requestQuote, sendQuote } from '../services/quotes.js';
import { financialReport, operationalReport, providerPerformance, zonedMidnight } from '../services/reports.js';
import { assignBid, confirmAssignment, releaseAssignment } from '../services/selection.js';
import { DEFAULT_SETTINGS, getSettings, setSetting } from '../services/settings.js';
import { resolveActor, setStaffRole, snowflakeTime } from '../services/users.js';
import { audit } from '../services/audit.js';
import { staffOrderView } from './loaders.js';
import { syncMemberRoles } from './effects.js';
import { CHANNELS, type Runtime, textChannel, thread } from './runtime.js';

const EPH = { flags: MessageFlags.Ephemeral } as const;
type Row = ActionRowBuilder<MessageActionRowComponentBuilder>;
const row = (...c: MessageActionRowComponentBuilder[]): Row => new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(...c);

const du = (u: User) => ({ id: u.id, username: u.username, createdAt: snowflakeTime(u.id) });

function text(id: string, label: string, opts: { style?: TextInputStyle; required?: boolean; placeholder?: string; value?: string; max?: number } = {}): LabelBuilder {
  const input = new TextInputBuilder().setCustomId(id).setStyle(opts.style ?? TextInputStyle.Short).setRequired(opts.required ?? true);
  if (opts.placeholder) input.setPlaceholder(opts.placeholder);
  if (opts.value) input.setValue(opts.value);
  if (opts.max) input.setMaxLength(opts.max);
  return new LabelBuilder().setLabel(label).setTextInputComponent(input);
}

function modal(customId: string, title: string, ...labels: LabelBuilder[]): ModalBuilder {
  return new ModalBuilder().setCustomId(customId).setTitle(clip(title, 45)).addLabelComponents(...labels.slice(0, 5));
}

// ------------------------------------------------------------------ application drafts (in memory, short-lived)

interface Draft { answers?: { displayName: string; timezone: string; experience: string; proofLink: string | null }; games: string[]; cats: Record<string, string[]>; expires: number }
const drafts = new Map<string, Draft>();
const draftOf = (userId: string): Draft => {
  const d = drafts.get(userId);
  if (d && d.expires > Date.now()) return d;
  const fresh = { games: [], cats: {}, expires: Date.now() + 30 * 60_000 };
  drafts.set(userId, fresh);
  return fresh;
};

export function createInteractionHandler(rt: Runtime) {
  const ctx: Ctx = { ...rt.ctx, source: 'DISCORD' };
  const db = ctx.db;
  const actorFor = async (u: User): Promise<Actor> => (await resolveActor(db, du(u))).actor;

  async function fail(i: Interaction, err: unknown): Promise<void> {
    const known = err instanceof DomainError;
    if (!known) rt.log.error({ err: (err as Error).message, stack: (err as Error).stack }, 'interaction failed');
    const msg = known ? `⚠️ ${(err as Error).message}` : '⚠️ Something went wrong. Staff have been notified.';
    if (!known) await enqueue(db, 'discord.alert', { channel: 'system-alerts', text: `Interaction error: ${clip((err as Error).message ?? String(err), 500)}` }).catch(() => {});
    if (!i.isRepliable()) return;
    if (i.deferred || i.replied) await i.editReply({ content: msg, embeds: [], components: [] }).catch(() => {});
    else await i.reply({ content: msg, ...EPH }).catch(() => {});
  }

  /** Defers ephemerally, runs fn, and shows its string/payload result. */
  async function ephemeral(i: ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction | ChatInputCommandInteraction, fn: () => Promise<string | V.Payload | { embeds: EmbedBuilder[]; files?: any[] }>) {
    await i.deferReply(EPH);
    const r = await fn();
    await i.editReply(typeof r === 'string' ? { content: r } : (r as any));
  }

  const orderPostRefresh = (orderId: string) => enqueue(db, 'discord.orderPost', { orderId }, { dedupeKey: `orderPost:${orderId}` });

  // ================================================================ buttons & selects

  async function onComponent(i: ButtonInteraction | StringSelectMenuInteraction): Promise<void> {
    const parsed = parseCid(i.customId);
    if (!parsed) return;
    const [a0, a1] = parsed.args;
    switch (parsed.verb) {
      // ---------------------------------------------------------- onboarding
      case 'welcome.customer':
        return ephemeral(i, async () => {
          const { user } = await resolveActor(db, du(i.user));
          await syncMemberRoles(rt, user.id);
          return `You're all set. See <#${textChannel(rt, 'how-to-order')?.id ?? ''}> to order and <#${textChannel(rt, CHANNELS.support)?.id ?? ''}> for help.`;
        });
      case 'welcome.provider': {
        const s = await getSettings(db);
        await i.reply({ ...V.providerRulesPrompt(s.providerRulesVersion), ...EPH });
        return;
      }
      case 'rules.accept':
        return ephemeral(i, async () => {
          const p = await acceptProviderRules(ctx, du(i.user));
          await syncMemberRoles(rt, p.user_id);
          return p.status === 'ACTIVE' ? 'Rules accepted. You are already an approved provider.' : `Rules accepted. Continue in <#${textChannel(rt, CHANNELS.providerApply)?.id ?? ''}>.`;
        });
      case 'apply.start': {
        const games = await listGames(db);
        await i.showModal(
          modal(mid('apply.start'), 'Provider application',
            text('name', 'Display name'),
            text('tz', 'Timezone', { placeholder: 'e.g. Europe/Madrid or UTC+1' }),
            text('exp', 'Experience', { style: TextInputStyle.Paragraph, placeholder: 'What you have done, for how long, where', max: 1000 }),
            text('proof', 'Proof or references (link, optional)', { required: false }),
            new LabelBuilder().setLabel('Games').setStringSelectMenuComponent(new StringSelectMenuBuilder().setCustomId('games').setMinValues(1).setMaxValues(games.length).addOptions(games.map((g) => ({ label: g.name, value: g.id, emoji: g.emoji ?? undefined })))),
          ),
        );
        return;
      }
      case 'panel.moreCaps': {
        const games = await listGames(db);
        const d = draftOf(i.user.id);
        d.answers = undefined;
        await i.reply({ content: 'Which games do you want to add services for?', components: [row(new StringSelectMenuBuilder().setCustomId(cid('apply.games')).setMinValues(1).setMaxValues(games.length).addOptions(games.map((g) => ({ label: g.name, value: g.id }))))], ...EPH });
        return;
      }
      case 'apply.games': {
        const d = draftOf(i.user.id);
        d.games = (i as StringSelectMenuInteraction).values;
        await i.update(await categoryPicker(d));
        return;
      }
      case 'apply.cats': {
        const d = draftOf(i.user.id);
        d.cats[a0!] = (i as StringSelectMenuInteraction).values;
        await i.update(await categoryPicker(d));
        return;
      }
      case 'apply.cancel':
        drafts.delete(i.user.id);
        await i.update({ content: 'Cancelled.', components: [], embeds: [] });
        return;
      case 'apply.submit': {
        const d = draftOf(i.user.id);
        const caps: CapabilityRequest[] = Object.entries(d.cats).flatMap(([gameId, cats]) => cats.map((categoryId) => ({ gameId, categoryId })));
        await i.deferUpdate();
        try {
          if (d.answers) await submitApplication(ctx, du(i.user), { ...d.answers, capabilities: caps });
          else await requestCapabilities(ctx, du(i.user), caps);
          drafts.delete(i.user.id);
          await i.editReply({ content: '✅ Submitted. The managers of each game will review it; you\'ll get a DM with the result.', components: [], embeds: [] });
        } catch (err) {
          await fail(i, err);
        }
        return;
      }
      // ---------------------------------------------------------- provider panel
      case 'panel.availability':
        return ephemeral(i, async () => {
          const state = (i as StringSelectMenuInteraction).values[0] as 'AVAILABLE' | 'BUSY' | 'OFFLINE';
          await setAvailability(ctx, await actorFor(i.user), state);
          return `Availability set to **${state.toLowerCase()}**.`;
        });
      case 'panel.balance':
        return ephemeral(i, async () => {
          const pid = await providerIdOf(i.user);
          const hist = await ledgerHistory(db, pid, 8);
          return V.balanceReply(await balances(db, pid), 'EUR', hist.map((h) => ({ ...h, amount: fromDecimalString(h.amount) })));
        });
      case 'panel.stats':
        return ephemeral(i, async () => {
          const s = await providerStats(db, await providerIdOf(i.user));
          return V.statsReply({ code: s.provider?.code ?? null, level: s.provider?.level ?? 'NEW', reputation: s.provider?.reputation == null ? null : Number(s.provider.reputation), completed: s.completed, active: s.active, invites30: s.invites30, bids30: s.bids30, availability: s.availability, components: s.reputation?.components ?? null });
        });
      case 'panel.caps':
        return ephemeral(i, async () => V.capabilitiesReply((await providerStats(db, await providerIdOf(i.user))).capabilities));
      case 'panel.payoutDetails':
        await i.showModal(modal(mid('panel.payoutDetails'), 'Payout details (encrypted)', text('details', 'IBAN / PayPal / crypto address and name', { style: TextInputStyle.Paragraph, max: 500 })));
        return;
      case 'panel.payout':
        await i.showModal(modal(mid('panel.payout'), 'Request payout', text('amount', 'Amount', { placeholder: 'e.g. 120.00' }), text('method', 'Method', { placeholder: 'IBAN / PayPal / ...' })));
        return;
      // ---------------------------------------------------------- tickets & quotes
      case 'ticket.open':
        await i.showModal(modal(mid('ticket.open'), 'Open a ticket', text('subject', 'What do you need help with?', { max: 200 })));
        return;
      case 'ticket.close':
        return ephemeral(i, async () => {
          await closeTicket(ctx, await actorFor(i.user), a0!);
          return 'Ticket closed.';
        });
      case 'quote.open': {
        const games = await listGames(db);
        await i.reply({ content: 'Pick a game:', components: [row(new StringSelectMenuBuilder().setCustomId(cid('quote.game')).addOptions(games.map((g) => ({ label: g.name, value: g.id }))))], ...EPH });
        return;
      }
      case 'quote.game': {
        const cats = await listCategories(db, (i as StringSelectMenuInteraction).values[0]!);
        await i.update({ content: 'Pick a category:', components: [row(new StringSelectMenuBuilder().setCustomId(cid('quote.cat')).addOptions(cats.slice(0, 25).map((c) => ({ label: c.name, value: c.id }))))] });
        return;
      }
      case 'quote.cat': {
        const svcs = await listServices(db, (i as StringSelectMenuInteraction).values[0]!);
        await i.update({ content: 'Pick a service:', components: [row(new StringSelectMenuBuilder().setCustomId(cid('quote.service')).addOptions(svcs.slice(0, 25).map((s) => ({ label: clip(s.name, 100), value: s.id }))))] });
        return;
      }
      case 'quote.service': {
        const s = (await getService(db, (i as StringSelectMenuInteraction).values[0]!))!;
        const fields = s.requirement_schema.slice(0, 4).map((r) => text(`r:${r.key}`, clip(r.label, 45), { required: r.required, max: 200 }));
        await i.showModal(modal(mid('quote.service', s.id), `Quote: ${s.name}`, ...fields, text('r:details', 'What exactly do you need?', { style: TextInputStyle.Paragraph, max: 1000 })));
        return;
      }
      case 'quote.send':
        await i.showModal(modal(mid('quote.send', a0!), 'Send quote', text('price', 'Price', { placeholder: 'e.g. 45.00' }),
          new LabelBuilder().setLabel('How the customer orders').setStringSelectMenuComponent(new StringSelectMenuBuilder().setCustomId('mode').addOptions({ label: 'Redirect to our marketplace listing', value: 'REDIRECT', default: true }, { label: 'Staff create the marketplace order', value: 'CONVERT' })),
          text('url', 'Marketplace listing link (for redirect)', { required: false, placeholder: 'https://...' })));
        return;
      case 'quote.close':
        return ephemeral(i, async () => {
          await closeQuote(ctx, await actorFor(i.user), a0!);
          return 'Quote closed.';
        });
      // ---------------------------------------------------------- applications
      case 'app.approve':
        return ephemeral(i, async () => {
          const r = await reviewApplication(ctx, await actorFor(i.user), a0!, a1!, 'APPROVE');
          return `Approved. Application is now ${r.status}.${r.firstApproval ? ' Provider profile created.' : ''}`;
        });
      case 'app.reject':
        await i.showModal(modal(mid('app.reject', a0!, a1!), 'Reject application', text('reason', 'Reason (sent to the applicant)', { style: TextInputStyle.Paragraph, max: 500 })));
        return;
      // ---------------------------------------------------------- bidding
      case 'bid.open': {
        const a = await actorFor(i.user);
        const prev = a.kind === 'USER' && a.providerId ? await myBid(db, a0!, a.providerId) : null;
        await i.showModal(modal(mid('bid.open', a0!), 'Submit sealed bid',
          text('amount', 'Your price (EUR)', { placeholder: 'e.g. 29.00', value: prev ? prev.amount : undefined }),
          text('start', 'Can start in (minutes)', { placeholder: '0', value: prev ? String(prev.eta_start_min) : undefined }),
          text('duration', 'Takes (minutes)', { placeholder: '45', value: prev ? String(prev.eta_duration_min) : undefined }),
          text('note', 'Note for staff (optional)', { required: false, max: 300, value: prev?.note ?? undefined })));
        return;
      }
      case 'bid.decline':
        return ephemeral(i, async () => {
          await declineInvitation(ctx, await actorFor(i.user), a0!);
          return 'Declined. Thanks for letting us know.';
        });
      case 'bid.withdraw':
        return ephemeral(i, async () => {
          await withdrawBid(ctx, await actorFor(i.user), a0!);
          return 'Your bid was withdrawn.';
        });
      case 'assign.confirm':
        return ephemeral(i, async () => {
          const o = await confirmAssignment(ctx, await actorFor(i.user), a0!);
          return `✅ Confirmed ${o.internal_order_id}. Your order room is being created.`;
        });
      case 'assign.decline':
        return ephemeral(i, async () => {
          await releaseAssignment(ctx, await actorFor(i.user), a0!, 'DECLINED', 'declined by provider');
          return 'Declined. The order goes to the next provider.';
        });
      // ---------------------------------------------------------- staff order post
      case 'order.refresh':
        await orderPostRefresh(a0!);
        await i.reply({ content: 'Refreshing…', ...EPH });
        return;
      case 'order.close':
        return ephemeral(i, async () => {
          await closeBiddingNow(ctx, await actorFor(i.user), a0!);
          return 'Bidding closed. The score table is on the post.';
        });
      case 'order.assignRec':
        return ephemeral(i, async () => {
          await assignBid(ctx, await actorFor(i.user), a0!, a1!);
          return 'Assigned. The provider has been asked to confirm.';
        });
      case 'order.pick': {
        const bidId = (i as StringSelectMenuInteraction).values[0]!;
        await i.showModal(modal(mid('order.pick', a0!, bidId), 'Override the recommendation', text('reason', 'Why this provider? (logged)', { style: TextInputStyle.Paragraph, max: 500 })));
        return;
      }
      case 'order.reopen':
        return ephemeral(i, async () => {
          const a = await actorFor(i.user);
          const o = await getOrder(db, a0!);
          if (!o) throw new DomainError('NOT_FOUND', 'order not found');
          await authorizeOrder(db, a, 'order.reopenBidding', o);
          const n = await reopenBidding(ctx, a, a0!, 'reopened by staff');
          return `Bidding reopened; ${n} provider(s) invited.`;
        });
      case 'order.cancel':
        await i.showModal(modal(mid('order.cancel', a0!), 'Cancel order', text('reason', 'Reason (logged)', { style: TextInputStyle.Paragraph, max: 500 })));
        return;
      case 'order.paid':
        return ephemeral(i, async () => {
          const o = await confirmPayment(ctx, await actorFor(i.user), a0!);
          return `Payment recorded. Order is ${o.status}.`;
        });
      case 'order.delivered':
      case 'room.deliver':
        await i.showModal(modal(mid('order.delivered', a0!), 'Mark delivered', text('note', 'Delivery note or proof link', { style: TextInputStyle.Paragraph, max: 1000 })));
        return;
      case 'order.failed':
        await i.showModal(modal(mid('order.failed', a0!), 'Provider failed', text('reason', 'What happened? (logged, affects reputation)', { style: TextInputStyle.Paragraph, max: 500 })));
        return;
      case 'order.complete':
        return ephemeral(i, async () => {
          const o = await recordCompletion(ctx, await actorFor(i.user), a0!);
          return `🏁 ${o.internal_order_id} completed. The provider earning is on hold until the hold period ends.`;
        });
      case 'order.escalate':
        return ephemeral(i, async () => {
          const a = await actorFor(i.user);
          const o = await getOrder(db, a0!);
          if (!o) throw new DomainError('NOT_FOUND', 'order not found');
          await authorizeOrder(db, a, 'order.note', o);
          await enqueue(db, 'discord.alert', { channel: 'ops', gameId: o.game_id, mentionManagers: true, text: `📣 ${i.user.username} escalated ${o.internal_order_id} (${o.status}).` });
          await addNote(ctx, a, o.id, 'escalated to managers');
          return 'Managers have been pinged.';
        });
      case 'order.forward':
        return ephemeral(i, async () => {
          const a = await actorFor(i.user);
          const o = await getOrder(db, a0!);
          if (!o) throw new DomainError('NOT_FOUND', 'order not found');
          await authorizeOrder(db, a, 'order.note', o);
          const room = await thread(rt, o.order_room_thread_id);
          if (!room) throw new DomainError('NOT_FOUND', 'no order room');
          const content = (i as ButtonInteraction).message.content.replace(/^💬 \*\*Customer message:\*\*\n>>> /, '');
          await room.send({ content: clip(`💬 From the customer (via staff):\n>>> ${content}`, 1990), allowedMentions: { parse: [] } });
          return 'Forwarded to the order room.';
        });
      case 'room.start':
        return ephemeral(i, async () => {
          await startWork(ctx, await actorFor(i.user), a0!);
          return '▶️ Marked as in progress.';
        });
      case 'room.issue':
        await i.showModal(modal(mid('room.issue', a0!), 'Report an issue', text('text', 'What is the problem?', { style: TextInputStyle.Paragraph, max: 1000 })));
        return;
      // ---------------------------------------------------------- finance
      case 'payout.approve':
        return ephemeral(i, async () => {
          await decidePayout(ctx, await actorFor(i.user), a0!, 'APPROVE');
          return 'Approved. Mark it paid once the transfer is sent.';
        });
      case 'payout.paid':
        await i.showModal(modal(mid('payout.paid', a0!), 'Mark payout paid', text('ref', 'Transfer reference')));
        return;
      case 'payout.reject':
        await i.showModal(modal(mid('payout.reject', a0!), 'Reject payout', text('reason', 'Reason (sent to the provider)', { max: 300 })));
        return;
      default:
        return;
    }
  }

  async function providerIdOf(u: User): Promise<string> {
    const a = await actorFor(u);
    if (a.kind !== 'USER' || !a.providerId) throw new DomainError('FORBIDDEN', 'this panel is for approved providers');
    return a.providerId;
  }

  async function categoryPicker(d: Draft): Promise<{ content: string; components: Row[] }> {
    const rows: Row[] = [];
    for (const gameId of d.games.slice(0, 4)) {
      const game = (await one(db, 'SELECT name FROM games WHERE id = $1', [gameId]))!;
      const cats = await listCategories(db, gameId);
      rows.push(row(new StringSelectMenuBuilder().setCustomId(cid('apply.cats', gameId)).setPlaceholder(`${game.name}: pick what you can deliver`).setMinValues(1).setMaxValues(Math.min(25, cats.length))
        .addOptions(cats.slice(0, 25).map((c) => ({ label: c.name, value: c.id, default: (d.cats[gameId] ?? []).includes(c.id) })))));
    }
    const ready = d.games.every((g) => (d.cats[g] ?? []).length);
    rows.push(row(new ButtonBuilder().setCustomId(cid('apply.submit')).setLabel('Submit').setStyle(ButtonStyle.Success).setDisabled(!ready), new ButtonBuilder().setCustomId(cid('apply.cancel')).setLabel('Cancel').setStyle(ButtonStyle.Secondary)));
    return { content: 'Pick the service categories you can deliver in each game, then **Submit**. Each game\'s manager approves their part.', components: rows };
  }

  // ================================================================ modals

  async function onModal(i: ModalSubmitInteraction): Promise<void> {
    const parsed = parseCid(i.customId);
    if (!parsed?.modal) return;
    const [a0, a1] = parsed.args;
    const f = (k: string) => i.fields.getTextInputValue(k).trim();
    const opt = (k: string) => {
      try {
        return i.fields.getTextInputValue(k).trim() || null;
      } catch {
        return null;
      }
    };
    switch (parsed.verb) {
      case 'apply.start': {
        const d = draftOf(i.user.id);
        d.answers = { displayName: f('name'), timezone: f('tz'), experience: f('exp'), proofLink: opt('proof') };
        d.games = [...i.fields.getStringSelectValues('games')];
        d.cats = {};
        await i.reply({ ...(await categoryPicker(d)), ...EPH });
        return;
      }
      case 'panel.payoutDetails':
        return ephemeral(i, async () => {
          await setPayoutDetails(ctx, await actorFor(i.user), f('details'));
          return '🔒 Saved (encrypted). Only executives can view them, and every view is logged.';
        });
      case 'panel.payout':
        return ephemeral(i, async () => {
          const pid = await providerIdOf(i.user);
          await requestPayout(ctx, await actorFor(i.user), pid, f('amount'), f('method'));
          return '💸 Payout requested. An executive will review it in #finance.';
        });
      case 'ticket.open':
        return ephemeral(i, async () => {
          const t = await openTicket(ctx, await actorFor(i.user), { subject: f('subject') });
          return `🎫 Ticket **${t.code}** opened. A private thread is being created for you in #support.`;
        });
      case 'quote.service':
        return ephemeral(i, async () => {
          const spec: Record<string, string> = {};
          for (const c of i.fields.fields.values()) if ('value' in c && c.customId.startsWith('r:') && c.value) spec[c.customId.slice(2)] = String(c.value);
          const q = await requestQuote(ctx, await actorFor(i.user), { serviceId: a0!, spec });
          return `💬 Quote **${q.code}** requested. Staff will reply in a private thread in #direct-order.`;
        });
      case 'quote.send':
        return ephemeral(i, async () => {
          const mode = (i.fields.getStringSelectValues('mode')[0] ?? 'REDIRECT') as 'REDIRECT' | 'CONVERT';
          await sendQuote(ctx, await actorFor(i.user), a0!, { price: f('price'), mode, listingUrl: opt('url') });
          return 'Quote sent to the customer.';
        });
      case 'app.reject':
        return ephemeral(i, async () => {
          const r = await reviewApplication(ctx, await actorFor(i.user), a0!, a1!, 'REJECT', f('reason'));
          return `Rejected. Application is now ${r.status}.`;
        });
      case 'bid.open':
        return ephemeral(i, async () => {
          const r = await submitBid(ctx, await actorFor(i.user), a0!, { amount: f('amount'), etaStartMin: toInt(f('start')), etaDurationMin: toInt(f('duration')), note: opt('note') });
          return V.bidReceipt(r.orderCode, r.amount, r.currency, r.replaced, r.windowEndsAt, a0!);
        });
      case 'order.pick':
        return ephemeral(i, async () => {
          const r = await assignBid(ctx, await actorFor(i.user), a0!, a1!, f('reason'));
          return r.overridden ? 'Assigned (override logged). The provider has been asked to confirm.' : 'Assigned. The provider has been asked to confirm.';
        });
      case 'order.cancel':
        return ephemeral(i, async () => {
          const o = await cancelOrder(ctx, await actorFor(i.user), a0!, f('reason'));
          return `🛑 ${o.internal_order_id} cancelled.`;
        });
      case 'order.delivered':
        return ephemeral(i, async () => {
          const o = await markDelivered(ctx, await actorFor(i.user), a0!, f('note'));
          return `📦 ${o.internal_order_id} marked delivered.`;
        });
      case 'order.failed':
        return ephemeral(i, async () => {
          const o = await markProviderFailed(ctx, await actorFor(i.user), a0!, f('reason'));
          return `Recorded. ${o.internal_order_id} is now ${o.status.replace(/_/g, ' ').toLowerCase()}.`;
        });
      case 'room.issue':
        return ephemeral(i, async () => {
          const a = await actorFor(i.user);
          const o = await getOrder(db, a0!);
          if (!o) throw new DomainError('NOT_FOUND', 'order not found');
          await authorizeOrder(db, a, 'order.work', o);
          await enqueue(db, 'discord.alert', { channel: 'ops', gameId: o.game_id, text: `⚠️ Issue reported on ${o.internal_order_id} by ${i.user.username}: ${clip(f('text'), 1500)}` });
          await audit(db, { actor: a, action: 'ISSUE_REPORTED', objectType: 'order', objectId: o.internal_order_id, reason: f('text'), source: 'DISCORD' });
          return 'Staff have been notified.';
        });
      case 'payout.paid':
        return ephemeral(i, async () => {
          await decidePayout(ctx, await actorFor(i.user), a0!, 'PAID', f('ref'));
          return 'Marked paid. The provider has been notified.';
        });
      case 'payout.reject':
        return ephemeral(i, async () => {
          await decidePayout(ctx, await actorFor(i.user), a0!, 'REJECT', null, f('reason'));
          return 'Rejected. The amount went back to their available balance.';
        });
      default:
        return;
    }
  }

  // ================================================================ slash commands

  async function orderByRef(ref: string) {
    const o = await findOrder(db, ref);
    if (!o) throw new DomainError('NOT_FOUND', `no order matches "${ref}"`);
    return o;
  }

  async function providerByCode(code: string) {
    const p = await one(db, 'SELECT * FROM providers WHERE upper(code) = upper($1)', [code.trim()]);
    if (!p) throw new DomainError('NOT_FOUND', `no provider ${code}`);
    return p;
  }

  async function onCommand(i: ChatInputCommandInteraction): Promise<void> {
    const sub = i.options.getSubcommand(false);
    const s = (k: string) => i.options.getString(k);
    const S = (k: string) => i.options.getString(k, true);
    const key = sub ? `${i.commandName} ${sub}` : i.commandName;

    if (key === 'order import' || key === 'order classify') {
      // Requirements come from the service, so they're asked for in a modal.
      const serviceId = key === 'order import' ? S('service') : s('service') ?? (await orderByRef(S('order'))).service_id;
      const service = serviceId ? await getService(db, serviceId) : null;
      if (!service) {
        await i.reply({ content: '⚠️ Pick a service from the list.', ...EPH });
        return;
      }
      const existing = key === 'order classify' ? await orderByRef(S('order')) : null;
      const token = pending.put({ key, options: Object.fromEntries(i.options.data[0]!.options!.map((o) => [o.name, o.value])), serviceId: service.id, orderId: existing?.id ?? null });
      await i.showModal(modal(mid('order.import', token), `Requirements: ${service.name}`, ...service.requirement_schema.slice(0, 5).map((r) => text(`r:${r.key}`, clip(r.label, 45), { required: r.required, max: 200, value: existing?.configuration?.[r.key] }))));
      return;
    }

    return ephemeral(i, async () => {
      const actor = await actorFor(i.user);
      switch (key) {
        case 'order find': {
          const o = await orderByRef(S('order'));
          if (actor.kind === 'USER' && can(actor, 'order.viewFinancials', { gameId: o.game_id })) {
            const view = V.staffOrderPost(await staffOrderView(db, o, ctx.now()));
            return { embeds: view.embeds, components: [] };
          }
          await authorizeOrder(db, actor, 'order.view', o);
          return `${o.internal_order_id}: ${o.status.replace(/_/g, ' ').toLowerCase()}`;
        }
        case 'order note':
          await addNote(ctx, actor, (await orderByRef(S('order'))).id, S('text'));
          return 'Note added.';
        case 'order price': {
          const o = await editMoney(ctx, actor, (await orderByRef(S('order'))).id, S('field') as any, S('amount'), S('reason'));
          return `Updated ${o.internal_order_id}.`;
        }
        case 'order cost':
          await addCost(ctx, actor, (await orderByRef(S('order'))).id, S('type'), S('amount'), S('note'));
          return 'Cost recorded.';
        case 'order refund': {
          const o = await recordRefund(ctx, actor, (await orderByRef(S('order'))).id, { amount: S('amount'), liability: S('liability') as any, reason: S('reason'), providerShare: s('provider_share') });
          return `Refund recorded. ${o.internal_order_id} is ${o.status}.`;
        }
        case 'order cancel': {
          const o = await cancelOrder(ctx, actor, (await orderByRef(S('order'))).id, S('reason'));
          return `${o.internal_order_id} cancelled.`;
        }
        case 'order complete': {
          const o = await recordCompletion(ctx, actor, (await orderByRef(S('order'))).id, { rating: i.options.getInteger('rating') });
          return `${o.internal_order_id} completed.`;
        }
        case 'order dispute': {
          const o = await openDispute(ctx, actor, (await orderByRef(S('order'))).id, S('reason'));
          return `Dispute opened on ${o.internal_order_id}.`;
        }
        case 'order resolve': {
          const o = await resolveDispute(ctx, actor, (await orderByRef(S('order'))).id, S('outcome') as any, S('notes'));
          return `Dispute resolved. ${o.internal_order_id} is ${o.status}.`;
        }
        case 'staff set': {
          const user = i.options.getUser('user', true);
          const codes = (s('games') ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
          const gameIds: string[] = [];
          for (const c of codes) {
            const g = await getGameByCode(db, c);
            if (!g) throw new DomainError('NOT_FOUND', `unknown game code "${c}"`);
            gameIds.push(g.id);
          }
          const u = await setStaffRole(ctx, actor, du(user), { role: S('role') as any, gameIds, approvalLimit: s('approval_limit') });
          return `${user.username} is now ${u.org_role}${codes.length ? ` for ${codes.join(', ')}` : ''}. Discord team roles are synced by TheMerchant; Executive/Manager/Staff roles sit above the bot, so assign those in Discord yourself.`;
        }
        case 'provider info': {
          const p = await providerByCode(S('code'));
          const games = (await many(db, 'SELECT DISTINCT game_id FROM provider_capabilities WHERE provider_id = $1', [p.id])).map((r) => r.game_id);
          if (!(actor.kind === 'USER' && (actor.orgRole === 'EXECUTIVE' || games.some((g) => can(actor, 'provider.viewStats', { gameId: g }))))) throw new DomainError('FORBIDDEN', 'not one of your providers');
          const st = await providerStats(db, p.id);
          const view = V.statsReply({ code: p.code, level: p.level, reputation: p.reputation == null ? null : Number(p.reputation), completed: st.completed, active: st.active, invites30: st.invites30, bids30: st.bids30, availability: st.availability, components: st.reputation?.components ?? null });
          view.embeds.push(V.capabilitiesReply(st.capabilities).embeds[0]!);
          if (actor.kind === 'USER' && actor.orgRole === 'EXECUTIVE') {
            const b = await balances(db, p.id);
            view.embeds.push(new EmbedBuilder().setTitle('Balance').setDescription(`available ${money(b.available)} · pending ${money(b.pending)} · reserved ${money(b.reserved)} · paid ${money(b.paid)} · lifetime ${money(b.lifetime)}`));
          }
          return view;
        }
        case 'provider suspend':
          await suspendProvider(ctx, actor, (await providerByCode(S('code'))).id, S('reason'), s('game'));
          return 'Suspended.';
        case 'provider unsuspend':
          await liftSuspension(ctx, actor, (await providerByCode(S('code'))).id, s('game'));
          return 'Suspension lifted.';
        case 'provider level':
          await setLevelManually(ctx, actor, (await providerByCode(S('code'))).id, S('level') as Level, S('reason'));
          return 'Level updated.';
        case 'provider reveal-payout':
          return `🔒 ${await revealPayoutDetails(ctx, actor, (await providerByCode(S('code'))).id, S('reason'))}\n(This reveal was logged.)`;
        case 'provider adjust':
          await adjustBalance(ctx, actor, (await providerByCode(S('code'))).id, S('type') as any, S('amount'), S('memo'));
          return 'Balance adjusted.';
        case 'report': {
          if (!can(actor, 'report.executive')) throw new DomainError('FORBIDDEN', 'executives only');
          const st = await getSettings(db);
          const d = (x: string) => {
            const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(x.trim());
            if (!m) throw new DomainError('INVALID', 'dates must be YYYY-MM-DD');
            return zonedMidnight(Number(m[1]), Number(m[2]), Number(m[3]), st.timezone);
          };
          const range = { from: d(S('from')), to: new Date(d(S('to')).getTime() + 86_400_000) };
          return { embeds: V.reportEmbeds(`Report ${S('from')} → ${S('to')} (${st.timezone})`, await financialReport(db, range), await operationalReport(db, range)) };
        }
        case 'dashboard': {
          const rows = await providerPerformance(db, actor, S('game'));
          const lines = rows.map((r) => `${r.code} · ${r.level} · rep ${r.reputation ?? '—'} · ${r.completed}/${r.orders} done · ${r.failed} failed · ${r.disputed} disputes · ${r.availability.toLowerCase()}`);
          const fin = await financialReport(db, { from: new Date(Date.now() - 30 * 86_400_000), to: new Date() }, [S('game')]);
          return { embeds: [new EmbedBuilder().setTitle('Provider performance').setDescription(clip(lines.join('\n') || 'No provider history yet.', 4000)), new EmbedBuilder().setTitle('Last 30 days').setDescription(`${fin.orders} orders · gross ${money(fin.gross)} · profit ${money(fin.profit)} · margin ${pct(fin.marginPct)}`)] };
        }
        case 'settings show': {
          if (!can(actor, 'settings.manage')) throw new DomainError('FORBIDDEN', 'executives only');
          const st = await getSettings(db);
          return '```json\n' + clip(JSON.stringify(st, null, 2), 1900) + '\n```';
        }
        case 'settings set': {
          if (!can(actor, 'settings.manage')) throw new DomainError('FORBIDDEN', 'executives only');
          let value: unknown;
          try {
            value = JSON.parse(S('value'));
          } catch {
            throw new DomainError('INVALID', 'value must be JSON (numbers as 0.15, text in "quotes")');
          }
          const k = S('key') as keyof typeof DEFAULT_SETTINGS;
          const old = await db.tx(async (q) => {
            const prev = await setSetting(q, k, value, actor.kind === 'USER' ? actor.userId : null);
            await audit(q, { actor, action: 'SETTING_CHANGED', objectType: 'setting', objectId: k, oldValue: prev, newValue: value, source: 'DISCORD', important: true });
            return prev;
          });
          return `\`${k}\`: ${JSON.stringify(old)} → ${JSON.stringify(value)}`;
        }
        case 'catalog map-listing': {
          const st = await getSettings(db);
          await mapListing(ctx, actor, { marketplace: st.marketplace, listingId: S('listing_id'), serviceId: S('service'), versionId: s('version') });
          return 'Listing mapped.';
        }
        case 'catalog fee-rule': {
          const st = await getSettings(db);
          await setFeeRule(ctx, actor, { marketplace: st.marketplace, rate: i.options.getNumber('rate', true), gameId: s('game'), serviceId: s('service') });
          return 'Fee rule saved.';
        }
        case 'catalog service': {
          const patch: any = {};
          if (s('risk')) patch.risk_tier = s('risk') as RiskTier;
          if (s('profile')) patch.scoring_profile = s('profile') as ScoringProfile;
          const trial = i.options.getBoolean('trial');
          if (trial != null) patch.trial_eligible = trial;
          const w = i.options.getInteger('window_minutes');
          if (w != null) patch.bid_window_seconds = w * 60;
          const h = i.options.getInteger('hold_days');
          if (h != null) patch.hold_days = h;
          if (s('ceiling')) patch.bid_ceiling = s('ceiling') === 'none' ? null : s('ceiling');
          const act = i.options.getBoolean('active');
          if (act != null) patch.active = act;
          await updateService(ctx, actor, S('service'), patch);
          return 'Service updated.';
        }
        default:
          return 'Unknown command.';
      }
    });
  }

  /** Short-lived handoff from a slash command to its requirements modal. */
  const pending = (() => {
    const m = new Map<string, { value: any; expires: number }>();
    return {
      put(value: any) {
        const k = Math.random().toString(36).slice(2, 10);
        m.set(k, { value, expires: Date.now() + 15 * 60_000 });
        return k;
      },
      take(k: string) {
        const v = m.get(k);
        m.delete(k);
        return v && v.expires > Date.now() ? v.value : null;
      },
    };
  })();

  async function onImportModal(i: ModalSubmitInteraction, token: string): Promise<void> {
    const p = pending.take(token);
    if (!p) {
      await i.reply({ content: '⚠️ That form expired. Run the command again.', ...EPH });
      return;
    }
    return ephemeral(i, async () => {
      const actor = await actorFor(i.user);
      const configuration: Record<string, string> = {};
      for (const c of i.fields.fields.values()) if ('value' in c && c.customId.startsWith('r:') && c.value) configuration[c.customId.slice(2)] = String(c.value);
      const o = p.options;
      if (p.key === 'order classify') {
        const r = await classifyOrder(ctx, actor, p.orderId, { serviceId: p.serviceId, configuration, price: o.price ?? null });
        return `${r.internal_order_id} is now ${r.status.replace(/_/g, ' ').toLowerCase()}.`;
      }
      const hours = o.deadline_hours as number | undefined;
      const r = await importManualOrder(ctx, actor, {
        marketplaceOrderId: String(o.marketplace_order_id), serviceId: p.serviceId, versionId: (o.version as string) ?? null, price: String(o.price),
        commission: (o.commission as string) ?? null, deadlineAt: hours ? new Date(Date.now() + hours * 3_600_000) : null, customerReference: (o.customer as string) ?? null,
        configuration, paid: !!o.paid, quoteCode: (o.quote_code as string) ?? null,
      });
      if (!r.created) return `Already imported as ${r.order.internal_order_id} (${r.order.status}).`;
      if (!parseMoney(String(o.price))) return 'Imported, but the price is zero.';
      return `📥 Imported as **${r.order.internal_order_id}**: ${r.order.status.replace(/_/g, ' ').toLowerCase()}.`;
    });
  }

  // ================================================================ autocomplete

  async function onAutocomplete(i: AutocompleteInteraction): Promise<void> {
    const focused = i.options.getFocused(true);
    const term = `%${String(focused.value).trim()}%`;
    let choices: { name: string; value: string }[] = [];
    if (focused.name === 'service') {
      const rows = await many(db, `SELECT s.id, g.short_name, c.name AS cat, s.name FROM services s JOIN service_categories c ON c.id = s.category_id JOIN games g ON g.id = c.game_id
        WHERE s.active AND (s.name ILIKE $1 OR c.name ILIKE $1 OR g.name ILIKE $1 OR g.short_name ILIKE $1) ORDER BY g.name, c.sort, s.name LIMIT 25`, [term]);
      choices = rows.map((r) => ({ name: clip(`${r.short_name} · ${r.cat} · ${r.name}`, 100), value: r.id }));
    } else if (focused.name === 'game') {
      choices = (await listGames(db)).filter((g) => g.name.toLowerCase().includes(String(focused.value).toLowerCase())).map((g) => ({ name: g.name, value: g.id }));
    } else if (focused.name === 'version') {
      const rows = await many(db, `SELECT v.id, g.short_name, v.name FROM game_versions v JOIN games g ON g.id = v.game_id WHERE v.name ILIKE $1 OR g.short_name ILIKE $1 ORDER BY g.name, v.sort LIMIT 25`, [term]);
      choices = rows.map((r) => ({ name: `${r.short_name} · ${r.name}`, value: r.id }));
    } else if (focused.name === 'key') {
      choices = Object.keys(DEFAULT_SETTINGS).filter((k) => k.toLowerCase().includes(String(focused.value).toLowerCase())).slice(0, 25).map((k) => ({ name: k, value: k }));
    }
    await i.respond(choices.slice(0, 25)).catch(() => {});
  }

  // ================================================================ entry point

  return async function handle(i: Interaction): Promise<void> {
    if (i.guildId && i.guildId !== rt.guild.id) return;
    try {
      if (i.isAutocomplete()) return await onAutocomplete(i);
      if (i.isChatInputCommand()) return await onCommand(i);
      if (i.isModalSubmit()) {
        const p = parseCid(i.customId);
        if (p?.verb === 'order.import') return await onImportModal(i, p.args[0]!);
        return await onModal(i);
      }
      if (i.isButton() || i.isStringSelectMenu()) return await onComponent(i);
    } catch (err) {
      await fail(i, err);
    }
  };
}

function toInt(s: string): number {
  const n = Number(s.replace(/[^\d]/g, ''));
  if (!Number.isInteger(n) || s.trim() === '') throw new DomainError('INVALID', 'minutes must be a whole number');
  return n;
}
