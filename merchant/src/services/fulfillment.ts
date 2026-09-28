// Fulfillment through to money: order rooms, delivery, completion, earnings,
// failures, cancellations, refunds and disputes (§10, §18, §19, §22).
import * as L from '../core/ledger.js';
import { type Cents, fromDecimalString, parseMoney, toDecimalString } from '../core/money.js';
import { type Actor, actorId, DomainError, SYSTEM } from '../core/types.js';
import { one, type Q } from '../db/pool.js';
import { audit } from './audit.js';
import { getService } from './catalog.js';
import type { Ctx } from './context.js';
import { cancelJobs, enqueue } from './jobs.js';
import { postEntries } from './ledger.js';
import { authorizeOrder, lockOrder, orderMoney, type OrderRow, transition } from './orders.js';

export async function startWork(ctx: Ctx, actor: Actor, orderId: string): Promise<OrderRow> {
  return ctx.db.tx(async (q) => {
    const o = await lockOrder(q, orderId);
    await authorizeOrder(q, actor, 'order.work', o);
    return transition(q, o, 'IN_PROGRESS', actor, { source: ctx.source, preAuthorized: true });
  });
}

export async function markDelivered(ctx: Ctx, actor: Actor, orderId: string, note: string): Promise<OrderRow> {
  if (!note || note.trim().length < 3) throw new DomainError('REASON_REQUIRED', 'add a delivery note or proof');
  return ctx.db.tx(async (q) => {
    const o = await lockOrder(q, orderId);
    await authorizeOrder(q, actor, 'order.work', o);
    const updated = await transition(q, o, 'DELIVERED', actor, { source: ctx.source, preAuthorized: true, reason: note.slice(0, 1000), payload: { deliveryNote: note.slice(0, 1000) } });
    await enqueue(q, 'discord.alert', { channel: 'ops', gameId: o.game_id, text: `📦 ${o.internal_order_id} delivered. Confirm completion when the marketplace marks it complete.` });
    if (o.source === 'MARKETPLACE' && o.marketplace_order_id) {
      await enqueue(q, 'marketplace.markDelivered', { orderId: o.id, note: note.slice(0, 500) }, { dedupeKey: `mdeliv:${o.id}` });
    }
    return updated;
  });
}

/** Marketplace completion (event, or staff-recorded before API access). Writes the earning. */
export async function recordCompletion(ctx: Ctx, actor: Actor, orderId: string, opts: { rating?: number | null; externalRef?: string | null } = {}): Promise<OrderRow> {
  return ctx.db.tx(async (q) => completeLocked(q, ctx, await lockOrder(q, orderId), actor, opts));
}

export async function completeLocked(q: Q, ctx: Ctx, o: OrderRow, actor: Actor, opts: { rating?: number | null } = {}): Promise<OrderRow> {
  if (actor.kind === 'USER') await authorizeOrder(q, actor, 'order.recordCompletion', o);
  if (o.status === 'COMPLETED' || o.status === 'EARNING_RELEASED') return o; // idempotent
  let cur = o;
  if (cur.status === 'IN_PROGRESS') cur = await transition(q, cur, 'DELIVERED', actor, { source: ctx.source, preAuthorized: true, reason: 'completed on marketplace' });
  if (cur.status === 'DELIVERED') cur = await transition(q, cur, 'MARKETPLACE_COMPLETION', actor, { source: ctx.source, preAuthorized: true });
  if (!['MARKETPLACE_COMPLETION', 'PARTIAL_REFUND', 'DISPUTED'].includes(cur.status)) throw new DomainError('INVALID_STATE', `order is ${cur.status}; it can't be completed yet`);
  if (!cur.assigned_provider_id || cur.provider_cost == null) throw new DomainError('INVALID_STATE', 'order has no confirmed provider');
  const money = await orderMoney(q, cur);
  const snapshot = { ...money, at: ctx.now().toISOString(), commissionIsEstimate: cur.commission_is_estimate };
  cur = await transition(q, cur, 'COMPLETED', actor, { source: ctx.source, preAuthorized: true, set: { snapshot, provider_payment_status: 'PENDING', payment_status: cur.payment_status === 'PENDING' ? 'PAID' : cur.payment_status } });
  const earning = fromDecimalString(cur.provider_cost);
  const exists = await one(q, `SELECT 1 FROM provider_ledger_entries WHERE order_id = $1 AND entry_type = 'ORDER_EARNING'`, [cur.id]);
  if (!exists && earning > 0) await postEntries(q, cur.assigned_provider_id!, L.earningEntries(cur.id, earning, cur.internal_order_id), SYSTEM, cur.currency);
  await q.query(`UPDATE order_assignments SET status = 'COMPLETED' WHERE order_id = $1 AND status = 'CONFIRMED'`, [cur.id]);
  if (opts.rating) {
    await q.query(`INSERT INTO reviews (order_id, rating, source) VALUES ($1, $2, $3) ON CONFLICT (order_id) DO UPDATE SET rating = EXCLUDED.rating`, [cur.id, opts.rating, actor.kind === 'MARKETPLACE' ? 'MARKETPLACE' : 'STAFF']);
  }
  const service = await getService(q, cur.service_id!);
  const releaseAt = new Date(ctx.now().getTime() + (service?.hold_days ?? 3) * 86_400_000);
  await enqueue(q, 'ledger.release', { orderId: cur.id }, { runAt: releaseAt, dedupeKey: `release:${cur.id}` });
  await enqueue(q, 'reputation.provider', { providerId: cur.assigned_provider_id }, { dedupeKey: `rep:${cur.assigned_provider_id}`, runAt: new Date(ctx.now().getTime() + 10_000) });
  await enqueue(q, 'discord.archiveOrder', { orderId: cur.id });
  await enqueue(q, 'discord.providerNotice', { providerId: cur.assigned_provider_id, text: `✅ ${cur.internal_order_id} completed. ${toDecimalString(earning)} ${cur.currency} added to your pending balance (available after the ${service?.hold_days ?? 3}-day hold).` });
  return cur;
}

