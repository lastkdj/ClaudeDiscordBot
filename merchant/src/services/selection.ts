// Bid review, recommendation and assignment (ARCHITECTURE §12-13, §17, §22).
import { profit } from '../core/accounting.js';
import { authorize, can } from '../core/authz.js';
import { fromDecimalString } from '../core/money.js';
import { type BidInput, DEFAULT_PARAMS, DEFAULT_WEIGHTS, expectedValue, pickRestriction, recommend, type Recommendation, type ScoringParams, type Weights } from '../core/scoring.js';
import { type Actor, actorId, DomainError, type Level, type ScoringProfile, SYSTEM } from '../core/types.js';
import { many, one, type Q } from '../db/pool.js';
import { audit } from './audit.js';
import { getService } from './catalog.js';
import type { Ctx } from './context.js';
import { cancelJobs, enqueue } from './jobs.js';
import { lockOrder, type OrderRow, orderResource, transition } from './orders.js';
import { getSettings } from './settings.js';

interface ScoringConfig { id: string; profile: ScoringProfile; version: number; weights: Weights; params: Partial<ScoringParams> }

export async function activeScoringConfig(q: Q, profile: ScoringProfile): Promise<ScoringConfig> {
  const r = await one(q, 'SELECT id, profile, version, weights, params FROM scoring_configurations WHERE profile = $1 AND active', [profile]);
  return r ?? { id: '', profile, version: 0, weights: DEFAULT_WEIGHTS[profile], params: DEFAULT_PARAMS };
}

/** Gathers every scoring input for the order's active bids (§13.2). */
export async function scoringInputs(q: Q, order: OrderRow): Promise<BidInput[]> {
  const rows = await many(
    q,
    `SELECT b.id AS bid_id, b.amount, b.eta_start_min, b.eta_duration_min, p.id AS provider_id, p.code, p.level,
            coalesce(r.global, 82) AS global_rep, r.components, r.counts,
            ss.reputation AS service_rep, ss.orders AS service_orders, coalesce(ss.completed, 0) AS service_completed,
            gs.reputation AS game_rep, gs.orders AS game_orders,
            (SELECT count(*) FROM orders o WHERE o.assigned_provider_id = p.id AND o.completed_at > now() - interval '30 days'
               AND (o.deadline_at IS NULL OR o.delivered_at <= o.deadline_at))::int AS recent_good,
            (SELECT count(*) FROM order_assignments a WHERE a.provider_id = p.id AND a.created_at > now() - interval '30 days'
               AND a.status IN ('COMPLETED','FAILED','EXPIRED'))::int AS recent_total,
            (SELECT count(*) FROM order_assignments a WHERE a.provider_id = p.id AND a.created_at > now() - interval '7 days')::int AS recent_assignments,
            (SELECT count(*) FROM orders o WHERE o.assigned_provider_id = p.id AND o.status IN ('COMPLETED','EARNING_RELEASED'))::int AS completed_orders
     FROM provider_bids b
     JOIN providers p ON p.id = b.provider_id
     LEFT JOIN provider_reputation r ON r.provider_id = p.id
     LEFT JOIN provider_service_stats ss ON ss.provider_id = p.id AND ss.service_id = $2
     LEFT JOIN provider_game_stats gs ON gs.provider_id = p.id AND gs.game_id = $3
     WHERE b.order_id = $1 AND b.status = 'ACTIVE' AND p.status = 'ACTIVE'`,
    [order.id, order.service_id, order.game_id],
  );
  return rows.map((r) => ({
    bidId: r.bid_id,
    providerId: r.provider_id,
    providerCode: r.code,
    amount: fromDecimalString(r.amount),
    etaMinutes: r.eta_start_min + r.eta_duration_min,
    level: r.level as Level,
    globalReputation: Number(r.global_rep),
    serviceReputation: r.service_rep != null && r.service_orders >= 5 ? Number(r.service_rep) : null,
    gameReputation: r.game_rep != null && r.game_orders >= 5 ? Number(r.game_rep) : null,
    serviceCompleted: r.service_completed,
    recentGood: Math.min(r.recent_good, r.recent_total),
    recentTotal: r.recent_total,
    onTimeRate: Number(r.components?.onTimeRate ?? 0.85),
    recentAssignments: r.recent_assignments,
    completedOrders: r.completed_orders,
    completionRate: Number(r.components?.completionRate ?? 0.9),
  }));
}

