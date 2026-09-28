// Order intake: manual import (/order import), marketplace events (§7),
// validation/classification, and the move into procurement and bidding.
import { commissionFor, type FeeRule, pickFeeRule } from '../core/accounting.js';
import { authorize } from '../core/authz.js';
import { fromDecimalString, parseMoney, toDecimalString } from '../core/money.js';
import { type Actor, DomainError, SYSTEM } from '../core/types.js';
import { many, one, type Q } from '../db/pool.js';
import type { ExternalOrder, MarketplaceEvent } from '../marketplace/types.js';
import { audit } from './audit.js';
import { classifyListing, getService, validateConfiguration } from './catalog.js';
import type { Ctx } from './context.js';
import { enqueue } from './jobs.js';
import { openBidding } from './bidding.js';
import { cancelLocked, completeLocked, refundLocked } from './fulfillment.js';
import { insertOrder, lockOrder, type OrderRow, transition } from './orders.js';
import { getSettings } from './settings.js';

async function feeRules(q: Q, marketplace: string): Promise<FeeRule[]> {
  const rows = await many(q, 'SELECT * FROM marketplace_fee_rules WHERE marketplace = $1', [marketplace]);
  return rows.map((r) => ({ marketplace: r.marketplace, gameId: r.game_id, serviceId: r.service_id, rate: Number(r.rate), validFrom: r.valid_from, validTo: r.valid_to }));
}

/** RECEIVED -> VALIDATED (or MANUAL_REVIEW), then procurement + bidding if paid. Order must be locked. */
export async function advanceNewOrder(q: Q, ctx: Ctx, order: OrderRow, actor: Actor): Promise<OrderRow> {
  let o = order;
  const problems: string[] = [];
  const service = o.service_id ? await getService(q, o.service_id) : null;
  if (!service) problems.push('unknown listing: pick the service');
  if (fromDecimalString(o.customer_price) <= 0) problems.push('price is zero');
  if (service) {
    const missing = validateConfiguration(service, o.configuration ?? {});
    if (missing.length) problems.push(`missing: ${missing.join(', ')}`);
    if (!o.risk_tier) o = (await one<OrderRow>(q, 'UPDATE orders SET risk_tier = $2 WHERE id = $1 RETURNING *', [o.id, service.risk_tier]))!;
  }
  if (o.status === 'RECEIVED' && problems.length) {
    o = await transition(q, o, 'MANUAL_REVIEW', SYSTEM, { reason: problems.join('; '), source: ctx.source });
    await enqueue(q, 'discord.alert', { channel: o.game_id ? 'ops' : 'system-alerts', gameId: o.game_id, text: `🔎 ${o.internal_order_id} needs review: ${problems.join('; ')}` });
    return o;
  }
  if (problems.length) return o;
  if (o.status === 'RECEIVED' || o.status === 'MANUAL_REVIEW') o = await transition(q, o, 'VALIDATED', actor, { source: ctx.source, preAuthorized: true });
  return maybeProcure(q, ctx, o, actor);
}

/** VALIDATED + paid -> PROCUREMENT -> BIDDING. */
async function maybeProcure(q: Q, ctx: Ctx, o: OrderRow, actor: Actor): Promise<OrderRow> {
  if (o.status !== 'VALIDATED' || o.payment_status !== 'PAID') return o;
  const p = await transition(q, o, 'PROCUREMENT', actor, { source: ctx.source, preAuthorized: true });
  return (await openBidding(q, ctx, p, SYSTEM)).order;
}

// ------------------------------------------------------------------ manual import

export interface ManualImportInput {
  marketplaceOrderId: string;
  serviceId: string;
  versionId?: string | null;
  price: string;
  commission?: string | null;
  quantity?: number;
  deadlineAt?: Date | null;
  customerReference?: string | null;
  configuration: Record<string, string>;
  paid: boolean;
  quoteCode?: string | null;
}