/** Hold period over: PENDING -> AVAILABLE, order -> EARNING_RELEASED. */
export async function releaseEarning(ctx: Ctx, orderId: string): Promise<string> {
  return ctx.db.tx(async (q) => {
    const o = await lockOrder(q, orderId);
    if (o.status === 'DISPUTED') {
      await enqueue(q, 'ledger.release', { orderId }, { runAt: new Date(ctx.now().getTime() + 86_400_000), dedupeKey: `release:${orderId}` });
      return 'disputed-retry';
    }
    if (o.status !== 'COMPLETED' && o.status !== 'PARTIAL_REFUND') return 'skip';
    if (o.provider_payment_status !== 'PENDING') return 'skip';
    const pending = await one(q, `SELECT coalesce(sum(amount), 0) AS amt FROM provider_ledger_entries WHERE order_id = $1 AND bucket = 'PENDING'`, [orderId]);
    const amount = fromDecimalString(pending!.amt);
    if (amount > 0) await postEntries(q, o.assigned_provider_id!, L.releaseEntries(orderId, amount, o.internal_order_id), SYSTEM, o.currency);
    await transition(q, o, 'EARNING_RELEASED', SYSTEM, { source: ctx.source, set: { provider_payment_status: 'RELEASED' } });
    return 'released';
  });
}

/** Staff: the provider failed. Leads to reassignment (§22.8). */
export async function markProviderFailed(ctx: Ctx, actor: Actor, orderId: string, reason: string): Promise<OrderRow> {
  return ctx.db.tx(async (q) => {
    const o = await lockOrder(q, orderId);
    await authorizeOrder(q, actor, 'order.markFailed', o);
    const failedProvider = o.assigned_provider_id;
    let cur = await transition(q, o, 'PROVIDER_FAILED', actor, { reason, source: ctx.source, preAuthorized: true });
    await q.query(`UPDATE order_assignments SET status = 'FAILED' WHERE order_id = $1 AND status IN ('CONFIRMED','PENDING_CONFIRM')`, [o.id]);
    if (failedProvider) {
      await q.query(`INSERT INTO provider_flags (provider_id, type, severity, note, created_by) VALUES ($1, 'ORDER_FAILED', 'WARNING', $2, $3)`, [failedProvider, `${o.internal_order_id}: ${reason}`, actorId(actor)]);
      await enqueue(q, 'reputation.provider', { providerId: failedProvider }, { dedupeKey: `rep:${failedProvider}` });
      await enqueue(q, 'discord.providerNotice', { providerId: failedProvider, text: `❌ ${o.internal_order_id} was marked as failed: ${reason}` });
    }
    cur = await transition(q, cur, 'REASSIGNMENT_REQUIRED', actor, { source: ctx.source, preAuthorized: true, set: { assigned_provider_id: null, provider_cost: null } });
    await enqueue(q, 'discord.archiveOrder', { orderId: o.id, keepPost: true });
    const remaining = await one(q, `SELECT count(*)::int AS n FROM provider_bids WHERE order_id = $1 AND status = 'ACTIVE'`, [o.id]);
    if (remaining!.n > 0) cur = await transition(q, cur, 'BID_REVIEW', SYSTEM, { source: ctx.source, reason: 'reassign to next bid' });
    await enqueue(q, 'discord.alert', { channel: 'ops', gameId: o.game_id, mentionManagers: true, text: `❌ ${o.internal_order_id}: provider failed (${reason}). ${remaining!.n ? 'Pick another bid on the order post.' : 'Reopen bidding from the order post.'}` });
    return cur;
  });
}

