// Message payloads. Pure functions: data in, embeds/components out.
// Provider-facing views take ProviderOrderView, which has no price, margin,
// commission, customer identity or other bids (§6, Q3).
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder, type APIEmbedField,
  type MessageActionRowComponentBuilder,
} from 'discord.js';
import type { Balances } from '../core/ledger.js';
import type { OrderStatus } from '../core/order-state.js';
import type { Recommendation } from '../core/scoring.js';
import type { FinancialReport, GameDashboard, OperationalReport } from '../services/reports.js';
import { cid } from './ids.js';
import { clip, COLORS, mins, money, pct, STATUS_EMOJI, table, ts } from './format.js';

type Row = ActionRowBuilder<MessageActionRowComponentBuilder>;
const row = (...c: MessageActionRowComponentBuilder[]): Row => new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(...c);
const btn = (id: string, label: string, style: ButtonStyle = ButtonStyle.Secondary, emoji?: string) => {
  const b = new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
  if (emoji) b.setEmoji(emoji);
  return b;
};

export interface Payload {
  content?: string;
  embeds: EmbedBuilder[];
  components: Row[];
}

// ------------------------------------------------------------------ panels

export function welcomePanel(): Payload {
  return {
    embeds: [new EmbedBuilder().setColor(COLORS.info).setTitle('Welcome to TheMerchant').setDescription(
      'We sell game services and currency on our marketplace, and run fulfillment here with a vetted team of providers.\n\n' +
      '**Buying?** Press **I\'m a customer** to see ordering help and support.\n' +
      '**Want to work with us?** Press **Become a provider** to read the provider rules and apply.',
    )],
    components: [row(btn(cid('welcome.customer'), "I'm a customer", ButtonStyle.Primary, '🛒'), btn(cid('welcome.provider'), 'Become a provider', ButtonStyle.Secondary, '🤝'))],
  };
}

export function providerRulesPrompt(rulesVersion: string): Payload {
  return {
    embeds: [new EmbedBuilder().setColor(COLORS.info).setTitle('Provider rules').setDescription(
      [
        '• Bids are sealed: you only ever see your own bid, and customer prices are never shown.',
        '• Only accept work you can deliver by the deadline. Timeouts and failures lower your reputation.',
        '• Never ask for or share account credentials in Discord.',
        '• Customers belong to the marketplace. Contacting them off-platform ends the partnership.',
        '• Earnings are held for the service\'s hold period, then become available for payout.',
        `\nRules version ${rulesVersion}. Full text in #provider-rules.`,
      ].join('\n'),
    )],
    components: [row(btn(cid('rules.accept'), 'I accept the provider rules', ButtonStyle.Success, '✅'))],
  };
}

export function applyPanel(): Payload {
  return {
    embeds: [new EmbedBuilder().setColor(COLORS.info).setTitle('Apply to become a provider').setDescription('Press **Apply**, tell us about yourself, then pick the games and services you can deliver. Each game\'s manager reviews their part of your application.')],
    components: [row(btn(cid('apply.start'), 'Apply', ButtonStyle.Primary, '📝'))],
  };
}

export function providerPanel(): Payload {
  return {
    embeds: [new EmbedBuilder().setColor(COLORS.info).setTitle('Provider panel').setDescription('Everything here is private: replies are only visible to you. Opportunities arrive in your desk thread in #provider-desks.')],
    components: [
      row(new StringSelectMenuBuilder().setCustomId(cid('panel.availability')).setPlaceholder('Set availability').addOptions(
        { label: 'Available', value: 'AVAILABLE', emoji: '🟢', description: 'Receive new opportunities' },
        { label: 'Busy', value: 'BUSY', emoji: '🟡', description: 'Only if you have free capacity' },
        { label: 'Offline', value: 'OFFLINE', emoji: '⚫', description: 'No new opportunities' },
      )),
      row(btn(cid('panel.balance'), 'My balance', ButtonStyle.Primary, '💰'), btn(cid('panel.stats'), 'My stats', ButtonStyle.Secondary, '📈'), btn(cid('panel.caps'), 'My capabilities', ButtonStyle.Secondary, '🎮')),
      row(btn(cid('panel.payoutDetails'), 'Payout details', ButtonStyle.Secondary, '🏦'), btn(cid('panel.payout'), 'Request payout', ButtonStyle.Secondary, '💸'), btn(cid('panel.moreCaps'), 'Request more services', ButtonStyle.Secondary, '➕')),
    ],
  };
}