export async function importManualOrder(ctx: Ctx, actor: Actor, input: ManualImportInput): Promise<{ order: OrderRow; created: boolean }> {
  return ctx.db.tx(async (q) => {
    const service = await getService(q, input.serviceId);
    if (!service) throw new DomainError('NOT_FOUND', 'unknown service');
    authorize(actor, 'order.import', { gameId: service.game_id });
    const s = await getSettings(q);
    const price = parseMoney(input.price);
    const rule = pickFeeRule(await feeRules(q, s.marketplace), s.marketplace, service.game_id, service.id, ctx.now());
    const commission = commissionFor(price, input.commission ? parseMoney(input.commission) : null, rule);
    const quote = input.quoteCode ? await one(q, 'SELECT * FROM quotes WHERE code = $1', [input.quoteCode.toUpperCase()]) : null;
    const { order, created } = await insertOrder(
      q,
      {
        source: 'MANUAL',
        marketplace: s.marketplace,
        marketplaceOrderId: input.marketplaceOrderId.trim(),
        customerReference: input.customerReference ?? null,
        gameId: service.game_id,
        gameVersionId: input.versionId ?? quote?.game_version_id ?? null,
        serviceId: service.id,
        configuration: { ...(quote?.spec ?? {}), ...input.configuration },
        quantity: input.quantity ?? 1,
        customerPrice: price,
        commission: commission.amount,
        commissionIsEstimate: commission.estimate,
        riskTier: service.risk_tier,
        deadlineAt: input.deadlineAt ?? null,
        paymentStatus: input.paid ? 'PAID' : 'PENDING',
        quoteId: quote?.id ?? null,
      },
      actor,
      ctx.source,
    );
    if (!created) return { order, created };
    if (quote) await q.query(`UPDATE quotes SET status = 'LINKED', order_id = $2 WHERE id = $1`, [quote.id, order.id]);
    const locked = await lockOrder(q, order.id);
    return { order: await advanceNewOrder(q, ctx, locked, actor), created };
  });
}

/** Staff fixes a MANUAL_REVIEW order: set service/fields/price, then it re-validates. */
export async function classifyOrder(ctx: Ctx, actor: Actor, orderId: string, input: { serviceId?: string; versionId?: string | null; configuration?: Record<string, string>; price?: string | null; paid?: boolean }): Promise<OrderRow> {
  return ctx.db.tx(async (q) => {
    const o = await lockOrder(q, orderId);
    const service = input.serviceId ? await getService(q, input.serviceId) : o.service_id ? await getService(q, o.service_id) : null;
    authorize(actor, 'order.classify', { gameId: service?.game_id ?? o.game_id });
    if (!['MANUAL_REVIEW', 'RECEIVED'].includes(o.status)) throw new DomainError('INVALID_STATE', `order is ${o.status}`);
    const set: Record<string, unknown> = {};
    if (service) Object.assign(set, { service_id: service.id, game_id: service.game_id, risk_tier: service.risk_tier });
    if (input.versionId !== undefined) set.game_version_id = input.versionId;
    if (input.configuration) set.configuration = JSON.stringify({ ...o.configuration, ...input.configuration });
    if (input.price) set.customer_price = toDecimalString(parseMoney(input.price));
    if (input.paid) set.payment_status = 'PAID';
    const cols = Object.keys(set);
    const updated = cols.length
      ? (await one<OrderRow>(q, `UPDATE orders SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')}, version = version + 1 WHERE id = $1 RETURNING *`, [o.id, ...cols.map((c) => set[c])]))!
      : o;
    await audit(q, { actor, action: 'ORDER_CLASSIFIED', objectType: 'order', objectId: o.internal_order_id, newValue: input, source: ctx.source });
    return advanceNewOrder(q, ctx, updated, actor);
  });
}

/** Staff records payment for a validated order (before the API exists). */
export async function confirmPayment(ctx: Ctx, actor: Actor, orderId: string): Promise<OrderRow> {
  return ctx.db.tx(async (q) => {
    const o = await lockOrder(q, orderId);
    authorize(actor, 'order.import', { gameId: o.game_id });
    const upd = (await one<OrderRow>(q, `UPDATE orders SET payment_status = 'PAID', version = version + 1 WHERE id = $1 RETURNING *`, [o.id]))!;
    await audit(q, { actor, action: 'PAYMENT_CONFIRMED', objectType: 'order', objectId: o.internal_order_id, source: ctx.source });
    return maybeProcure(q, ctx, upd, actor);
  });
}

