// Executive reports (§20) and manager dashboards (§21), built from SQL over
// orders, refunds, costs, the ledger and order events.
import { authorize } from '../core/authz.js';
import { fromDecimalString } from '../core/money.js';
import type { Actor } from '../core/types.js';
import { many, one, type Q } from '../db/pool.js';
import { getSettings } from './settings.js';

export interface Range { from: Date; to: Date }

/** [from, to) for "yesterday", "last week" (Mon-Sun) or "last month" in the report timezone. */
export function periodRange(kind: 'daily' | 'weekly' | 'monthly', now: Date, tz: string): Range & { label: string } {
  const [y, m, d] = ymd(now, tz);
  const shift = (days: number): [number, number, number] => {
    const t = new Date(Date.UTC(y, m - 1, d + days));
    return [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()];
  };
  const at = (c: [number, number, number]) => zonedMidnight(c[0], c[1], c[2], tz);
  if (kind === 'daily') {
    const from = at(shift(-1));
    return { from, to: at(shift(0)), label: `Daily report · ${fmtDate(from, tz)}` };
  }
  if (kind === 'weekly') {
    const dow = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; // Monday = 0
    const from = at(shift(-dow - 7));
    const to = at(shift(-dow));
    return { from, to, label: `Weekly report · ${fmtDate(from, tz)} – ${fmtDate(new Date(to.getTime() - 1), tz)}` };
  }
  const from = m === 1 ? zonedMidnight(y - 1, 12, 1, tz) : zonedMidnight(y, m - 1, 1, tz);
  return { from, to: zonedMidnight(y, m, 1, tz), label: `Monthly report · ${new Intl.DateTimeFormat('en-GB', { timeZone: tz, month: 'long', year: 'numeric' }).format(from)}` };
}

function ymd(dt: Date, tz: string): [number, number, number] {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(dt).map((x) => [x.type, x.value]));
  return [Number(p.year), Number(p.month), Number(p.day)];
}

/** UTC instant of local midnight on a date in `tz`. */
export function zonedMidnight(y: number, m: number, d: number, tz: string): Date {
  const guess = Date.UTC(y, m - 1, d);
  const offset = (t: number) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second)) - t;
  };
  const first = guess - offset(guess);
  return new Date(guess - offset(first));
}

const fmtDate = (dt: Date, tz: string) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: '2-digit', month: 'short', year: 'numeric' }).format(dt);

export interface FinancialReport {
  orders: number;
  gross: number;
  commission: number;
  net: number;
  providerCost: number;
  refunds: number;
  otherCosts: number;
  profit: number;
  marginPct: number | null;
  avgOrderValue: number | null;
  avgProviderCost: number | null;
  balances: { pending: number; available: number; reserved: number };
  payouts: number;
  byGame: { game: string; orders: number; gross: number; profit: number }[];
  byService: { service: string; game: string; orders: number; gross: number; profit: number }[];
  inFlight: { orders: number; gross: number };
}

const c = (v: unknown) => fromDecimalString(v == null ? '0' : String(v));