export function supportPanel(): Payload {
  return {
    embeds: [new EmbedBuilder().setColor(COLORS.info).setTitle('Support').setDescription('Press **Open ticket** for a private thread with our staff. For marketplace orders, include your marketplace order number.')],
    components: [row(btn(cid('ticket.open'), 'Open ticket', ButtonStyle.Primary, '🎫'))],
  };
}

export function directOrderPanel(): Payload {
  return {
    embeds: [new EmbedBuilder().setColor(COLORS.info).setTitle('Request a quote').setDescription('Need something that isn\'t listed? Request a quote. Staff reply in a private thread with a price and a link to the matching listing on our marketplace.')],
    components: [row(btn(cid('quote.open'), 'Request a quote', ButtonStyle.Primary, '💬'))],
  };
}

// ------------------------------------------------------------------ staff order post

export interface StaffOrderView {
  id: string;
  code: string;
  status: OrderStatus;
  source: string;
  marketplaceOrderId: string | null;
  customer: string | null;
  game: string;
  version: string | null;
  service: string;
  category: string;
  quantity: string;
  configuration: Record<string, string>;
  currency: string;
  price: number;
  commission: number;
  commissionIsEstimate: boolean;
  providerCost: number | null;
  refunds: number;
  otherCosts: number;
  profit: number;
  riskTier: string | null;
  deadlineAt: Date | null;
  windowEndsAt: Date | null;
  activeBidCount: number;
  invited: number;
  declined: number;
  assignedProviderCode: string | null;
  review: Recommendation | null;
  ev: number | null;
  events: { at: Date; text: string }[];
  customerMessages: number;
}