// ------------------------------------------------------------------ marketplace events

/** Stores a webhook event once (idempotency layer 1) and queues processing. */
export async function receiveEvents(ctx: Ctx, source: string, events: MarketplaceEvent[], payload: unknown): Promise<{ stored: number; duplicates: number }> {
  let stored = 0;
  let duplicates = 0;
  for (const e of events) {
    const r = await ctx.db.query(
      `INSERT INTO integration_events (source, external_event_id, event_type, order_ref, payload) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (source, external_event_id) DO NOTHING RETURNING id`,
      [source, e.eventId, e.type, e.externalOrderId, JSON.stringify({ event: e, raw: payload })],
    );
    if (!r.rowCount) {
      duplicates++;
      continue;
    }
    stored++;
    await enqueue(ctx.db, 'integration.process', { eventId: String(r.rows[0].id) });
  }
  return { stored, duplicates };
}

function revive(e: any): MarketplaceEvent {
  const d = (v: any) => (v ? new Date(v) : null);
  return { ...e, occurredAt: new Date(e.occurredAt), order: e.order ? { ...e.order, deadlineAt: d(e.order.deadlineAt), updatedAt: new Date(e.order.updatedAt) } : undefined };
}

export async function processIntegrationEvent(ctx: Ctx, eventId: string): Promise<string> {
  const row = await one(ctx.db, 'SELECT * FROM integration_events WHERE id = $1', [eventId]);
  if (!row || row.status !== 'RECEIVED') return 'skip';
  const event = revive(row.payload.event);
  try {
    const result = await ctx.db.tx((q) => applyEvent(q, ctx, row.source, event));
    await ctx.db.query(`UPDATE integration_events SET status = $2, processed_at = now() WHERE id = $1`, [eventId, result === 'stale' ? 'STALE' : result === 'ignored' ? 'IGNORED' : 'PROCESSED']);
    await enqueue(ctx.db, 'discord.alert', { channel: 'integration-events', text: `\`${event.type}\` ${event.externalOrderId} → ${result}` });
    return result;
  } catch (err) {
    const msg = (err as Error).message;
    await ctx.db.query(`UPDATE integration_events SET status = 'FAILED', error = $2 WHERE id = $1`, [eventId, msg.slice(0, 1000)]);
    await enqueue(ctx.db, 'discord.alert', { channel: 'system-alerts', text: `❗ Marketplace event ${event.type} for ${event.externalOrderId} failed: ${msg}` });
    throw err;
  }
}