/** Profit is recognized at COMPLETED (§18); later refunds/costs count in the period they happen. */
export async function financialReport(q: Q, r: Range, gameIds?: string[]): Promise<FinancialReport> {
  const gameFilter = gameIds ? 'AND o.game_id = ANY($3)' : '';
  const params: unknown[] = gameIds ? [r.from, r.to, gameIds] : [r.from, r.to];
  const done = await one(
    q,
    `SELECT count(*)::int AS orders, coalesce(sum(customer_price),0) AS gross, coalesce(sum(marketplace_commission),0) AS commission,
            coalesce(sum(provider_cost),0) AS cost
     FROM orders o WHERE completed_at >= $1 AND completed_at < $2 ${gameFilter}`,
    params,
  );
  const refunds = await one(q, `SELECT coalesce(sum(f.amount),0) AS s FROM refunds f JOIN orders o ON o.id = f.order_id WHERE f.created_at >= $1 AND f.created_at < $2 AND o.completed_at IS NOT NULL ${gameFilter}`, params);
  const costs = await one(q, `SELECT coalesce(sum(x.amount),0) AS s FROM order_costs x JOIN orders o ON o.id = x.order_id WHERE x.created_at >= $1 AND x.created_at < $2 ${gameFilter}`, params);
  const byGame = await many(
    q,
    `SELECT g.name AS game, count(*)::int AS orders, coalesce(sum(o.customer_price),0) AS gross,
            coalesce(sum(o.customer_price - o.marketplace_commission - coalesce(o.provider_cost,0)),0) AS profit
     FROM orders o JOIN games g ON g.id = o.game_id WHERE o.completed_at >= $1 AND o.completed_at < $2 ${gameFilter} GROUP BY g.name ORDER BY profit DESC`,
    params,
  );
  const byService = await many(
    q,
    `SELECT s.name AS service, g.name AS game, count(*)::int AS orders, coalesce(sum(o.customer_price),0) AS gross,
            coalesce(sum(o.customer_price - o.marketplace_commission - coalesce(o.provider_cost,0)),0) AS profit
     FROM orders o JOIN services s ON s.id = o.service_id JOIN games g ON g.id = o.game_id
     WHERE o.completed_at >= $1 AND o.completed_at < $2 ${gameFilter} GROUP BY s.name, g.name ORDER BY profit DESC LIMIT 15`,
    params,
  );
  const inflight = await one(q, `SELECT count(*)::int AS n, coalesce(sum(customer_price),0) AS gross FROM orders o WHERE completed_at IS NULL AND status NOT IN ('CANCELLED','REFUNDED') ${gameIds ? 'AND o.game_id = ANY($1)' : ''}`, gameIds ? [gameIds] : []);
  const bal = gameIds ? null : await one(q, `SELECT coalesce(sum(pending),0) AS p, coalesce(sum(available),0) AS a, coalesce(sum(reserved),0) AS r FROM provider_balances`);
  const payouts = gameIds ? null : await one(q, `SELECT coalesce(sum(amount),0) AS s FROM provider_payouts WHERE status = 'PAID' AND paid_at >= $1 AND paid_at < $2`, [r.from, r.to]);

  const gross = c(done!.gross), commission = c(done!.commission), providerCost = c(done!.cost), refundSum = c(refunds!.s), otherCosts = c(costs!.s);
  const profit = gross - commission - providerCost - refundSum - otherCosts;
  return {
    orders: done!.orders,
    gross,
    commission,
    net: gross - commission,
    providerCost,
    refunds: refundSum,
    otherCosts,
    profit,
    marginPct: gross > 0 ? profit / gross : null,
    avgOrderValue: done!.orders ? Math.round(gross / done!.orders) : null,
    avgProviderCost: done!.orders ? Math.round(providerCost / done!.orders) : null,
    balances: { pending: c(bal?.p), available: c(bal?.a), reserved: c(bal?.r) },
    payouts: c(payouts?.s),
    byGame: byGame.map((g) => ({ game: g.game, orders: g.orders, gross: c(g.gross), profit: c(g.profit) })),
    byService: byService.map((s) => ({ service: s.service, game: s.game, orders: s.orders, gross: c(s.gross), profit: c(s.profit) })),
    inFlight: { orders: inflight!.n, gross: c(inflight!.gross) },
  };
}

export interface OperationalReport {
  activeProviders: number;
  awaitingProvider: number;
  avgBidsPerOrder: number | null;
  avgProcurementMinutes: number | null;
  acceptanceRate: number | null;
  disputes: number;
  cancellations: number;
  providerFailures: number;
  overrideRate: number | null;
}