export function staffOrderPost(v: StaffOrderView): Payload {
  const cur = v.currency;
  const e = new EmbedBuilder()
    .setColor(['PROVIDER_FAILED', 'DISPUTED', 'CANCELLED', 'REFUNDED', 'MANUAL_REVIEW', 'REASSIGNMENT_REQUIRED'].includes(v.status) ? COLORS.bad : v.status === 'COMPLETED' || v.status === 'EARNING_RELEASED' ? COLORS.ok : COLORS.info)
    .setTitle(clip(`${STATUS_EMOJI[v.status]} ${v.code} · ${v.game}${v.version ? ` ${v.version}` : ''} · ${v.service}`, 256))
    .setDescription(
      [
        `**Status:** ${v.status.replace(/_/g, ' ')}${v.assignedProviderCode ? ` · provider **${v.assignedProviderCode}**` : ''}`,
        `**Source:** ${v.source}${v.marketplaceOrderId ? ` #${v.marketplaceOrderId}` : ''}${v.customer ? ` · customer ${v.customer}` : ''}`,
        `**Deadline:** ${ts(v.deadlineAt)}${v.deadlineAt ? ` (${ts(v.deadlineAt, 'R')})` : ''} · risk ${v.riskTier ?? '—'} · qty ${v.quantity}`,
        `Customer price ${money(v.price, cur)} · commission ${money(v.commission, cur)}${v.commissionIsEstimate ? ' (est.)' : ''} · net ${money(v.price - v.commission, cur)}`,
        v.providerCost != null ? `Provider cost ${money(v.providerCost, cur)} · refunds ${money(v.refunds, cur)} · other ${money(v.otherCosts, cur)} · **profit ${money(v.profit, cur)}**` : null,
      ].filter(Boolean).join('\n'),
    );
  const cfg = Object.entries(v.configuration).filter(([, x]) => x);
  if (cfg.length) e.addFields({ name: 'Requirements', value: clip(cfg.map(([k, x]) => `**${k}:** ${x}`).join('\n'), 1024) });

  if (v.status === 'BIDDING') {
    e.addFields({ name: 'Bidding', value: `${v.activeBidCount} bid(s) · ${v.invited} invited · ${v.declined} declined · closes ${ts(v.windowEndsAt, 'R')}` });
  }
  if (v.review && v.review.ranked.length && ['BID_REVIEW', 'REASSIGNMENT_REQUIRED', 'PROVIDER_SELECTED'].includes(v.status)) {
    const r = v.review;
    const rows = r.ranked.map((b, i) => [
      String(i + 1), b.providerCode, money(b.amount, cur), mins(b.etaMinutes), b.level, money(b.estProfit, cur),
      b.ineligible ? 'n/a' : b.score.toFixed(1), (r.recommended?.bidId === b.bidId ? '★' : '') + (b.flags.length ? '⚑' : '') + (b.ineligible ? '✗' : ''),
    ]);
    e.addFields({ name: `Bids · profile ${r.profile} · margin floor ${pct(r.params.minMargin, 0)} (max bid ${money(r.maxBidAtFloor, cur)})`, value: clip(table(['#', 'Prov', 'Bid', 'ETA', 'Level', 'Profit', 'Score', ''], rows), 1024) });
    const flagged = r.ranked.filter((b) => b.flags.length || b.ineligible).map((b) => `${b.providerCode}: ${b.ineligible ?? b.flags.join(', ').toLowerCase().replace(/_/g, ' ')}`);
    e.addFields({
      name: r.recommended ? `SYSTEM RECOMMENDATION: ${r.recommended.providerCode} at ${money(r.recommended.amount, cur)}` : 'No recommendation',
      value: clip([r.explanation, v.ev != null ? `Expected value ≈ ${money(Math.round(v.ev), cur)}` : null, flagged.length ? `⚑ Manager only / ✗ not pickable: ${flagged.join('; ')}` : null].filter(Boolean).join('\n'), 1024),
    });
  }
  if (v.events.length) e.addFields({ name: 'History', value: clip(v.events.map((x) => `${ts(x.at, 't')} ${x.text}`).join('\n'), 1024) });
  e.setFooter({ text: `Order ${v.id}` }).setTimestamp(new Date());

  const components: Row[] = [];
  const id = v.id;
  switch (v.status) {
    case 'MANUAL_REVIEW':
    case 'RECEIVED':
    case 'VALIDATED':
      components.push(row(btn(cid('order.paid', id), 'Mark paid', ButtonStyle.Primary, '💶'), btn(cid('order.cancel', id), 'Cancel order', ButtonStyle.Danger)));
      break;
    case 'BIDDING':
      components.push(row(btn(cid('order.close', id), 'Close bidding', ButtonStyle.Primary, '⏹️'), btn(cid('order.cancel', id), 'Cancel order', ButtonStyle.Danger)));
      break;
    case 'BID_REVIEW': {
      const r = v.review;
      const first: MessageActionRowComponentBuilder[] = [];
      if (r?.recommended) first.push(btn(cid('order.assignRec', id, r.recommended.bidId), `Assign recommended (${r.recommended.providerCode})`, ButtonStyle.Success, '✅'));
      first.push(btn(cid('order.reopen', id), 'Reopen bidding', ButtonStyle.Secondary, '🔁'), btn(cid('order.cancel', id), 'Cancel order', ButtonStyle.Danger));
      components.push(row(...first));
      const pickable = (r?.ranked ?? []).filter((b) => !b.ineligible).slice(0, 25);
      if (pickable.length) {
        components.push(row(new StringSelectMenuBuilder().setCustomId(cid('order.pick', id)).setPlaceholder('Select another provider (needs a reason)').addOptions(
          pickable.map((b) => ({ label: `${b.providerCode} · ${money(b.amount, cur)} · ${b.score.toFixed(1)}`, value: b.bidId, description: b.flags.length ? `Manager only: ${b.flags.join(', ')}` : `${b.level} · ETA ${mins(b.etaMinutes)}` })),
        )));
      }
      break;
    }
    case 'REASSIGNMENT_REQUIRED':
      components.push(row(btn(cid('order.reopen', id), 'Reopen bidding', ButtonStyle.Primary, '🔁'), btn(cid('order.escalate', id), 'Escalate', ButtonStyle.Secondary, '📣'), btn(cid('order.cancel', id), 'Cancel order', ButtonStyle.Danger)));
      break;
    case 'PROVIDER_CONFIRMED':
    case 'IN_PROGRESS':
      components.push(row(btn(cid('order.delivered', id), 'Mark delivered', ButtonStyle.Primary, '📦'), btn(cid('order.failed', id), 'Provider failed', ButtonStyle.Danger), btn(cid('order.escalate', id), 'Escalate', ButtonStyle.Secondary, '📣')));
      break;
    case 'DELIVERED':
    case 'MARKETPLACE_COMPLETION':
      components.push(row(btn(cid('order.complete', id), 'Record completion', ButtonStyle.Success, '🏁'), btn(cid('order.failed', id), 'Provider failed', ButtonStyle.Danger), btn(cid('order.escalate', id), 'Escalate', ButtonStyle.Secondary, '📣')));
      break;
    case 'DISPUTED':
    case 'PROVIDER_SELECTED':
      components.push(row(btn(cid('order.escalate', id), 'Escalate', ButtonStyle.Secondary, '📣')));
      break;
    default:
      break;
  }
  components.push(row(btn(cid('order.refresh', id), 'Refresh', ButtonStyle.Secondary, '🔄')));
  return { embeds: [e], components: components.slice(0, 5) };
}

