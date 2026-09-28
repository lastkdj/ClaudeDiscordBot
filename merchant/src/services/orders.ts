// Orders: creation, the single transition() path (§10), money edits, costs,
// refunds and notes. transition() is the only code that writes orders.status.
import { profit } from '../core/accounting.js';
import { type Action, authorize } from '../core/authz.js';
import { type Cents, fromDecimalString, parseMoney, toDecimalString } from '../core/money.js';
import { assertTransition, type OrderStatus, statusTag } from '../core/order-state.js';
import { type Actor, actorId, actorKind, DomainError, type RiskTier } from '../core/types.js';
import { many, one, type Q } from '../db/pool.js';
import { audit } from './audit.js';
import type { Ctx } from './context.js';
import { enqueue } from './jobs.js';
import { getSettings } from './settings.js';

export interface OrderRow {
  id: string;
  internal_order_id: string;
  source: 'MARKETPLACE' | 'MANUAL' | 'DISCORD';
  marketplace: string | null;
  marketplace_order_id: string | null;
  customer_reference: string | null;
  game_id: string | null;
  game_version_id: string | null;
  service_id: string | null;
  configuration: Record<string, string>;
  quantity: string;
  currency: string;
  customer_price: string;
  marketplace_commission: string;
  commission_is_estimate: boolean;
  provider_cost: string | null;
  risk_tier: RiskTier | null;
  deadline_at: Date | null;
  status: OrderStatus;
  previous_status: OrderStatus | null;
  payment_status: 'PENDING' | 'PAID' | 'REFUNDED' | 'PARTIALLY_REFUNDED';
  provider_payment_status: string;
  dispute_status: string | null;
  assigned_provider_id: string | null;
  assigned_staff_id: string | null;
  quote_id: string | null;
  forum_post_id: string | null;
  order_room_thread_id: string | null;
  external_updated_at: Date | null;
  bid_round: number;
  bid_window_opened_at: Date | null;
  bid_window_seconds: number | null;
  bid_window_extended: boolean;
  snapshot: any;
  completed_at: Date | null;
  earning_released_at: Date | null;
  version: number;
  created_at: Date;
}

export async function getOrder(q: Q, id: string): Promise<OrderRow | null> {
  return one<OrderRow>(q, 'SELECT * FROM orders WHERE id = $1', [id]);
}

export async function lockOrder(q: Q, id: string): Promise<OrderRow> {
  const o = await one<OrderRow>(q, 'SELECT * FROM orders WHERE id = $1 FOR UPDATE', [id]);
  if (!o) throw new DomainError('NOT_FOUND', 'order not found');
  return o;
}

export async function findOrder(q: Q, ref: string): Promise<OrderRow | null> {
  const r = ref.trim().toUpperCase();
  if (/^TM-\d+$/.test(r)) return one<OrderRow>(q, 'SELECT * FROM orders WHERE internal_order_id = $1', [`TM-${r.slice(3).padStart(8, '0')}`]);
  if (/^[0-9a-f-]{36}$/i.test(ref)) return getOrder(q, ref);
  return one<OrderRow>(q, 'SELECT * FROM orders WHERE marketplace_order_id = $1 ORDER BY created_at DESC LIMIT 1', [ref.trim()]);
}

export const orderValue = (o: Pick<OrderRow, 'customer_price'>): Cents => fromDecimalString(o.customer_price);

export function orderResource(o: Pick<OrderRow, 'game_id' | 'assigned_provider_id' | 'customer_price' | 'risk_tier'>) {
  return { gameId: o.game_id, providerId: o.assigned_provider_id, valueCents: orderValue(o), riskTier: o.risk_tier };
}

/** authorize() with the order as the resource and the configured thresholds. */
export async function authorizeOrder(q: Q, actor: Actor, action: Action, o: OrderRow): Promise<void> {
  const s = await getSettings(q);
  authorize(actor, action, orderResource(o), { highValueCents: s.highValueCents });
}

export interface TransitionOptions {
  reason?: string | null;
  payload?: Record<string, unknown>;
  /** Extra columns to set in the same UPDATE (already validated by the caller). */
  set?: Record<string, unknown>;
  source: Ctx['source'];
  /** Skip game-scope authorization (caller already authorized a more specific action). */
  preAuthorized?: boolean;
}

const TIMESTAMP_FOR: Partial<Record<OrderStatus, string>> = {
  VALIDATED: 'validated_at',
  PROVIDER_CONFIRMED: 'accepted_at',
  IN_PROGRESS: 'started_at',
  DELIVERED: 'delivered_at',
  COMPLETED: 'completed_at',
  EARNING_RELEASED: 'earning_released_at',
  CANCELLED: 'closed_at',
  REFUNDED: 'closed_at',
};

