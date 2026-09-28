// Webhook ingestion over HTTP with a real Postgres: signatures, idempotency,
// out-of-order events, refunds and completion (§7, §25).
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApi } from '../../src/api/server.js';
import { GenericWebhookAdapter, signGeneric } from '../../src/marketplace/generic.js';
import { bootstrapOwner } from '../../src/services/users.js';
import { mapListing, setFeeRule } from '../../src/services/catalog.js';
import { acceptProviderRules, reviewApplication, setAvailability, setLevelManually, submitApplication } from '../../src/services/providers.js';
import { closeBiddingNow, submitBid } from '../../src/services/bidding.js';
import { assignBid, buildReview, confirmAssignment } from '../../src/services/selection.js';
import { startWork } from '../../src/services/fulfillment.js';
import { getOrder } from '../../src/services/orders.js';
import { balances } from '../../src/services/ledger.js';
import { JobRunner } from '../../src/worker/runner.js';
import { registerBusinessJobs } from '../../src/worker/business-jobs.js';
import { silentLogger } from '../../src/logger.js';
import { actorOf, dbAvailable, discordUser, gameId, type Harness, makeStaff, serviceId, setupHarness } from './harness.js';

const available = await dbAvailable();
const SECRET = 'webhook-secret-xyz';
const fixture = JSON.parse(readFileSync(new URL('../fixtures/generic-order-created.json', import.meta.url), 'utf8'));