// ------------------------------------------------------------------ provider views

/** Deliberately has no price, commission, margin, customer or bid information. */
export interface ProviderOrderView {
  id: string;
  code: string;
  game: string;
  version: string | null;
  service: string;
  quantity: string;
  deadlineAt: Date | null;
  requirements: string[];
  windowEndsAt: Date | null;
  currency: string;
}

export function bidInvite(v: ProviderOrderView): Payload {
  return {
    content: `🪙 New opportunity: **${v.code}**`,
    embeds: [new EmbedBuilder().setColor(COLORS.money).setTitle(`${v.code} · ${v.game}${v.version ? ` ${v.version}` : ''}`).setDescription(
      [
        `**Service:** ${v.service} × ${v.quantity}`,
        `**Deadline:** ${ts(v.deadlineAt)}`,
        `**Bidding closes:** ${ts(v.windowEndsAt, 'R')}`,
        v.requirements.length ? `**You will need:** ${v.requirements.join(', ')}` : null,
        '',
        `Bids are sealed. Enter your price in ${v.currency} and your ETA. You can replace or withdraw your bid until bidding closes.`,
      ].filter((x) => x !== null).join('\n'),
    )],
    components: [row(btn(cid('bid.open', v.id), 'Submit bid', ButtonStyle.Primary, '🪙'), btn(cid('bid.decline', v.id), 'Decline', ButtonStyle.Secondary))],
  };
}

export function bidReceipt(code: string, amount: number, currency: string, replaced: boolean, closes: Date, orderId: string): Payload {
  return {
    embeds: [new EmbedBuilder().setColor(COLORS.ok).setTitle(replaced ? 'Bid replaced' : 'Bid received').setDescription(`${code}: your bid of **${money(amount, currency)}** is in. Bidding closes ${ts(closes, 'R')}. You'll hear back in your desk thread.`)],
    components: [row(btn(cid('bid.withdraw', orderId), 'Withdraw bid', ButtonStyle.Danger))],
  };
}

