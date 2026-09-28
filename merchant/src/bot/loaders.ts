// Builds view models from the database for the Discord layer.
import { fromDecimalString } from '../core/money.js';
import { windowEndsAt } from '../core/eligibility.js';
import { many, one, type Q } from '../db/pool.js';
import type { ProviderOrderView, StaffOrderView } from '../discord-ui/views.js';
import { getService } from '../services/catalog.js';
import { type OrderRow, orderMoney } from '../services/orders.js';
import { buildReview } from '../services/selection.js';

export async function orderNames(q: Q, o: OrderRow) {
  const r = await one(
    q,
    `SELECT g.name AS game, g.short_name, g.channel_prefix, v.name AS version, s.name AS service, c.name AS category
     FROM orders o LEFT JOIN games g ON g.id = o.game_id LEFT JOIN game_versions v ON v.id = o.game_version_id
     LEFT JOIN services s ON s.id = o.service_id LEFT JOIN service_categories c ON c.id = s.category_id WHERE o.id = $1`,
    [o.id],
  );
  return { game: r?.game ?? 'Unclassified', version: r?.version ?? null, service: r?.service ?? 'Unknown service', category: r?.category ?? '—' };
}

export async function staffOrderView(q: Q, o: OrderRow, now: Date): Promise<StaffOrderView> {
  const names = await orderNames(q, o);
  const m = await orderMoney(q, o);
  const counts = await one(
    q,
    `SELECT (SELECT count(*) FROM provider_bids WHERE order_id = $1 AND status = 'ACTIVE')::int AS bids,
            (SELECT count(*) FROM bid_invitations WHERE order_id = $1 AND round = $2)::int AS invited,
            (SELECT count(*) FROM bid_invitations WHERE order_id = $1 AND round = $2 AND response = 'DECLINED')::int AS declined,
            (SELECT code FROM providers WHERE id = $3) AS provider_code,
            (SELECT count(*) FROM order_events WHERE order_id = $1 AND payload ? 'customerMessage')::int AS messages`,
    [o.id, o.bid_round, o.assigned_provider_id],
  );
  const events = await many(
    q,
    `SELECT e.created_at, e.from_status, e.to_status, e.actor_kind, e.reason, e.payload, u.display_name
     FROM order_events e LEFT JOIN users u ON u.id = e.actor_user_id WHERE e.order_id = $1 ORDER BY e.id DESC LIMIT 8`,
    [o.id],
  );
  let review = null;
  let ev = null;
  if (o.service_id && ['BID_REVIEW', 'REASSIGNMENT_REQUIRED', 'PROVIDER_SELECTED'].includes(o.status)) {
    const r = await buildReview(q, o, now);
    review = r.recommendation;
    ev = r.ev;
  }
  return {
    id: o.id,
    code: o.internal_order_id,
    status: o.status,
    source: o.source,
    marketplaceOrderId: o.marketplace_order_id,
    customer: o.customer_reference,
    ...names,
    quantity: o.quantity,
    configuration: o.configuration ?? {},
    currency: o.currency,
    price: m.customerPrice,
    commission: m.marketplaceCommission,
    commissionIsEstimate: o.commission_is_estimate,
    providerCost: m.providerCost,
    refunds: m.refunds.reduce((a, b) => a + b, 0),
    otherCosts: m.otherCosts.reduce((a, b) => a + b, 0),
    profit: m.profit,
    riskTier: o.risk_tier,
    deadlineAt: o.deadline_at,
    windowEndsAt: o.bid_window_opened_at && o.bid_window_seconds ? windowEndsAt({ openedAt: o.bid_window_opened_at, windowSeconds: o.bid_window_seconds, extended: o.bid_window_extended }) : null,
    activeBidCount: counts!.bids,
    invited: counts!.invited,
    declined: counts!.declined,
    assignedProviderCode: counts!.provider_code,
    review,
    ev,
    events: events.reverse().map((e) => ({
      at: e.created_at,
      text: e.payload?.note
        ? `📝 ${e.display_name ?? e.actor_kind}: ${e.reason}`
        : e.payload?.customerMessage
          ? `💬 customer message`
          : `${e.from_status ?? '∅'} → ${e.to_status} (${e.display_name ?? e.actor_kind})${e.reason ? `: ${e.reason}` : ''}`,
    })),
    customerMessages: counts!.messages,
  };
}

/** Provider-safe view: only what fulfillment needs (§6). */
export async function providerOrderView(q: Q, o: OrderRow): Promise<ProviderOrderView> {
  const names = await orderNames(q, o);
  const service = o.service_id ? await getService(q, o.service_id) : null;
  return {
    id: o.id,
    code: o.internal_order_id,
    game: names.game,
    version: names.version,
    service: names.service,
    quantity: o.quantity,
    deadlineAt: o.deadline_at,
    requirements: (service?.requirement_schema ?? []).filter((r) => r.required).map((r) => r.label),
    windowEndsAt: o.bid_window_opened_at && o.bid_window_seconds ? windowEndsAt({ openedAt: o.bid_window_opened_at, windowSeconds: o.bid_window_seconds, extended: o.bid_window_extended }) : null,
    currency: o.currency,
  };
}

export const cents = fromDecimalString;