async function applyEvent(q: Q, ctx: Ctx, source: string, e: MarketplaceEvent): Promise<string> {
  const actor: Actor = { kind: 'MARKETPLACE', source };
  let order = await one<OrderRow>(q, 'SELECT * FROM orders WHERE marketplace = $1 AND marketplace_order_id = $2 FOR UPDATE', [source, e.externalOrderId]);

  // Out-of-order protection: a stale update is stored but not applied.
  if (order && e.order && order.external_updated_at && e.order.updatedAt < order.external_updated_at && e.type === 'ORDER_UPDATED') return 'stale';

  if (!order) {
    if (!e.order) return 'ignored'; // e.g. a message for an order we never saw; reconciliation will fetch it
    order = await createFromExternal(q, ctx, source, e.order, actor);
    if (e.type === 'ORDER_CREATED' || e.type === 'PAYMENT_CONFIRMED' || e.type === 'ORDER_UPDATED') return 'created';
  }

  switch (e.type) {
    case 'ORDER_CREATED':
      return 'duplicate-order';
    case 'PAYMENT_CONFIRMED': {
      if (order.payment_status === 'PAID') return 'noop';
      const upd = (await one<OrderRow>(q, `UPDATE orders SET payment_status = 'PAID', version = version + 1 WHERE id = $1 RETURNING *`, [order.id]))!;
      const after = upd.status === 'RECEIVED' || upd.status === 'MANUAL_REVIEW' ? await advanceNewOrder(q, ctx, upd, actor) : await maybeProcure(q, ctx, upd, actor);
      return `paid (${after.status})`;
    }
    case 'ORDER_UPDATED': {
      if (!e.order) return 'ignored';
      const set: Record<string, unknown> = { external_updated_at: e.order.updatedAt, configuration: JSON.stringify({ ...order.configuration, ...e.order.fields }) };
      if (e.order.deadlineAt) set.deadline_at = e.order.deadlineAt;
      const priceChanged = e.order.price !== fromDecimalString(order.customer_price);
      if (priceChanged) set.customer_price = toDecimalString(e.order.price);
      const cols = Object.keys(set);
      const upd = (await one<OrderRow>(q, `UPDATE orders SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')}, version = version + 1 WHERE id = $1 RETURNING *`, [order.id, ...cols.map((c) => set[c])]))!;
      await audit(q, { actor, action: priceChanged ? 'PRICE_CHANGED' : 'ORDER_UPDATED', objectType: 'order', objectId: order.internal_order_id, oldValue: { price: order.customer_price }, newValue: { price: upd.customer_price }, source: 'WEBHOOK', important: priceChanged });
      if (upd.status === 'MANUAL_REVIEW') await advanceNewOrder(q, ctx, upd, actor);
      await enqueue(q, 'discord.orderPost', { orderId: order.id }, { dedupeKey: `orderPost:${order.id}` });
      return priceChanged ? 'updated (price changed)' : 'updated';
    }
    case 'CUSTOMER_MESSAGE':
      await q.query(`INSERT INTO order_events (order_id, from_status, to_status, actor_kind, reason, payload) VALUES ($1,$2,$2,'MARKETPLACE',$3,$4)`, [order.id, order.status, (e.message ?? '').slice(0, 1000), JSON.stringify({ customerMessage: true })]);
      await enqueue(q, 'discord.customerMessage', { orderId: order.id, text: (e.message ?? '').slice(0, 1800) });
      return 'message';
    case 'ORDER_CANCELLED':
      if (['CANCELLED', 'REFUNDED'].includes(order.status)) return 'noop';
      await cancelLocked(q, ctx, order, actor, 'cancelled on marketplace');
      return 'cancelled';
    case 'REFUND':
      if (!e.refund) return 'ignored';
      await refundLocked(q, ctx, order, actor, { amount: toDecimalString(e.refund.amount), liability: 'MERCHANT', reason: e.refund.reason || 'marketplace refund', externalRef: e.refund.reference });
      await enqueue(q, 'discord.alert', { channel: 'ops', gameId: order.game_id, mentionManagers: true, text: `💶 Marketplace refund on ${order.internal_order_id} (${toDecimalString(e.refund.amount)}). Liability was recorded as MERCHANT; a manager can re-assign it to the provider with /order refund if they were at fault.` });
      return 'refund';
    case 'DISPUTE_OPENED':
      if (order.status === 'DISPUTED') return 'noop';
      await q.query(`INSERT INTO disputes (order_id, notes) VALUES ($1, $2)`, [order.id, e.dispute?.reason ?? null]);
      await transition(q, order, 'DISPUTED', actor, { reason: e.dispute?.reason ?? 'marketplace dispute', source: 'WEBHOOK', set: { dispute_status: 'OPEN', previous_status: order.status } });
      await enqueue(q, 'discord.alert', { channel: 'ops', gameId: order.game_id, mentionManagers: true, text: `⚖️ Marketplace dispute on ${order.internal_order_id}: ${e.dispute?.reason ?? ''}` });
      return 'disputed';
    case 'DISPUTE_RESOLVED':
      if (order.status !== 'DISPUTED') return 'noop';
      await q.query(`UPDATE disputes SET status = 'RESOLVED', resolved_at = now(), outcome = $2 WHERE order_id = $1 AND status = 'OPEN'`, [order.id, e.dispute?.outcome ?? null]);
      if (e.dispute?.outcome === 'SELLER') {
        await q.query(`UPDATE orders SET dispute_status = 'RESOLVED' WHERE id = $1`, [order.id]);
        const back = order.previous_status === 'COMPLETED' || order.completed_at ? 'COMPLETED' : 'IN_PROGRESS';
        if (back === 'COMPLETED' && !order.completed_at) await completeLocked(q, ctx, order, actor);
        else await transition(q, order, back, actor, { source: 'WEBHOOK', reason: 'dispute resolved for seller' });
      }
      return `dispute resolved (${e.dispute?.outcome ?? '?'})`;
    case 'ORDER_COMPLETED':
      if (['COMPLETED', 'EARNING_RELEASED'].includes(order.status)) return 'noop';
      if (!['IN_PROGRESS', 'DELIVERED', 'MARKETPLACE_COMPLETION'].includes(order.status)) {
        await enqueue(q, 'discord.alert', { channel: 'ops', gameId: order.game_id, mentionManagers: true, text: `⚠️ Marketplace marked ${order.internal_order_id} complete, but it is ${order.status} here. Please check.` });
        return 'mismatch';
      }
      await completeLocked(q, ctx, order, actor, { rating: e.rating ?? null });
      return 'completed';
  }
}