export async function operationalReport(q: Q, r: Range, gameIds?: string[]): Promise<OperationalReport> {
  const gf = gameIds ? 'AND o.game_id = ANY($3)' : '';
  const params: unknown[] = gameIds ? [r.from, r.to, gameIds] : [r.from, r.to];
  const x = await one(
    q,
    `SELECT
       (SELECT count(*) FROM providers WHERE status = 'ACTIVE')::int AS active_providers,
       (SELECT count(*) FROM orders o WHERE status IN ('BIDDING','BID_REVIEW','PROVIDER_SELECTED','REASSIGNMENT_REQUIRED') ${gameIds ? 'AND o.game_id = ANY($3)' : ''})::int AS awaiting,
       (SELECT avg(n) FROM (SELECT count(*) AS n FROM provider_bids b JOIN orders o ON o.id = b.order_id WHERE b.created_at >= $1 AND b.created_at < $2 ${gf} GROUP BY b.order_id) t) AS avg_bids,
       (SELECT avg(extract(epoch FROM o.accepted_at - o.validated_at) / 60) FROM orders o WHERE o.accepted_at >= $1 AND o.accepted_at < $2 AND o.validated_at IS NOT NULL ${gf}) AS avg_proc,
       (SELECT avg(CASE WHEN i.response = 'BID' THEN 1.0 ELSE 0 END) FROM bid_invitations i JOIN orders o ON o.id = i.order_id WHERE i.sent_at >= $1 AND i.sent_at < $2 ${gf}) AS acceptance,
       (SELECT count(*) FROM order_events e JOIN orders o ON o.id = e.order_id WHERE e.to_status = 'DISPUTED' AND e.created_at >= $1 AND e.created_at < $2 ${gf})::int AS disputes,
       (SELECT count(*) FROM order_events e JOIN orders o ON o.id = e.order_id WHERE e.to_status = 'CANCELLED' AND e.created_at >= $1 AND e.created_at < $2 ${gf})::int AS cancellations,
       (SELECT count(*) FROM order_events e JOIN orders o ON o.id = e.order_id WHERE e.to_status = 'PROVIDER_FAILED' AND e.created_at >= $1 AND e.created_at < $2 ${gf})::int AS failures,
       (SELECT avg(CASE WHEN a.overridden THEN 1.0 ELSE 0 END) FROM order_assignments a JOIN orders o ON o.id = a.order_id WHERE a.created_at >= $1 AND a.created_at < $2 ${gf}) AS override_rate`,
    params,
  );
  const num = (v: unknown) => (v == null ? null : Number(v));
  return {
    activeProviders: x!.active_providers,
    awaitingProvider: x!.awaiting,
    avgBidsPerOrder: num(x!.avg_bids),
    avgProcurementMinutes: num(x!.avg_proc),
    acceptanceRate: num(x!.acceptance),
    disputes: x!.disputes,
    cancellations: x!.cancellations,
    providerFailures: x!.failures,
    overrideRate: num(x!.override_rate),
  };
}

/** Detail rows for the CSV attachment. */
export async function reportRows(q: Q, r: Range, gameIds?: string[]) {
  return many(
    q,
    `SELECT o.internal_order_id, o.marketplace_order_id, g.name AS game, s.name AS service, o.status, o.currency, o.customer_price, o.marketplace_commission,
            o.commission_is_estimate, o.provider_cost, coalesce((SELECT sum(amount) FROM refunds f WHERE f.order_id = o.id),0) AS refunds,
            coalesce((SELECT sum(amount) FROM order_costs x WHERE x.order_id = o.id),0) AS other_costs, p.code AS provider, o.completed_at
     FROM orders o LEFT JOIN games g ON g.id = o.game_id LEFT JOIN services s ON s.id = o.service_id LEFT JOIN providers p ON p.id = o.assigned_provider_id
     WHERE o.completed_at >= $1 AND o.completed_at < $2 ${gameIds ? 'AND o.game_id = ANY($3)' : ''} ORDER BY o.completed_at`,
    gameIds ? [r.from, r.to, gameIds] : [r.from, r.to],
  );
}

export function toCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]!);
  const esc = (v: unknown) => {
    const s = v instanceof Date ? v.toISOString() : v == null ? '' : String(v);
    // Neutralize spreadsheet formulas and quote as needed.
    const safe = /^[=+\-@]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : s;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((col) => esc(r[col])).join(','))].join('\n') + '\n';
}

// ------------------------------------------------------------------ dashboards

export interface GameDashboard {
  counts: Record<string, number>;
  active: number;
  atRisk: string[];
  disputesOpen: number;
  providersAvailable: number;
  providersTotal: number;
  capacityFree: number;
  today: { completed: number; avgProcurementMin: number | null; acceptance: number | null; staffActions: number };
}