export function selectionNotice(v: ProviderOrderView & { assignmentId: string; bid: number; confirmBy: Date }): Payload {
  return {
    content: `🎯 You've been selected for **${v.code}**`,
    embeds: [new EmbedBuilder().setColor(COLORS.ok).setTitle(`${v.code} · ${v.service}`).setDescription(`Your bid: **${money(v.bid, v.currency)}**\nDeadline: ${ts(v.deadlineAt)}\n\nConfirm ${ts(v.confirmBy, 'R')} or it goes to the next provider. After you confirm, a private order room opens with the details.`)],
    components: [row(btn(cid('assign.confirm', v.assignmentId), 'Confirm', ButtonStyle.Success, '✅'), btn(cid('assign.decline', v.assignmentId), 'Decline', ButtonStyle.Danger))],
  };
}

export function orderRoomBrief(v: ProviderOrderView & { configuration: Record<string, string>; providerCode: string; staffMention: string | null }): Payload {
  const cfg = Object.entries(v.configuration).filter(([, x]) => x).map(([k, x]) => `**${k}:** ${x}`);
  return {
    content: `Order room for **${v.code}**. Provider ${v.providerCode}${v.staffMention ? `, staff ${v.staffMention}` : ''}.`,
    embeds: [new EmbedBuilder().setColor(COLORS.info).setTitle(`Fulfillment brief · ${v.code}`).setDescription(
      [`**${v.game}${v.version ? ` ${v.version}` : ''} · ${v.service}** × ${v.quantity}`, `**Deadline:** ${ts(v.deadlineAt)} (${ts(v.deadlineAt, 'R')})`, '', ...cfg, '', '🔒 Never post or ask for account passwords here.'].join('\n'),
    )],
    components: [row(btn(cid('room.start', v.id), 'Start work', ButtonStyle.Primary, '▶️'), btn(cid('room.deliver', v.id), 'Mark delivered', ButtonStyle.Success, '📦'), btn(cid('room.issue', v.id), 'Report issue', ButtonStyle.Danger, '⚠️'))],
  };
}

export function balanceReply(b: Balances, currency: string, history: { created_at: Date; entry_type: string; bucket: string; amount: number; internal_order_id: string | null }[]): Payload {
  const e = new EmbedBuilder().setColor(COLORS.money).setTitle('Your balance').addFields(
    { name: 'Available', value: money(b.available, currency), inline: true },
    { name: 'Pending (on hold)', value: money(b.pending, currency), inline: true },
    { name: 'Reserved (payout)', value: money(b.reserved, currency), inline: true },
    { name: 'Paid out', value: money(b.paid, currency), inline: true },
    { name: 'Lifetime earnings', value: money(b.lifetime, currency), inline: true },
  );
  if (history.length) e.addFields({ name: 'Recent', value: clip(history.map((h) => `${ts(h.created_at, 'd')} ${h.entry_type.toLowerCase()} ${h.bucket.toLowerCase()} ${money(h.amount, currency)}${h.internal_order_id ? ` · ${h.internal_order_id}` : ''}`).join('\n'), 1024) });
  return { embeds: [e], components: [] };
}

export function statsReply(s: { code: string | null; level: string; reputation: number | null; completed: number; active: number; invites30: number; bids30: number; availability: string; components: Record<string, number> | null }): Payload {
  const c = s.components;
  const fields: APIEmbedField[] = [
    { name: 'Level', value: s.level, inline: true },
    { name: 'Reputation', value: s.reputation == null ? '—' : s.reputation.toFixed(1), inline: true },
    { name: 'Availability', value: s.availability, inline: true },
    { name: 'Completed', value: String(s.completed), inline: true },
    { name: 'Active', value: String(s.active), inline: true },
    { name: 'Bid rate (30d)', value: s.invites30 ? pct(s.bids30 / s.invites30, 0) : '—', inline: true },
  ];
  if (c) fields.push({ name: 'Quality', value: `completion ${pct(c.completionRate)} · on time ${pct(c.onTimeRate)} · disputes ${pct(c.disputeRate)} · rating ${pct(c.ratingNorm, 0)}` });
  return { embeds: [new EmbedBuilder().setColor(COLORS.info).setTitle(`Your stats${s.code ? ` · ${s.code}` : ''}`).addFields(fields)], components: [] };
}