export interface Review {
  order: OrderRow;
  recommendation: Recommendation;
  inputs: BidInput[];
  scoringConfigId: string;
  ev: number | null;
}

/** Deterministic per order+round, so the same review always shows the same recommendation. */
function seededRandom(seed: string): () => number {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => ((h >>> 0) % 10000) / 10000;
}

export async function buildReview(q: Q, order: OrderRow, now: Date): Promise<Review> {
  const service = await getService(q, order.service_id!);
  if (!service) throw new DomainError('INVALID_STATE', 'order has no service');
  const s = await getSettings(q);
  const cfg = await activeScoringConfig(q, service.scoring_profile);
  const inputs = await scoringInputs(q, order);
  const recommendation = recommend(
    {
      customerPrice: fromDecimalString(order.customer_price),
      commission: fromDecimalString(order.marketplace_commission),
      riskTier: order.risk_tier ?? service.risk_tier,
      minutesToDeadline: order.deadline_at ? Math.floor((order.deadline_at.getTime() - now.getTime()) / 60000) : null,
    },
    inputs,
    { profile: service.scoring_profile, weights: cfg.weights, params: { ...cfg.params, minMargin: s.minMargin, epsilon: s.epsilon }, random: seededRandom(`${order.id}:${order.bid_round}`) },
  );
  let ev: number | null = null;
  const top = recommendation.recommended;
  if (top) {
    const input = inputs.find((i) => i.bidId === top.bidId)!;
    ev = expectedValue(recommendation.net, top.amount, input.completionRate, Math.round(recommendation.net * s.failureCostShare));
  }
  return { order, recommendation, inputs, scoringConfigId: cfg.id, ev };
}

/** Staff/manager assigns a bid (ASSISTED mode). Picking anything but the recommendation needs a reason. */
export async function assignBid(ctx: Ctx, actor: Actor, orderId: string, bidId: string, overrideReason?: string | null): Promise<{ assignmentId: string; overridden: boolean }> {
  return ctx.db.tx(async (q) => {
    const order = await lockOrder(q, orderId);
    if (order.status !== 'BID_REVIEW') throw new DomainError('INVALID_STATE', `order is ${order.status}, not in bid review`);
    const s = await getSettings(q);
    const thresholds = { highValueCents: s.highValueCents };
    authorize(actor, 'order.assign', orderResource(order), thresholds);
    const review = await buildReview(q, order, ctx.now());
    const chosen = review.recommendation.ranked.find((b) => b.bidId === bidId);
    if (!chosen) throw new DomainError('NOT_FOUND', 'that bid is no longer active');
    const restriction = pickRestriction(chosen);
    if (restriction === 'NOBODY') throw new DomainError('FORBIDDEN', `bid cannot be picked: ${chosen.ineligible}`);
    const isManager = actor.kind === 'USER' && (actor.orgRole === 'MANAGER' || actor.orgRole === 'EXECUTIVE');
    if (restriction === 'MANAGER' && !isManager) throw new DomainError('FORBIDDEN', `only a manager can pick a flagged bid (${chosen.flags.join(', ')})`);
    const service = (await getService(q, order.service_id!))!;
    const highRisk = (order.risk_tier ?? service.risk_tier) === 'HIGH' || fromDecimalString(order.customer_price) >= s.highValueCents;
    if (highRisk) authorize(actor, 'order.approveHighValue', orderResource(order), thresholds);
    const recommended = review.recommendation.recommended;
    const overridden = !recommended || recommended.bidId !== bidId;
    if (overridden) {
      authorize(actor, 'order.override', orderResource(order), thresholds);
      if (!(overrideReason && overrideReason.trim().length >= 3)) throw new DomainError('REASON_REQUIRED', 'choosing a different provider than recommended needs a reason');
    }
    const deadline = new Date(ctx.now().getTime() + s.confirmTimeoutMinutes * 60_000);
    const a = await one(
      q,
      `INSERT INTO order_assignments (order_id, provider_id, bid_id, recommended_provider_id, recommendation_mode, overridden, override_reason,
         approved_by, score_breakdown, scoring_config_id, assigned_by, confirm_deadline_at, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'PENDING_CONFIRM') RETURNING id`,
      [
        orderId, chosen.providerId, bidId, recommended?.providerId ?? null, review.recommendation.mode, overridden, overridden ? overrideReason : null,
        highRisk ? actorId(actor) : null,
        JSON.stringify({ profile: review.recommendation.profile, weights: review.recommendation.weights, params: review.recommendation.params, ranked: review.recommendation.ranked, inputs: review.inputs, explanation: review.recommendation.explanation }),
        review.scoringConfigId || null, actorId(actor), deadline,
      ],
    );
    await transition(q, order, 'PROVIDER_SELECTED', actor, { source: ctx.source, preAuthorized: true, set: { assigned_provider_id: chosen.providerId, assigned_staff_id: actorId(actor) }, payload: { providerCode: chosen.providerCode, overridden } });
    if (overridden) {
      await audit(q, { actor, action: 'RECOMMENDATION_OVERRIDDEN', objectType: 'order', objectId: order.internal_order_id, oldValue: { recommended: recommended?.providerCode ?? null }, newValue: { chosen: chosen.providerCode }, reason: overrideReason, source: ctx.source, important: true });
    }
    await enqueue(q, 'discord.selectionNotice', { assignmentId: a!.id });
    await enqueue(q, 'assignment.confirmTimeout', { assignmentId: a!.id }, { runAt: deadline });
    return { assignmentId: a!.id as string, overridden };
  });
}

