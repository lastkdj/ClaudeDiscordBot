// Non-Discord job handlers. Discord side effects are registered by the bot (bot/effects.ts).
import { periodRange } from '../services/reports.js';
import type { MarketplaceAdapter } from '../marketplace/types.js';
import { SYSTEM } from '../core/types.js';
import type { Ctx } from '../services/context.js';
import { tickBidding } from '../services/bidding.js';
import { releaseEarning } from '../services/fulfillment.js';
import { processIntegrationEvent, reconcileOpenOrders } from '../services/intake.js';
import { enqueue } from '../services/jobs.js';
import { reconcileBalances } from '../services/ledger.js';
import { getOrder } from '../services/orders.js';
import { nightlyLevels, recomputeProvider } from '../services/reputation.js';
import { autoAssignIfEnabled, releaseAssignment } from '../services/selection.js';
import { getSettings } from '../services/settings.js';
import type { JobRunner } from './runner.js';

export function registerBusinessJobs(runner: JobRunner, base: Ctx, adapter: MarketplaceAdapter): void {
  const ctx: Ctx = { ...base, source: 'JOB' };
  runner
    .register('bidding.tick', (p) => tickBidding(ctx, p.orderId, p.round))
    .register('selection.auto', (p) => autoAssignIfEnabled(ctx, p.orderId))
    .register('assignment.confirmTimeout', (p) => releaseAssignment(ctx, SYSTEM, p.assignmentId, 'EXPIRED'))
    .register('ledger.release', (p) => releaseEarning(ctx, p.orderId))
    .register('ledger.reconcile', () => reconcileBalances(ctx))
    .register('reputation.provider', (p) => recomputeProvider(ctx, p.providerId))
    .register('reputation.nightly', async () => {
      const r = await nightlyLevels(ctx);
      if (r.changes.length) await enqueue(ctx.db, 'discord.alert', { channel: 'audit-log', text: `Nightly level review: ${r.changes.join(', ')}` });
      return r;
    })
    .register('integration.process', (p) => processIntegrationEvent(ctx, p.eventId))
    .register('marketplace.reconcile', async () => {
      if (!adapter.capabilities.pullOrders) return 'not connected';
      return reconcileOpenOrders(ctx, adapter.name, (id) => adapter.fetchOrder(id));
    })
    .register('marketplace.markDelivered', async (p) => {
      if (!adapter.markDelivered) return 'not supported';
      const o = await getOrder(ctx.db, p.orderId);
      if (!o?.marketplace_order_id || o.marketplace !== adapter.name) return 'skip';
      await adapter.markDelivered(o.marketplace_order_id, p.note, `deliver:${o.id}`);
      return 'sent';
    })
    .register('reports.post', async (p) => {
      const s = await getSettings(ctx.db);
      const range = periodRange(p.period, ctx.now(), s.timezone);
      await enqueue(ctx.db, 'discord.report', { from: range.from.toISOString(), to: range.to.toISOString(), label: range.label });
      return range.label;
    })
    .register('dashboards.refreshAll', async () => {
      const games = await ctx.db.query('SELECT game_id FROM discord_bindings WHERE dashboard_channel_id IS NOT NULL');
      for (const g of games.rows) await enqueue(ctx.db, 'discord.dashboard', { gameId: g.game_id }, { dedupeKey: `dashboard:${g.game_id}` });
      return games.rowCount;
    });
}
