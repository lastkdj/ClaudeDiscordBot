// Sealed bidding (ARCHITECTURE §11). Bids are stored only in the database and
// acknowledged ephemerally; providers never see other bids, counts or prices.
import { authorize } from '../core/authz.js';
import { ineligibilityReason, type ProviderSnapshot, windowEndsAt, windowOutcome } from '../core/eligibility.js';
import { type Cents, fromDecimalString, parseMoney, toDecimalString } from '../core/money.js';
import { type Actor, DomainError, type Level, SYSTEM } from '../core/types.js';
import { many, one, type Q } from '../db/pool.js';
import { audit } from './audit.js';
import { getService } from './catalog.js';
import type { Ctx } from './context.js';
import { enqueue } from './jobs.js';
import { lockOrder, type OrderRow, refreshOrderViews, transition } from './orders.js';
import { getSettings } from './settings.js';

/** Eligibility as one query (§11.1): capability, status, availability, capacity, game suspension. Level/probation checked after. */
export async function eligibleProviderSnapshots(q: Q, order: OrderRow): Promise<(ProviderSnapshot & { id: string; code: string; user_id: string; desk_thread_id: string | null })[]> {
  const rows = await many(
    q,
    `SELECT p.id, p.code, p.user_id, p.status, p.level, p.max_concurrent, p.desk_thread_id,
            coalesce(a.state, 'OFFLINE') AS availability,
            (SELECT count(*) FROM orders o WHERE o.assigned_provider_id = p.id AND o.status IN ('PROVIDER_SELECTED','PROVIDER_CONFIRMED','IN_PROGRESS','DELIVERED'))::int AS active_orders,
            (SELECT count(*) FROM orders o WHERE o.assigned_provider_id = p.id AND o.status IN ('COMPLETED','EARNING_RELEASED'))::int AS completed_orders,
            EXISTS (SELECT 1 FROM provider_game_suspensions s WHERE s.provider_id = p.id AND s.game_id = $1 AND s.lifted_at IS NULL) AS suspended_for_game,
            EXISTS (SELECT 1 FROM discord_identities d WHERE d.user_id = p.user_id AND $5::text IS NOT NULL AND lower(d.username) = lower($5)) AS conflict
     FROM providers p
     LEFT JOIN provider_availability a ON a.provider_id = p.id
     WHERE p.status = 'ACTIVE'
       AND EXISTS (
         SELECT 1 FROM provider_capabilities c
         WHERE c.provider_id = p.id AND c.status = 'APPROVED' AND c.game_id = $1
           AND (c.service_id = $2 OR (c.service_id IS NULL AND c.category_id = $3))
           AND (c.game_version_id IS NULL OR $4::uuid IS NULL OR c.game_version_id = $4))`,
    [order.game_id, order.service_id, (await getService(q, order.service_id!))?.category_id, order.game_version_id, order.customer_reference],
  );
  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    user_id: r.user_id,
    desk_thread_id: r.desk_thread_id,
    status: r.status,
    level: r.level as Level,
    availability: r.availability,
    maxConcurrent: r.max_concurrent,
    activeOrders: r.active_orders,
    completedOrders: r.completed_orders,
    hasApprovedCapability: true,
    suspendedForGame: r.suspended_for_game,
    conflict: r.conflict,
  }));
}

/** Opens (or reopens) sealed bidding and invites eligible providers. Order must be locked. */
export async function openBidding(q: Q, ctx: Ctx, order: OrderRow, actor: Actor, reason?: string | null): Promise<{ order: OrderRow; invited: number }> {
  const s = await getSettings(q);
  const service = await getService(q, order.service_id!);
  if (!service) throw new DomainError('INVALID_STATE', 'order has no service; classify it first');
  const round = order.bid_round + 1;
  const updated = await transition(q, order, 'BIDDING', actor, {
    reason,
    source: ctx.source,
    payload: { round },
    set: { bid_round: round, bid_window_opened_at: ctx.now(), bid_window_seconds: service.bid_window_seconds, bid_window_extended: false },
  });
  const invited = await inviteEligible(q, ctx, updated, s.allowBusyBidding, s.inviteWave);
  await enqueue(q, 'bidding.tick', { orderId: order.id, round }, { runAt: windowEndsAt({ openedAt: ctx.now(), windowSeconds: service.bid_window_seconds, extended: false }), dedupeKey: `tick:${order.id}:${round}` });
  if (!invited) {
    await enqueue(q, 'discord.alert', { channel: 'ops', gameId: order.game_id, text: `⚠️ ${order.internal_order_id}: no eligible providers are available right now. Bidding stays open for the window.` });
  }
  return { order: updated, invited };
}