describe.skipIf(!available)('marketplace webhooks (integration)', () => {
  let h: Harness;
  let api: ReturnType<typeof buildApi>;
  let runner: JobRunner;
  const adapter = new GenericWebhookAdapter({ name: 'mp', secret: SECRET });
  const post = (body: unknown, opts: { ts?: number; secret?: string } = {}) => {
    const raw = JSON.stringify(body);
    return api.inject({ method: 'POST', url: '/webhooks/mp', headers: { 'content-type': 'application/json', ...signGeneric(opts.secret ?? SECRET, raw, opts.ts ?? Math.floor(h.clock.now.getTime() / 1000)) }, payload: raw });
  };
  const event = (id: string, type: string, extra: Record<string, unknown> = {}) => ({ id, type, occurred_at: h.clock.now.toISOString(), order_id: 'MP-5001', ...extra });

  beforeAll(async () => {
    h = await setupHarness();
    h.clock.now = new Date('2026-09-28T10:00:05Z');
    const owner = discordUser('owner2');
    await bootstrapOwner(h.ctx, owner);
    const exec = await actorOf(h.db, owner);
    const wow = await gameId(h.db, 'wow');
    const mplus = await serviceId(h.db, 'wow', 'mythic-plus', 'key-timed');
    await mapListing(h.ctx, exec, { marketplace: 'mp', listingId: 'LST-MPLUS-10', serviceId: mplus });
    await setFeeRule(h.ctx, exec, { marketplace: 'mp', rate: 0.1 });
    const mgr = await makeStaff(h, exec, discordUser('mgr2'), 'MANAGER', [wow]);
    const p = discordUser('prov2');
    await acceptProviderRules(h.ctx, p);
    const app = await submitApplication(h.ctx, p, { displayName: 'p', timezone: 'UTC', experience: 'x', capabilities: [{ gameId: wow, serviceId: mplus }] });
    await reviewApplication(h.ctx, mgr, app, wow, 'APPROVE');
    const pa = await actorOf(h.db, p);
    await setAvailability(h.ctx, pa, 'AVAILABLE');
    await setLevelManually(h.ctx, exec, (pa as any).providerId, 'GOLD', 'test');
    api = buildApi({ ctx: h.ctx, adapter });
    runner = new JobRunner({ ...h.ctx }, silentLogger);
    registerBusinessJobs(runner, h.ctx, adapter);
    (globalThis as any).__t = { mgr, pa };
  });
  afterAll(async () => {
    await api?.close();
    await h?.close();
  });

  it('rejects bad signatures and stale timestamps', async () => {
    expect((await post(fixture, { secret: 'wrong' })).statusCode).toBe(401);
    expect((await post(fixture, { ts: Math.floor(h.clock.now.getTime() / 1000) - 3600 })).statusCode).toBe(401);
    expect((await api.inject({ method: 'POST', url: '/webhooks/other', headers: { 'content-type': 'application/json' }, payload: '{}' })).statusCode).toBe(404);
  });

  it('stores each event once and creates exactly one order under duplicate delivery', async () => {
    const r1 = await post(fixture);
    const r2 = await post(fixture);
    expect(r1.statusCode).toBe(200);
    expect(r1.json()).toMatchObject({ stored: 1, duplicates: 0 });
    expect(r2.json()).toMatchObject({ stored: 0, duplicates: 1 });
    await runner.drain();
    const orders = (await h.db.query(`SELECT * FROM orders WHERE marketplace = 'mp'`)).rows;
    expect(orders).toHaveLength(1);
    expect(orders[0].status).toBe('BIDDING');
    expect(orders[0].marketplace_commission).toBe('6.00');
    expect(orders[0].commission_is_estimate).toBe(false);
  });

  it('ignores stale updates that arrive out of order', async () => {
    const stale = { ...fixture.events[0], id: 'evt_old', type: 'ORDER_UPDATED', order: { ...fixture.events[0].order, price: '1.00', updated_at: '2026-09-28T09:00:00Z' } };
    await post(stale);
    await runner.drain();
    const o = (await h.db.query(`SELECT customer_price FROM orders WHERE marketplace_order_id = 'MP-5001'`)).rows[0];
    expect(o.customer_price).toBe('60.00');
    const ev = (await h.db.query(`SELECT status FROM integration_events WHERE external_event_id = 'evt_old'`)).rows[0];
    expect(ev.status).toBe('STALE');
  });

  it('runs to completion from marketplace events, including a partial refund', async () => {
    const { mgr, pa } = (globalThis as any).__t;
    const orderId = (await h.db.query(`SELECT id FROM orders WHERE marketplace_order_id = 'MP-5001'`)).rows[0].id;
    await submitBid(h.ctx, pa, orderId, { amount: '30', etaStartMin: 0, etaDurationMin: 40 });
    await closeBiddingNow(h.ctx, mgr, orderId);
    const review = await buildReview(h.db, (await getOrder(h.db, orderId))!, h.clock.now);
    const { assignmentId } = await assignBid(h.ctx, mgr, orderId, review.recommendation.recommended!.bidId);
    await confirmAssignment(h.ctx, pa, assignmentId);
    await startWork(h.ctx, pa, orderId);
    await post({ events: [event('evt_msg', 'CUSTOMER_MESSAGE', { message: 'I am online now' })] });
    await post({ events: [event('evt_done', 'ORDER_COMPLETED', { rating: 5 })] });
    await runner.drain();
    let o = (await getOrder(h.db, orderId))!;
    expect(o.status).toBe('COMPLETED');
    expect((await balances(h.db, (pa as any).providerId)).pending).toBe(3000);
    await post({ events: [event('evt_ref', 'REFUND', { refund: { amount: '10.00', reference: 'R-1', reason: 'partial' } })] });
    await post({ events: [event('evt_ref_dup', 'REFUND', { refund: { amount: '10.00', reference: 'R-1', reason: 'partial' } })] });
    await runner.drain();
    o = (await getOrder(h.db, orderId))!;
    expect(o.status).toBe('PARTIAL_REFUND');
    const refunds = (await h.db.query('SELECT count(*)::int AS n FROM refunds WHERE order_id = $1', [orderId])).rows[0].n;
    expect(refunds).toBe(1);
    const msg = (await h.db.query(`SELECT count(*)::int AS n FROM jobs WHERE kind = 'discord.customerMessage'`)).rows[0].n;
    expect(msg).toBe(1);
  });

  it('health reports the database', async () => {
    const r = await api.inject({ method: 'GET', url: '/health' });
    expect(r.json()).toMatchObject({ ok: true, db: true });
  });
});