export async function cancelOrder(ctx: Ctx, actor: Actor, orderId: string, reason: string): Promise<OrderRow> {
  return ctx.db.tx(async (q) => cancelLocked(q, ctx, await lockOrder(q, orderId), actor, reason));
}

export async function cancelLocked(q: Q, ctx: Ctx, o: OrderRow, actor: Actor, reason: string): Promise<OrderRow> {
  if (actor.kind === 'USER') await authorizeOrder(q, actor, 'order.cancel', o);
  if (o.status === 'CANCELLED') return o;
  const updated = await transition(q, o, 'CANCELLED', actor, { reason, source: ctx.source, preAuthorized: true });
  await q.query(`UPDATE order_assignments SET status = 'CANCELLED' WHERE order_id = $1 AND status IN ('PENDING_CONFIRM','CONFIRMED')`, [o.id]);
  await q.query(`UPDATE provider_bids SET status = 'EXPIRED' WHERE order_id = $1 AND status = 'ACTIVE'`, [o.id]);
  await cancelJobs(q, 'bidding.tick', { orderId: o.id });
  await enqueue(q, 'discord.archiveOrder', { orderId: o.id });
  if (o.assigned_provider_id) await enqueue(q, 'discord.providerNotice', { providerId: o.assigned_provider_id, text: `🛑 ${o.internal_order_id} was cancelled. Please stop work on it.` });
  return updated;
}

export interface RefundInput {
  amount: string;
  liability: 'MERCHANT' | 'PROVIDER' | 'SPLIT';
  /** For SPLIT: the provider's share. For PROVIDER: defaults to the full provider cost (capped). */
  providerShare?: string | null;
  reason: string;
  externalRef?: string | null;
}

/** Records a refund (full or partial), updates status, and reverses provider earnings when liable. */
export async function recordRefund(ctx: Ctx, actor: Actor, orderId: string, input: RefundInput): Promise<OrderRow> {
  return ctx.db.tx(async (q) => refundLocked(q, ctx, await lockOrder(q, orderId), actor, input));
}