async function inviteEligible(q: Q, ctx: Ctx, order: OrderRow, allowBusy: boolean, wave: number): Promise<number> {
  const service = (await getService(q, order.service_id!))!;
  const candidates = await eligibleProviderSnapshots(q, order);
  const eligible = candidates.filter((p) => ineligibilityReason(p, { riskTier: order.risk_tier ?? service.risk_tier, trialEligible: service.trial_eligible }, { allowBusy }) === null);
  // Already bidding in an earlier round: no second invite (they can still replace their bid).
  const alreadyActive = new Set((await many(q, `SELECT provider_id FROM provider_bids WHERE order_id = $1 AND status = 'ACTIVE'`, [order.id])).map((r) => r.provider_id));
  // Providers who already failed, timed out or declined a selection on this order are not asked again.
  for (const r of await many(q, `SELECT provider_id FROM order_assignments WHERE order_id = $1 AND status IN ('FAILED','EXPIRED','DECLINED')`, [order.id])) alreadyActive.add(r.provider_id);
  // Waves (§28): with very many eligible providers, invite the least busy first.
  const targets = eligible.filter((p) => !alreadyActive.has(p.id)).sort((a, b) => a.activeOrders - b.activeOrders).slice(0, wave);
  for (const p of targets) {
    await q.query(`INSERT INTO bid_invitations (order_id, provider_id, round) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [order.id, p.id, order.bid_round]);
    await enqueue(q, 'discord.bidInvite', { orderId: order.id, providerId: p.id, round: order.bid_round });
  }
  await audit(q, { actor: SYSTEM, action: 'BIDDING_OPENED', objectType: 'order', objectId: order.internal_order_id, newValue: { round: order.bid_round, invited: targets.length, eligible: eligible.length }, source: ctx.source });
  return targets.length;
}

export interface BidInput {
  amount: string;
  etaStartMin: number;
  etaDurationMin: number;
  note?: string | null;
}

export interface BidReceipt {
  orderCode: string;
  amount: Cents;
  currency: string;
  replaced: boolean;
  windowEndsAt: Date;
}

export async function submitBid(ctx: Ctx, actor: Actor, orderId: string, input: BidInput): Promise<BidReceipt> {
  if (actor.kind !== 'USER' || !actor.providerId) throw new DomainError('FORBIDDEN', 'only providers can bid');
  const providerId = actor.providerId;
  authorize(actor, 'bid.submit', { providerId });
  const amount = parseMoney(input.amount);
  if (amount <= 0) throw new DomainError('INVALID_AMOUNT', 'the price must be more than zero');
  if (!(Number.isInteger(input.etaStartMin) && input.etaStartMin >= 0 && input.etaStartMin <= 60 * 24 * 14)) throw new DomainError('INVALID', 'start time must be 0 to 20160 minutes');
  if (!(Number.isInteger(input.etaDurationMin) && input.etaDurationMin > 0 && input.etaDurationMin <= 60 * 24 * 60)) throw new DomainError('INVALID', 'duration must be at least 1 minute');

  return ctx.db.tx(async (q) => {
    const order = await lockOrder(q, orderId);
    if (order.status !== 'BIDDING') throw new DomainError('BIDDING_CLOSED', 'bidding on this order is closed');
    const invite = await one(q, 'SELECT 1 FROM bid_invitations WHERE order_id = $1 AND provider_id = $2', [orderId, providerId]);
    if (!invite) throw new DomainError('FORBIDDEN', 'you were not invited to this order');
    const s = await getSettings(q);
    const service = (await getService(q, order.service_id!))!;
    const snap = (await eligibleProviderSnapshots(q, order)).find((p) => p.id === providerId);
    const why = snap ? ineligibilityReason(snap, { riskTier: order.risk_tier ?? service.risk_tier, trialEligible: service.trial_eligible }, { allowBusy: s.allowBusyBidding }) : 'no longer eligible';
    if (why) throw new DomainError('NOT_ELIGIBLE', `You can't bid on this order right now (${why}).`);
    // Optional hidden ceiling (Q3): reject without revealing the number.
    if (service.bid_ceiling && amount > fromDecimalString(service.bid_ceiling)) throw new DomainError('ABOVE_CEILING', 'This bid is above what we can accept for this order.');
    const recent = await one(q, `SELECT count(*)::int AS n FROM provider_bids WHERE provider_id = $1 AND order_id = $2`, [providerId, orderId]);
    if (recent!.n >= 10) throw new DomainError('RATE_LIMITED', 'too many bid changes on this order');

    const prev = await one(q, `UPDATE provider_bids SET status = 'REPLACED' WHERE order_id = $1 AND provider_id = $2 AND status = 'ACTIVE' RETURNING id, amount`, [orderId, providerId]);
    const bid = await one(
      q,
      `INSERT INTO provider_bids (order_id, provider_id, round, amount, eta_start_min, eta_duration_min, note, status) VALUES ($1,$2,$3,$4,$5,$6,$7,'ACTIVE') RETURNING id`,
      [orderId, providerId, order.bid_round, toDecimalString(amount), input.etaStartMin, input.etaDurationMin, input.note?.slice(0, 500) ?? null],
    );
    await q.query(`UPDATE bid_invitations SET response = 'BID', responded_at = now() WHERE order_id = $1 AND provider_id = $2`, [orderId, providerId]);
    await audit(q, { actor, action: prev ? 'BID_REPLACED' : 'BID_SUBMITTED', objectType: 'order', objectId: order.internal_order_id, oldValue: prev ? { amount: prev.amount } : undefined, newValue: { bidId: bid!.id, amount: toDecimalString(amount), eta: input.etaStartMin + input.etaDurationMin }, source: ctx.source });
    const active = await one(q, `SELECT count(*)::int AS n FROM provider_bids WHERE order_id = $1 AND status = 'ACTIVE'`, [orderId]);
    const w = { openedAt: order.bid_window_opened_at!, windowSeconds: order.bid_window_seconds!, extended: order.bid_window_extended, activeBids: active!.n, closeAtBids: s.closeAtBids };
    if (windowOutcome(w, ctx.now()) === 'CLOSE') await closeBidding(q, ctx, order, SYSTEM, 'bid limit reached');
    else await refreshOrderViews(q, order);
    return { orderCode: order.internal_order_id, amount, currency: order.currency, replaced: !!prev, windowEndsAt: windowEndsAt(w) };
  });
}