export function capabilitiesReply(caps: { status: string; game: string; what: string; version: string | null }[]): Payload {
  const lines = caps.map((c) => `${c.status === 'APPROVED' ? '✅' : '⏳'} ${c.game} · ${c.what}${c.version ? ` (${c.version})` : ''}`);
  return { embeds: [new EmbedBuilder().setColor(COLORS.info).setTitle('Your capabilities').setDescription(lines.join('\n') || 'None yet.')], components: [] };
}

// ------------------------------------------------------------------ applications, payouts

export function applicationPost(v: { id: string; code: string | null; applicant: string; accountAge: string; answers: any; status: string; caps: { game_id: string; game: string; status: string; what: string; version: string | null }[] }): Payload {
  const byGame = new Map<string, typeof v.caps>();
  for (const c of v.caps) byGame.set(c.game_id, [...(byGame.get(c.game_id) ?? []), c]);
  const e = new EmbedBuilder().setColor(v.status === 'APPROVED' ? COLORS.ok : v.status === 'REJECTED' ? COLORS.bad : COLORS.warn)
    .setTitle(clip(`${v.answers.kind === 'CAPABILITY_REQUEST' ? 'Capability request' : 'Provider application'} · ${v.answers.displayName ?? v.applicant}${v.code ? ` (${v.code})` : ''}`, 256))
    .setDescription(clip([`**Discord:** ${v.applicant} · account ${v.accountAge}`, `**Timezone:** ${v.answers.timezone}`, `**Experience:** ${v.answers.experience}`, v.answers.proofLink ? `**Proof:** ${v.answers.proofLink}` : null, `**Status:** ${v.status}`].filter(Boolean).join('\n'), 4000));
  for (const [, caps] of byGame) e.addFields({ name: caps[0]!.game, value: clip(caps.map((c) => `${c.status === 'APPROVED' ? '✅' : c.status === 'REJECTED' ? '❌' : '⏳'} ${c.what}${c.version ? ` (${c.version})` : ''}`).join('\n'), 1024) });
  const pendingGames = [...byGame.entries()].filter(([, caps]) => caps.some((c) => c.status === 'PENDING'));
  const components = pendingGames.slice(0, 5).map(([gameId, caps]) => row(btn(cid('app.approve', v.id, gameId), `Approve ${caps[0]!.game}`, ButtonStyle.Success), btn(cid('app.reject', v.id, gameId), `Reject ${caps[0]!.game}`, ButtonStyle.Danger)));
  return { embeds: [e], components };
}

export function payoutPost(p: { id: string; code: string; amount: number; currency: string; status: string; method: string | null; externalRef: string | null; requestedAt: Date; balances: Balances }): Payload {
  const e = new EmbedBuilder().setColor(p.status === 'PAID' ? COLORS.ok : p.status === 'REJECTED' ? COLORS.bad : COLORS.money).setTitle(`Payout · ${p.code} · ${money(p.amount, p.currency)}`)
    .setDescription(`Status **${p.status}** · method ${p.method ?? '—'}${p.externalRef ? ` · ref ${p.externalRef}` : ''}\nRequested ${ts(p.requestedAt)}\nBalance after: available ${money(p.balances.available, p.currency)} · reserved ${money(p.balances.reserved, p.currency)}`);
  const components: Row[] = [];
  if (p.status === 'REQUESTED') components.push(row(btn(cid('payout.approve', p.id), 'Approve', ButtonStyle.Success), btn(cid('payout.reject', p.id), 'Reject', ButtonStyle.Danger)));
  if (p.status === 'APPROVED') components.push(row(btn(cid('payout.paid', p.id), 'Mark paid', ButtonStyle.Success, '💸'), btn(cid('payout.reject', p.id), 'Reject', ButtonStyle.Danger)));
  return { embeds: [e], components };
}

// ------------------------------------------------------------------ dashboards & reports