export async function gameDashboard(q: Q, gameId: string, now: Date): Promise<GameDashboard> {
  const s = await getSettings(q);
  const counts: Record<string, number> = Object.fromEntries((await many(q, `SELECT status, count(*)::int AS n FROM orders WHERE game_id = $1 AND status NOT IN ('COMPLETED','EARNING_RELEASED','CANCELLED','REFUNDED') GROUP BY status`, [gameId])).map((r) => [r.status, r.n]));
  const atRisk = await many(
    q,
    `SELECT internal_order_id FROM orders o WHERE game_id = $1 AND status NOT IN ('COMPLETED','EARNING_RELEASED','CANCELLED','REFUNDED','DELIVERED','MARKETPLACE_COMPLETION')
       AND ((deadline_at IS NOT NULL AND deadline_at < $2::timestamptz + make_interval(hours => $3))
            OR (status = 'BIDDING' AND NOT EXISTS (SELECT 1 FROM provider_bids b WHERE b.order_id = o.id AND b.status = 'ACTIVE') AND bid_window_extended)
            OR status = 'REASSIGNMENT_REQUIRED')
     ORDER BY deadline_at NULLS LAST LIMIT 10`,
    [gameId, now, s.atRiskHours],
  );
  const prov = await one(
    q,
    `SELECT count(DISTINCT p.id)::int AS total, count(DISTINCT p.id) FILTER (WHERE a.state = 'AVAILABLE')::int AS available
     FROM providers p JOIN provider_capabilities c ON c.provider_id = p.id AND c.status = 'APPROVED' AND c.game_id = $1
     LEFT JOIN provider_availability a ON a.provider_id = p.id WHERE p.status = 'ACTIVE'`,
    [gameId],
  );
  const cap = await one(
    q,
    `SELECT coalesce(sum(greatest(0, coalesce(p.max_concurrent, CASE p.level WHEN 'NEW' THEN 1 WHEN 'BRONZE' THEN 2 WHEN 'SILVER' THEN 3 ELSE 5 END)
              - (SELECT count(*) FROM orders o WHERE o.assigned_provider_id = p.id AND o.status IN ('PROVIDER_SELECTED','PROVIDER_CONFIRMED','IN_PROGRESS','DELIVERED')))), 0)::int AS free
     FROM providers p JOIN provider_availability a ON a.provider_id = p.id AND a.state IN ('AVAILABLE','BUSY')
     WHERE p.status = 'ACTIVE' AND EXISTS (SELECT 1 FROM provider_capabilities c WHERE c.provider_id = p.id AND c.status = 'APPROVED' AND c.game_id = $1)`,
    [gameId],
  );
  const dayStart = zonedMidnight(...ymd(now, s.timezone), s.timezone);
  const today = await operationalReport(q, { from: dayStart, to: now }, [gameId]);
  const completed = await one(q, `SELECT count(*)::int AS n FROM orders WHERE game_id = $1 AND completed_at >= $2`, [gameId, dayStart]);
  const staff = await one(q, `SELECT count(*)::int AS n FROM order_events e JOIN orders o ON o.id = e.order_id WHERE o.game_id = $1 AND e.created_at >= $2 AND e.actor_kind IN ('STAFF','MANAGER','EXECUTIVE')`, [gameId, dayStart]);
  const disputes = await one(q, `SELECT count(*)::int AS n FROM disputes d JOIN orders o ON o.id = d.order_id WHERE o.game_id = $1 AND d.status = 'OPEN'`, [gameId]);
  return {
    counts,
    active: Object.values(counts).reduce((a, b) => a + b, 0),
    atRisk: atRisk.map((r) => r.internal_order_id),
    disputesOpen: disputes!.n,
    providersAvailable: prov!.available,
    providersTotal: prov!.total,
    capacityFree: cap!.free,
    today: { completed: completed!.n, avgProcurementMin: today.avgProcurementMinutes, acceptance: today.acceptanceRate, staffActions: staff!.n },
  };
}

/** Per-provider performance table for /dashboard (managers: their games only). */
export async function providerPerformance(q: Q, actor: Actor, gameId: string) {
  authorize(actor, 'dashboard.game', { gameId });
  return many(
    q,
    `SELECT p.code, p.level, p.reputation, gs.orders, gs.completed, gs.failed, gs.disputed, gs.reputation AS game_rep, coalesce(a.state,'OFFLINE') AS availability
     FROM providers p JOIN provider_game_stats gs ON gs.provider_id = p.id AND gs.game_id = $1
     LEFT JOIN provider_availability a ON a.provider_id = p.id
     ORDER BY gs.completed DESC LIMIT 25`,
    [gameId],
  );
}