export async function withdrawBid(ctx: Ctx, actor: Actor, orderId: string): Promise<void> {
  if (actor.kind !== 'USER' || !actor.providerId) throw new DomainError('FORBIDDEN', 'only providers can withdraw bids');
  await ctx.db.tx(async (q) => {
    const order = await lockOrder(q, orderId);
    if (order.status !== 'BIDDING') throw new DomainError('BIDDING_CLOSED', 'bidding is closed; bids can no longer be withdrawn');
    const r = await one(q, `UPDATE provider_bids SET status = 'WITHDRAWN' WHERE order_id = $1 AND provider_id = $2 AND status = 'ACTIVE' RETURNING id`, [orderId, actor.providerId]);
    if (!r) throw new DomainError('NOT_FOUND', 'you have no active bid on this order');
    await audit(q, { actor, action: 'BID_WITHDRAWN', objectType: 'order', objectId: order.internal_order_id, newValue: { bidId: r.id }, source: ctx.source });
    await refreshOrderViews(q, order);
  });
}

export async function declineInvitation(ctx: Ctx, actor: Actor, orderId: string): Promise<void> {
  if (actor.kind !== 'USER' || !actor.providerId) throw new DomainError('FORBIDDEN', 'only providers can decline');
  await ctx.db.tx(async (q) => {
    const r = await one(q, `UPDATE bid_invitations SET response = 'DECLINED', responded_at = now() WHERE order_id = $1 AND provider_id = $2 AND response IS NULL RETURNING order_id`, [orderId, actor.providerId]);
    if (!r) throw new DomainError('INVALID_STATE', 'already answered');
    await audit(q, { actor, action: 'BID_DECLINED', objectType: 'order', objectId: orderId, source: ctx.source });
  });
}

