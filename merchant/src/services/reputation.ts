// Reputation recompute (§15-16) and nightly level evaluation (§14).
import { belowDemotionLine, evaluateLevel } from '../core/levels.js';
import { computeReputation, type OrderOutcome } from '../core/reputation.js';
import { type Level, SYSTEM } from '../core/types.js';
import { many, one, type Q } from '../db/pool.js';
import { audit } from './audit.js';
import type { Ctx } from './context.js';
import { enqueue } from './jobs.js';

interface OutcomeRow extends OrderOutcome {
  gameId: string;
  serviceId: string;
}

/** One outcome per assignment the provider had (orders they were confirmed or selected on). */
async function outcomes(q: Q, providerId: string, now: Date): Promise<OutcomeRow[]> {
  const rows = await many(
    q,
    `SELECT a.status AS a_status, a.created_at, o.status, o.game_id, o.service_id, o.completed_at, o.delivered_at, o.deadline_at,
            EXISTS (SELECT 1 FROM disputes d WHERE d.order_id = o.id) AS disputed,
            (SELECT rating FROM reviews r WHERE r.order_id = o.id) AS rating
     FROM order_assignments a JOIN orders o ON o.id = a.order_id
     WHERE a.provider_id = $1 AND a.status IN ('COMPLETED','FAILED','EXPIRED','CANCELLED','CONFIRMED')`,
    [providerId],
  );
  return rows
    .filter((r) => r.a_status !== 'CONFIRMED' || r.completed_at) // still in progress: not an outcome yet
    .map((r) => {
      const completed = r.a_status === 'COMPLETED';
      const failed = r.a_status === 'FAILED' || r.a_status === 'EXPIRED';
      const at: Date = r.completed_at ?? r.created_at;
      return {
        gameId: r.game_id,
        serviceId: r.service_id,
        ageDays: (now.getTime() - new Date(at).getTime()) / 86_400_000,
        completed,
        providerFailed: failed,
        cancelledNotProviderFault: r.a_status === 'CANCELLED',
        onTime: completed ? !r.deadline_at || (r.delivered_at ?? r.completed_at) <= r.deadline_at : null,
        disputed: r.disputed,
        rating: r.rating,
      };
    });
}

export async function recomputeProvider(ctx: Ctx, providerId: string): Promise<number> {
  return ctx.db.tx(async (q) => {
    const all = await outcomes(q, providerId, ctx.now());
    const global = computeReputation(all);
    await q.query(
      `INSERT INTO provider_reputation (provider_id, global, components, counts, computed_at) VALUES ($1,$2,$3,$4, now())
       ON CONFLICT (provider_id) DO UPDATE SET global = EXCLUDED.global, components = EXCLUDED.components, counts = EXCLUDED.counts, computed_at = now()`,
      [providerId, global.reputation, JSON.stringify(global.components), JSON.stringify(global.counts)],
    );
    await q.query('UPDATE providers SET reputation = $2 WHERE id = $1', [providerId, global.reputation]);
    const group = (key: 'gameId' | 'serviceId') => {
      const m = new Map<string, OutcomeRow[]>();
      for (const o of all) if (o[key]) m.set(o[key], [...(m.get(o[key]) ?? []), o]);
      return m;
    };
    for (const [gameId, list] of group('gameId')) {
      const r = computeReputation(list);
      await q.query(
        `INSERT INTO provider_game_stats (provider_id, game_id, orders, completed, failed, disputed, reputation, computed_at) VALUES ($1,$2,$3,$4,$5,$6,$7, now())
         ON CONFLICT (provider_id, game_id) DO UPDATE SET orders = EXCLUDED.orders, completed = EXCLUDED.completed, failed = EXCLUDED.failed, disputed = EXCLUDED.disputed, reputation = EXCLUDED.reputation, computed_at = now()`,
        [providerId, gameId, r.counts.orders, r.counts.completed, r.counts.failed, r.counts.disputed, r.reputation],
      );
    }
    for (const [serviceId, list] of group('serviceId')) {
      const r = computeReputation(list);
      await q.query(
        `INSERT INTO provider_service_stats (provider_id, service_id, orders, completed, failed, disputed, reputation, computed_at) VALUES ($1,$2,$3,$4,$5,$6,$7, now())
         ON CONFLICT (provider_id, service_id) DO UPDATE SET orders = EXCLUDED.orders, completed = EXCLUDED.completed, failed = EXCLUDED.failed, disputed = EXCLUDED.disputed, reputation = EXCLUDED.reputation, computed_at = now()`,
        [providerId, serviceId, r.counts.orders, r.counts.completed, r.counts.failed, r.counts.disputed, r.reputation],
      );
    }
    return global.reputation;
  });
}