/** AUTOMATIC mode (§30 phase 15): assigns the recommendation for LOW-risk services listed in autoAssignServices. */
export async function autoAssignIfEnabled(ctx: Ctx, orderId: string): Promise<boolean> {
  const o = await one(ctx.db, `SELECT o.status, o.service_id, coalesce(o.risk_tier, s.risk_tier) AS risk FROM orders o JOIN services s ON s.id = o.service_id WHERE o.id = $1`, [orderId]);
  const setting = await one(ctx.db, `SELECT value FROM system_settings WHERE key = 'autoAssignServices'`);
  const enabled: string[] = setting?.value ?? [];
  if (!o || o.status !== 'BID_REVIEW' || o.risk !== 'LOW' || !enabled.includes(o.service_id)) return false;
  const order = await one<OrderRow>(ctx.db, 'SELECT * FROM orders WHERE id = $1', [orderId]);
  const review = await buildReview(ctx.db, order!, ctx.now());
  if (!review.recommendation.recommended || review.recommendation.mode === 'EXPLORATION') return false;
  await assignBid(ctx, SYSTEM, orderId, review.recommendation.recommended.bidId);
  return true;
}

async function lockAssignment(q: Q, assignmentId: string) {
  const a = await one(q, 'SELECT * FROM order_assignments WHERE id = $1', [assignmentId]);
  if (!a) throw new DomainError('NOT_FOUND', 'assignment not found');
  const order = await lockOrder(q, a.order_id);
  const locked = await one(q, 'SELECT * FROM order_assignments WHERE id = $1 FOR UPDATE', [assignmentId]);
  return { a: locked, order };
}