/** BIDDING -> BID_REVIEW. Order must be locked. */
export async function closeBidding(q: Q, ctx: Ctx, order: OrderRow, actor: Actor, reason: string): Promise<OrderRow> {
  const updated = await transition(q, order, 'BID_REVIEW', actor, { reason, source: ctx.source, payload: { round: order.bid_round } });
  await enqueue(q, 'discord.alert', { channel: 'ops', gameId: order.game_id, text: `🪙 ${order.internal_order_id}: bidding closed (${reason}). Review the bids on the order post.` });
  return updated;
}

/** Staff button: close now. */
export async function closeBiddingNow(ctx: Ctx, actor: Actor, orderId: string): Promise<void> {
  await ctx.db.tx(async (q) => {
    const o = await lockOrder(q, orderId);
    if (o.status !== 'BIDDING') throw new DomainError('INVALID_STATE', `order is ${o.status}`);
    const active = await one(q, `SELECT count(*)::int AS n FROM provider_bids WHERE order_id = $1 AND status = 'ACTIVE'`, [orderId]);
    if (!active!.n) throw new DomainError('NO_BIDS', 'there are no bids yet');
    await closeBidding(q, ctx, o, actor, 'closed by staff');
  });
}

/** Staff button: reopen bidding from review / reassignment. */
export async function reopenBidding(ctx: Ctx, actor: Actor, orderId: string, reason?: string | null): Promise<number> {
  return ctx.db.tx(async (q) => {
    const o = await lockOrder(q, orderId);
    const { invited } = await openBidding(q, ctx, o, actor, reason ?? 'reopened');
    return invited;
  });
}

/** Scheduled at the end of each window (§11.4). */
export async function tickBidding(ctx: Ctx, orderId: string, round: number): Promise<string> {
  return ctx.db.tx(async (q) => {
    const o = await lockOrder(q, orderId);
    if (o.status !== 'BIDDING' || o.bid_round !== round) return 'stale';
    const s = await getSettings(q);
    const active = await one(q, `SELECT count(*)::int AS n FROM provider_bids WHERE order_id = $1 AND status = 'ACTIVE'`, [orderId]);
    const w = { openedAt: o.bid_window_opened_at!, windowSeconds: o.bid_window_seconds!, extended: o.bid_window_extended, activeBids: active!.n, closeAtBids: s.closeAtBids };
    const outcome = windowOutcome(w, ctx.now());
    if (outcome === 'OPEN') {
      await enqueue(q, 'bidding.tick', { orderId, round }, { runAt: windowEndsAt(w), dedupeKey: `tick:${orderId}:${round}:${w.extended ? 'x' : 'n'}` });
      return 'open';
    }
    if (outcome === 'CLOSE') {
      await closeBidding(q, ctx, o, SYSTEM, 'window closed');
      return 'closed';
    }
    if (outcome === 'EXTEND') {
      await q.query('UPDATE orders SET bid_window_extended = true, version = version + 1 WHERE id = $1', [orderId]);
      await audit(q, { actor: SYSTEM, action: 'BIDDING_EXTENDED', objectType: 'order', objectId: o.internal_order_id, source: ctx.source });
      // Re-invite anyone who became eligible since the window opened.
      await inviteEligible(q, ctx, { ...o, bid_window_extended: true }, s.allowBusyBidding, s.inviteWave);
      await enqueue(q, 'bidding.tick', { orderId, round }, { runAt: windowEndsAt({ ...w, extended: true }), dedupeKey: `tick:${orderId}:${round}:x` });
      return 'extended';
    }
    await transition(q, o, 'REASSIGNMENT_REQUIRED', SYSTEM, { reason: 'no bids after extension', source: ctx.source });
    await enqueue(q, 'discord.alert', { channel: 'ops', gameId: o.game_id, mentionManagers: true, text: `🚨 ${o.internal_order_id}: no bids after the extended window. A manager needs to act (reopen bidding, adjust, or cancel).` });
    return 'no-bids';
  });
}

export async function activeBids(q: Q, orderId: string) {
  return many(q, `SELECT b.*, p.code FROM provider_bids b JOIN providers p ON p.id = b.provider_id WHERE b.order_id = $1 AND b.status = 'ACTIVE' ORDER BY b.created_at`, [orderId]);
}

export async function myBid(q: Q, orderId: string, providerId: string) {
  return one(q, `SELECT amount, eta_start_min, eta_duration_min, note FROM provider_bids WHERE order_id = $1 AND provider_id = $2 AND status = 'ACTIVE'`, [orderId, providerId]);
}