export async function refundLocked(q: Q, ctx: Ctx, o: OrderRow, actor: Actor, input: RefundInput): Promise<OrderRow> {
  if (actor.kind === 'USER') await authorizeOrder(q, actor, 'order.refund', o);
  if (input.externalRef) {
    const dup = await one(q, 'SELECT 1 FROM refunds WHERE order_id = $1 AND external_ref = $2', [o.id, input.externalRef]);
    if (dup) return o; // replayed marketplace event
  }
  const amount: Cents = parseMoney(input.amount);
  const price = fromDecimalString(o.customer_price);
  const already = fromDecimalString((await one(q, 'SELECT coalesce(sum(amount),0) AS s FROM refunds WHERE order_id = $1', [o.id]))!.s);
  if (amount <= 0 || already + amount > price) throw new DomainError('INVALID_AMOUNT', 'refund must be positive and not exceed what the customer paid');
  const full = already + amount === price;
  const cost = o.provider_cost == null ? 0 : fromDecimalString(o.provider_cost);
  let providerShare: Cents = 0;
  if (input.liability === 'PROVIDER') providerShare = Math.min(cost, input.providerShare ? parseMoney(input.providerShare) : full ? cost : Math.round((cost * amount) / price));
  if (input.liability === 'SPLIT') providerShare = Math.min(cost, parseMoney(input.providerShare ?? '0'));
  await q.query(
    'INSERT INTO refunds (order_id, amount, kind, liability, provider_share, external_ref, reason, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [o.id, toDecimalString(amount), full ? 'FULL' : 'PARTIAL', input.liability, toDecimalString(providerShare), input.externalRef ?? null, input.reason, actorId(actor)],
  );
  const earning = await one(q, `SELECT id FROM provider_ledger_entries WHERE order_id = $1 AND entry_type = 'ORDER_EARNING'`, [o.id]);
  if (providerShare > 0 && earning && o.assigned_provider_id) {
    const released = o.provider_payment_status === 'RELEASED';
    await postEntries(q, o.assigned_provider_id, L.refundReversalEntries(o.id, providerShare, released, o.internal_order_id, earning.id), actor, o.currency);
    await enqueue(q, 'discord.providerNotice', { providerId: o.assigned_provider_id, text: `↩️ Refund on ${o.internal_order_id}: ${toDecimalString(providerShare)} ${o.currency} was deducted from your ${released ? 'available' : 'pending'} balance. Reason: ${input.reason}` });
  }
  const to = full ? 'REFUNDED' : 'PARTIAL_REFUND';
  let updated = o;
  if (o.status !== to || !full) {
    const set: Record<string, unknown> = { payment_status: full ? 'REFUNDED' : 'PARTIALLY_REFUNDED' };
    if (providerShare > 0 && earning) set.provider_payment_status = 'REVERSED';
    if (o.status !== to) updated = await transition(q, o, to, actor, { reason: input.reason, source: ctx.source, preAuthorized: true, set, payload: { amount: toDecimalString(amount), liability: input.liability, providerShare: toDecimalString(providerShare) } });
  }
  if (full) {
    await q.query(`UPDATE order_assignments SET status = 'CANCELLED' WHERE order_id = $1 AND status IN ('PENDING_CONFIRM','CONFIRMED')`, [o.id]);
    await enqueue(q, 'discord.archiveOrder', { orderId: o.id });
  }
  await audit(q, { actor, action: 'REFUND_RECORDED', objectType: 'order', objectId: o.internal_order_id, newValue: { amount: toDecimalString(amount), liability: input.liability, providerShare: toDecimalString(providerShare), full }, reason: input.reason, source: ctx.source, important: true });
  return updated;
}

export async function openDispute(ctx: Ctx, actor: Actor, orderId: string, reason: string): Promise<OrderRow> {
  return ctx.db.tx(async (q) => {
    const o = await lockOrder(q, orderId);
    if (actor.kind === 'USER') await authorizeOrder(q, actor, 'order.cancel', o);
    if (o.status === 'DISPUTED') return o;
    await q.query(`INSERT INTO disputes (order_id, notes) VALUES ($1, $2)`, [o.id, reason]);
    const updated = await transition(q, o, 'DISPUTED', actor, { reason, source: ctx.source, preAuthorized: true, set: { dispute_status: 'OPEN', previous_status: o.status } });
    await enqueue(q, 'discord.alert', { channel: 'ops', gameId: o.game_id, mentionManagers: true, text: `⚖️ Dispute opened on ${o.internal_order_id}: ${reason}` });
    return updated;
  });
}

export async function resolveDispute(ctx: Ctx, actor: Actor, orderId: string, outcome: 'CONTINUE' | 'COMPLETE', notes: string): Promise<OrderRow> {
  return ctx.db.tx(async (q) => {
    const o = await lockOrder(q, orderId);
    if (actor.kind === 'USER') await authorizeOrder(q, actor, 'order.cancel', o);
    if (o.status !== 'DISPUTED') throw new DomainError('INVALID_STATE', 'order is not disputed');
    await q.query(`UPDATE disputes SET status = 'RESOLVED', resolved_at = now(), outcome = $2 WHERE order_id = $1 AND status = 'OPEN'`, [o.id, `${outcome}: ${notes}`]);
    const wasCompleted = o.previous_status === 'COMPLETED' || o.completed_at != null;
    if (outcome === 'COMPLETE') {
      if (wasCompleted) return transition(q, o, 'COMPLETED', actor, { reason: notes, source: ctx.source, preAuthorized: true, set: { dispute_status: 'RESOLVED' } });
      // Never completed before: DISPUTED -> COMPLETED with the full completion bookkeeping.
      await q.query(`UPDATE orders SET dispute_status = 'RESOLVED' WHERE id = $1`, [o.id]);
      return completeLocked(q, ctx, { ...o, dispute_status: 'RESOLVED' }, actor);
    }
    return transition(q, o, 'IN_PROGRESS', actor, { reason: notes, source: ctx.source, preAuthorized: true, set: { dispute_status: 'RESOLVED' } });
  });
}