async function createFromExternal(q: Q, ctx: Ctx, source: string, x: ExternalOrder, actor: Actor): Promise<OrderRow> {
  const listing = await classifyListing(q, source, x.listingId);
  const service = listing ? await getService(q, listing.service_id) : null;
  const rule = service ? pickFeeRule(await feeRules(q, source), source, service.game_id, service.id, ctx.now()) : null;
  const commission = commissionFor(x.price, x.commission, rule);
  const quoteCode = x.note?.match(/TM-Q-\d{3,}/i)?.[0]?.toUpperCase();
  const quote = quoteCode ? await one(q, 'SELECT * FROM quotes WHERE code = $1', [quoteCode]) : null;
  const { order, created } = await insertOrder(
    q,
    {
      source: 'MARKETPLACE',
      marketplace: source,
      marketplaceOrderId: x.externalOrderId,
      customerReference: x.buyer,
      gameId: service?.game_id ?? null,
      gameVersionId: listing?.game_version_id ?? quote?.game_version_id ?? null,
      serviceId: service?.id ?? null,
      configuration: { ...(quote?.spec ?? {}), ...x.fields },
      quantity: x.quantity,
      currency: x.currency,
      customerPrice: x.price,
      commission: commission.amount,
      commissionIsEstimate: commission.estimate,
      riskTier: service?.risk_tier ?? null,
      deadlineAt: x.deadlineAt,
      paymentStatus: x.paid ? 'PAID' : 'PENDING',
      externalUpdatedAt: x.updatedAt,
      quoteId: quote?.id ?? null,
    },
    actor,
    'WEBHOOK',
  );
  if (quote && created) await q.query(`UPDATE quotes SET status = 'LINKED', order_id = $2 WHERE id = $1`, [quote.id, order.id]);
  if (!created) return lockOrder(q, order.id);
  return advanceNewOrder(q, ctx, await lockOrder(q, order.id), actor);
}

/** Reconciliation (§25): re-fetch open orders and replay anything we missed. */
export async function reconcileOpenOrders(ctx: Ctx, source: string, fetchOrder: (id: string) => Promise<ExternalOrder>): Promise<number> {
  const open = await many(ctx.db, `SELECT marketplace_order_id, status, payment_status FROM orders WHERE marketplace = $1 AND source = 'MARKETPLACE' AND status NOT IN ('COMPLETED','EARNING_RELEASED','CANCELLED','REFUNDED') LIMIT 500`, [source]);
  let fixed = 0;
  for (const o of open) {
    const x = await fetchOrder(o.marketplace_order_id);
    const events: MarketplaceEvent[] = [];
    const id = (t: string) => `reconcile:${t}:${x.externalOrderId}`;
    if (x.paid && o.payment_status !== 'PAID') events.push({ type: 'PAYMENT_CONFIRMED', eventId: id('paid'), occurredAt: x.updatedAt, externalOrderId: x.externalOrderId, order: x });
    if (x.status === 'CANCELLED') events.push({ type: 'ORDER_CANCELLED', eventId: id('cancel'), occurredAt: x.updatedAt, externalOrderId: x.externalOrderId, order: x });
    if (x.status === 'COMPLETED') events.push({ type: 'ORDER_COMPLETED', eventId: id('complete'), occurredAt: x.updatedAt, externalOrderId: x.externalOrderId, order: x });
    if (events.length) {
      fixed += (await receiveEvents(ctx, source, events, { reconciliation: true })).stored;
    }
  }
  return fixed;
}