/** Moves an order to `to`. The order must be locked by the caller (lockOrder). */
export async function transition(q: Q, order: OrderRow, to: OrderStatus, actor: Actor, opts: TransitionOptions): Promise<OrderRow> {
  assertTransition({ from: order.status, to, actor, reason: opts.reason, previousStatus: order.previous_status });
  if (!opts.preAuthorized && actor.kind === 'USER') {
    const action: Action = actor.orgRole === 'PROVIDER' ? 'order.work' : 'order.view';
    await authorizeOrder(q, actor, action, order);
  }
  const set: Record<string, unknown> = { ...opts.set, status: to };
  if (to === 'MANUAL_REVIEW') set.previous_status = order.status;
  else if (order.status === 'MANUAL_REVIEW') set.previous_status = null;
  const ts = TIMESTAMP_FOR[to];
  if (ts && !(ts in set)) set[ts] = new Date();
  const cols = Object.keys(set);
  const updated = await one<OrderRow>(
    q,
    `UPDATE orders SET ${cols.map((c, i) => `${c} = $${i + 3}`).join(', ')}, version = version + 1
     WHERE id = $1 AND version = $2 RETURNING *`,
    [order.id, order.version, ...cols.map((c) => normalize(set[c]))],
  );
  if (!updated) throw new DomainError('CONCURRENT_UPDATE', 'the order changed while you were working on it; try again');
  await q.query(
    `INSERT INTO order_events (order_id, from_status, to_status, actor_user_id, actor_kind, reason, payload) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [order.id, order.status, to, actorId(actor), actorKind(actor), opts.reason ?? null, opts.payload ? JSON.stringify(opts.payload) : null],
  );
  await audit(q, {
    actor,
    action: 'ORDER_STATUS_CHANGED',
    objectType: 'order',
    objectId: order.internal_order_id,
    oldValue: { status: order.status },
    newValue: { status: to, ...(opts.payload ?? {}) },
    reason: opts.reason,
    source: opts.source,
    important: ['CANCELLED', 'REFUNDED', 'PARTIAL_REFUND', 'DISPUTED', 'PROVIDER_FAILED'].includes(to),
  });
  await refreshOrderViews(q, updated, statusTag(order.status) !== statusTag(to));
  return updated;
}

const normalize = (v: unknown) => (v !== null && typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v);

/** Queue the forum post edit and a (debounced) dashboard refresh. */
export async function refreshOrderViews(q: Q, o: Pick<OrderRow, 'id' | 'game_id'>, _tagChanged = true): Promise<void> {
  await enqueue(q, 'discord.orderPost', { orderId: o.id }, { dedupeKey: `orderPost:${o.id}` });
  if (o.game_id) await enqueue(q, 'discord.dashboard', { gameId: o.game_id }, { dedupeKey: `dashboard:${o.game_id}`, runAt: new Date(Date.now() + 5000) });
}

// ------------------------------------------------------------------ creation

export interface NewOrderInput {
  source: 'MARKETPLACE' | 'MANUAL' | 'DISCORD';
  marketplace?: string | null;
  marketplaceOrderId?: string | null;
  customerReference?: string | null;
  gameId?: string | null;
  gameVersionId?: string | null;
  serviceId?: string | null;
  configuration?: Record<string, string>;
  quantity?: number;
  currency?: string;
  customerPrice: Cents;
  commission: Cents;
  commissionIsEstimate: boolean;
  riskTier?: RiskTier | null;
  deadlineAt?: Date | null;
  paymentStatus?: 'PENDING' | 'PAID';
  externalUpdatedAt?: Date | null;
  quoteId?: string | null;
}

/** Inserts an order in RECEIVED, or returns the existing one for the same marketplace order (idempotent). */
export async function insertOrder(q: Q, input: NewOrderInput, actor: Actor, source: Ctx['source']): Promise<{ order: OrderRow; created: boolean }> {
  if (input.customerPrice < 0 || input.commission < 0) throw new DomainError('INVALID_AMOUNT', 'amounts cannot be negative');
  if (input.commission > input.customerPrice) throw new DomainError('INVALID_AMOUNT', 'commission cannot exceed the price');
  const r = await one<OrderRow>(
    q,
    `INSERT INTO orders (source, marketplace, marketplace_order_id, customer_reference, game_id, game_version_id, service_id,
       configuration, quantity, currency, customer_price, marketplace_commission, commission_is_estimate, risk_tier,
       deadline_at, status, payment_status, external_updated_at, quote_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'RECEIVED',$16,$17,$18,$19)
     ON CONFLICT (marketplace, marketplace_order_id) DO NOTHING RETURNING *`,
    [
      input.source, input.marketplace ?? null, input.marketplaceOrderId ?? null, input.customerReference ?? null,
      input.gameId ?? null, input.gameVersionId ?? null, input.serviceId ?? null, JSON.stringify(input.configuration ?? {}),
      input.quantity ?? 1, input.currency ?? 'EUR', toDecimalString(input.customerPrice), toDecimalString(input.commission),
      input.commissionIsEstimate, input.riskTier ?? null, input.deadlineAt ?? null, input.paymentStatus ?? 'PENDING',
      input.externalUpdatedAt ?? null, input.quoteId ?? null, actorId(actor),
    ],
  );
  if (!r) {
    const existing = await one<OrderRow>(q, 'SELECT * FROM orders WHERE marketplace = $1 AND marketplace_order_id = $2', [input.marketplace, input.marketplaceOrderId]);
    return { order: existing!, created: false };
  }
  await q.query(`INSERT INTO order_events (order_id, from_status, to_status, actor_user_id, actor_kind, payload) VALUES ($1, NULL, 'RECEIVED', $2, $3, $4)`, [
    r.id, actorId(actor), actorKind(actor), JSON.stringify({ source: input.source }),
  ]);
  await audit(q, { actor, action: 'ORDER_CREATED', objectType: 'order', objectId: r.internal_order_id, newValue: { source: input.source, marketplaceOrderId: input.marketplaceOrderId, price: toDecimalString(input.customerPrice) }, source });
  return { order: r, created: true };
}

// ------------------------------------------------------------------ edits

export async function editMoney(
  ctx: Ctx,
  actor: Actor,
  orderId: string,
  field: 'customer_price' | 'marketplace_commission' | 'provider_cost',
  amount: string,
  reason: string,
): Promise<OrderRow> {
  if (!reason || reason.trim().length < 3) throw new DomainError('REASON_REQUIRED', 'price and cost changes need a reason');
  const cents = parseMoney(amount);
  if (cents < 0) throw new DomainError('INVALID_AMOUNT', 'amount cannot be negative');
  return ctx.db.tx(async (q) => {
    const o = await lockOrder(q, orderId);
    await authorizeOrder(q, actor, 'order.editPrice', o);
    const set: Record<string, unknown> = { [field]: toDecimalString(cents) };
    if (field === 'marketplace_commission') set.commission_is_estimate = false;
    const upd = await one<OrderRow>(
      q,
      `UPDATE orders SET ${Object.keys(set).map((c, i) => `${c} = $${i + 2}`).join(', ')}, version = version + 1 WHERE id = $1 RETURNING *`,
      [orderId, ...Object.values(set)],
    );
    await audit(q, { actor, action: field === 'provider_cost' ? 'PROVIDER_COST_CHANGED' : field === 'customer_price' ? 'PRICE_CHANGED' : 'COMMISSION_CHANGED', objectType: 'order', objectId: o.internal_order_id, oldValue: o[field], newValue: toDecimalString(cents), reason, source: ctx.source, important: true });
    await refreshOrderViews(q, upd!);
    return upd!;
  });
}

export async function addCost(ctx: Ctx, actor: Actor, orderId: string, type: string, amount: string, note: string): Promise<void> {
  const cents = parseMoney(amount);
  if (cents <= 0) throw new DomainError('INVALID_AMOUNT', 'cost must be positive');
  await ctx.db.tx(async (q) => {
    const o = await lockOrder(q, orderId);
    await authorizeOrder(q, actor, 'order.editPrice', o);
    await q.query('INSERT INTO order_costs (order_id, type, amount, note, created_by) VALUES ($1,$2,$3,$4,$5)', [orderId, type, toDecimalString(cents), note, actorId(actor)]);
    await audit(q, { actor, action: 'ORDER_COST_ADDED', objectType: 'order', objectId: o.internal_order_id, newValue: { type, amount: toDecimalString(cents) }, reason: note, source: ctx.source, important: true });
    await refreshOrderViews(q, o);
  });
}

export async function addNote(ctx: Ctx, actor: Actor, orderId: string, text: string): Promise<void> {
  await ctx.db.tx(async (q) => {
    const o = await lockOrder(q, orderId);
    await authorizeOrder(q, actor, 'order.note', o);
    await q.query(`INSERT INTO order_events (order_id, from_status, to_status, actor_user_id, actor_kind, reason, payload) VALUES ($1,$2,$2,$3,$4,$5,$6)`, [
      orderId, o.status, actorId(actor), actorKind(actor), text.slice(0, 1000), JSON.stringify({ note: true }),
    ]);
    await refreshOrderViews(q, o);
  });
}

export async function orderMoney(q: Q, o: OrderRow) {
  const refunds = await many(q, 'SELECT amount FROM refunds WHERE order_id = $1', [o.id]);
  const costs = await many(q, 'SELECT amount FROM order_costs WHERE order_id = $1', [o.id]);
  const money = {
    customerPrice: fromDecimalString(o.customer_price),
    marketplaceCommission: fromDecimalString(o.marketplace_commission),
    providerCost: o.provider_cost == null ? null : fromDecimalString(o.provider_cost),
    refunds: refunds.map((r) => fromDecimalString(r.amount)),
    otherCosts: costs.map((r) => fromDecimalString(r.amount)),
  };
  return { ...money, profit: profit(money) };
}

export async function orderEvents(q: Q, orderId: string, limit = 15) {
  return many(q, `SELECT e.*, u.display_name FROM order_events e LEFT JOIN users u ON u.id = e.actor_user_id WHERE order_id = $1 ORDER BY id DESC LIMIT $2`, [orderId, limit]);
}