export function dashboardView(game: string, d: GameDashboard, now: Date): Payload {
  const c = (k: string) => d.counts[k] ?? 0;
  const review = c('MANUAL_REVIEW') + c('RECEIVED') + c('BID_REVIEW') + c('REASSIGNMENT_REQUIRED');
  const lines = [
    `**Active ${d.active}** · Needs review ${review} · Bidding ${c('BIDDING')} · Awaiting provider confirm ${c('PROVIDER_SELECTED')} · In progress ${c('PROVIDER_CONFIRMED') + c('IN_PROGRESS')} · Delivered ${c('DELIVERED') + c('MARKETPLACE_COMPLETION')}`,
    `**At risk** (deadline < 2h, no bids, or needs reassignment) ${d.atRisk.length}${d.atRisk.length ? ` → ${d.atRisk.join(', ')}` : ''}`,
    `Disputes open ${d.disputesOpen} · Providers available ${d.providersAvailable}/${d.providersTotal} · Capacity free ${d.capacityFree}`,
    `Today: completed ${d.today.completed} · avg procurement ${d.today.avgProcurementMin == null ? '—' : mins(Math.round(d.today.avgProcurementMin))} · acceptance ${pct(d.today.acceptance, 0)} · staff actions ${d.today.staffActions}`,
  ];
  return { embeds: [new EmbedBuilder().setColor(d.atRisk.length ? COLORS.warn : COLORS.info).setTitle(`${game.toUpperCase()} OPERATIONS`).setDescription(lines.join('\n')).setFooter({ text: 'Updated' }).setTimestamp(now)], components: [] };
}

export function reportEmbeds(label: string, f: FinancialReport, o: OperationalReport, currency = 'EUR'): EmbedBuilder[] {
  const m = (x: number) => money(x, currency);
  const fin = new EmbedBuilder().setColor(COLORS.money).setTitle(label).addFields(
    { name: 'Orders', value: String(f.orders), inline: true },
    { name: 'Gross sales', value: m(f.gross), inline: true },
    { name: 'Commission', value: m(f.commission), inline: true },
    { name: 'Net revenue', value: m(f.net), inline: true },
    { name: 'Provider costs', value: m(f.providerCost), inline: true },
    { name: 'Refunds', value: m(f.refunds), inline: true },
    { name: 'Other costs', value: m(f.otherCosts), inline: true },
    { name: '**Profit**', value: `**${m(f.profit)}**`, inline: true },
    { name: 'Margin', value: pct(f.marginPct), inline: true },
    { name: 'Avg order / provider cost', value: `${money(f.avgOrderValue, currency)} / ${money(f.avgProviderCost, currency)}`, inline: true },
    { name: 'Provider balances', value: `pending ${m(f.balances.pending)} · available ${m(f.balances.available)} · reserved ${m(f.balances.reserved)}`, inline: false },
    { name: 'Payouts', value: m(f.payouts), inline: true },
    { name: 'In flight', value: `${f.inFlight.orders} orders · ${m(f.inFlight.gross)}`, inline: true },
  );
  if (f.byGame.length) fin.addFields({ name: 'By game', value: clip(table(['Game', 'Orders', 'Gross', 'Profit'], f.byGame.map((g) => [g.game, String(g.orders), m(g.gross), m(g.profit)])), 1024) });
  const ops = new EmbedBuilder().setColor(COLORS.info).setTitle('Operations').setDescription(
    [
      `Active providers ${o.activeProviders} · orders awaiting a provider ${o.awaitingProvider}`,
      `Avg bids/order ${o.avgBidsPerOrder?.toFixed(1) ?? '—'} · avg procurement ${o.avgProcurementMinutes == null ? '—' : mins(Math.round(o.avgProcurementMinutes))} · acceptance ${pct(o.acceptanceRate, 0)}`,
      `Disputes ${o.disputes} · cancellations ${o.cancellations} · provider failures ${o.providerFailures} · recommendation overrides ${pct(o.overrideRate, 0)}`,
    ].join('\n'),
  );
  return [fin, ops];
}