/** Nightly: recompute everyone, then evaluate levels with hysteresis. */
export async function nightlyLevels(ctx: Ctx): Promise<{ evaluated: number; changes: string[] }> {
  const providers = await many(ctx.db, `SELECT id FROM providers WHERE status IN ('ACTIVE','PAUSED')`);
  const changes: string[] = [];
  for (const { id } of providers) {
    await recomputeProvider(ctx, id);
    const change = await ctx.db.tx(async (q) => {
      const p = await one(q, 'SELECT * FROM providers WHERE id = $1 FOR UPDATE', [id]);
      const rep = await one(q, 'SELECT * FROM provider_reputation WHERE provider_id = $1', [id]);
      const stats = await one(
        q,
        `SELECT (SELECT count(*) FROM orders WHERE assigned_provider_id = $1 AND status IN ('COMPLETED','EARNING_RELEASED'))::int AS completed,
                (SELECT count(*) FROM order_assignments WHERE provider_id = $1 AND created_at > now() - interval '30 days')::int AS recent,
                (SELECT count(*) FROM provider_flags WHERE provider_id = $1 AND severity = 'SERIOUS' AND resolved_at IS NULL)::int AS flags`,
        [id],
      );
      const reputation = Number(rep?.global ?? 82);
      const below = belowDemotionLine(p.level as Level, reputation);
      const days = below ? p.days_below_threshold + 1 : 0;
      const d = evaluateLevel({
        current: p.level,
        completed: stats!.completed,
        tenureDays: p.approved_at ? (ctx.now().getTime() - new Date(p.approved_at).getTime()) / 86_400_000 : 0,
        reputation,
        disputeRate: Number(rep?.components?.disputeRate ?? 0.03),
        onTimeRate: Number(rep?.components?.onTimeRate ?? 0.85),
        activeLast30: stats!.recent > 0,
        openSeriousFlags: stats!.flags,
        daysBelowThreshold: days,
        eliteConfirmed: p.elite_confirmed,
      });
      await q.query('UPDATE providers SET days_below_threshold = $2 WHERE id = $1', [id, d.change === 'DEMOTE' ? 0 : days]);
      if (d.eliteCandidate) {
        await enqueue(q, 'discord.alert', { channel: 'exec-chat', text: `🏅 ${p.code} meets every ELITE criterion. An executive can confirm with /provider level ${p.code} ELITE.` }, { dedupeKey: `elite:${id}` });
      }
      if (d.change === 'NONE' || d.level === p.level) return null;
      await q.query('UPDATE providers SET level = $2 WHERE id = $1', [id, d.level]);
      await q.query('INSERT INTO provider_level_history (provider_id, from_level, to_level, reason, actor) VALUES ($1,$2,$3,$4,$5)', [id, p.level, d.level, d.reason, 'SYSTEM']);
      await audit(q, { actor: SYSTEM, action: 'PROVIDER_LEVEL_CHANGED', objectType: 'provider', objectId: p.code, oldValue: p.level, newValue: d.level, reason: d.reason, source: 'JOB' });
      await enqueue(q, 'discord.providerNotice', { providerId: id, text: d.change === 'PROMOTE' ? `🎉 You've been promoted to **${d.level}**.` : `Your level changed to **${d.level}** (${d.reason}).` });
      return `${p.code}: ${p.level} → ${d.level}`;
    });
    if (change) changes.push(change);
  }
  return { evaluated: providers.length, changes };
}