export async function confirmAssignment(ctx: Ctx, actor: Actor, assignmentId: string): Promise<OrderRow> {
  return ctx.db.tx(async (q) => {
    const { a, order } = await lockAssignment(q, assignmentId);
    const isProvider = actor.kind === 'USER' && actor.providerId === a.provider_id;
    if (!isProvider && !(actor.kind === 'USER' && can(actor, 'order.approveHighValue', orderResource(order)))) throw new DomainError('FORBIDDEN', 'only the selected provider can confirm');
    if (a.status !== 'PENDING_CONFIRM') throw new DomainError('INVALID_STATE', a.status === 'EXPIRED' ? 'the confirmation time ran out' : `assignment is ${a.status}`);
    if (new Date(a.confirm_deadline_at) < ctx.now()) throw new DomainError('INVALID_STATE', 'the confirmation time ran out');
    const bid = await one(q, 'SELECT amount FROM provider_bids WHERE id = $1', [a.bid_id]);
    await q.query(`UPDATE order_assignments SET status = 'CONFIRMED' WHERE id = $1`, [assignmentId]);
    await q.query(`UPDATE provider_bids SET status = 'WON' WHERE id = $1`, [a.bid_id]);
    await q.query(`UPDATE provider_bids SET status = 'LOST' WHERE order_id = $1 AND status = 'ACTIVE'`, [order.id]);
    const updated = await transition(q, order, 'PROVIDER_CONFIRMED', actor, { source: ctx.source, preAuthorized: true, set: { provider_cost: bid!.amount } });
    await cancelJobs(q, 'assignment.confirmTimeout', { assignmentId });
    await enqueue(q, 'discord.orderRoom', { orderId: order.id });
    return updated;
  });
}

/** Provider declines, or the confirmation times out: back to review with the remaining bids. */
export async function releaseAssignment(ctx: Ctx, actor: Actor, assignmentId: string, outcome: 'DECLINED' | 'EXPIRED', reason?: string | null): Promise<string> {
  return ctx.db.tx(async (q) => {
    const { a, order } = await lockAssignment(q, assignmentId);
    if (a.status !== 'PENDING_CONFIRM') return 'stale';
    if (outcome === 'DECLINED' && !(actor.kind === 'USER' && actor.providerId === a.provider_id)) throw new DomainError('FORBIDDEN', 'only the selected provider can decline');
    if (outcome === 'EXPIRED' && new Date(a.confirm_deadline_at) > ctx.now()) return 'not-yet';
    await q.query(`UPDATE order_assignments SET status = $2 WHERE id = $1`, [assignmentId, outcome]);
    await q.query(`UPDATE provider_bids SET status = 'WITHDRAWN' WHERE id = $1`, [a.bid_id]);
    let o = await transition(q, order, 'REASSIGNMENT_REQUIRED', outcome === 'EXPIRED' ? SYSTEM : actor, { reason: reason ?? outcome.toLowerCase(), source: ctx.source, preAuthorized: true, set: { assigned_provider_id: null } });
    if (outcome === 'EXPIRED') {
      await q.query(`INSERT INTO provider_flags (provider_id, type, severity, note) VALUES ($1, 'CONFIRM_TIMEOUT', 'WARNING', $2)`, [a.provider_id, order.internal_order_id]);
      await enqueue(q, 'discord.providerNotice', { providerId: a.provider_id, text: `⌛ You didn't confirm ${order.internal_order_id} in time, so it went to another provider.` });
    }
    const remaining = await one(q, `SELECT count(*)::int AS n FROM provider_bids WHERE order_id = $1 AND status = 'ACTIVE'`, [order.id]);
    if (remaining!.n > 0) o = await transition(q, o, 'BID_REVIEW', SYSTEM, { source: ctx.source, reason: 'next bid' });
    await enqueue(q, 'discord.alert', { channel: 'ops', gameId: order.game_id, text: `↩️ ${order.internal_order_id}: selected provider ${outcome === 'DECLINED' ? 'declined' : 'did not confirm in time'}. ${remaining!.n ? 'Pick the next bid on the order post.' : 'No bids left: reopen bidding.'}` });
    return o.status;
  });
}

/** Profit shown in the review header (price - commission - bid). */
export function reviewProfit(order: OrderRow, bidAmount: number): number {
  return profit({ customerPrice: fromDecimalString(order.customer_price), marketplaceCommission: fromDecimalString(order.marketplace_commission), providerCost: bidAmount, refunds: [], otherCosts: [] });
}
