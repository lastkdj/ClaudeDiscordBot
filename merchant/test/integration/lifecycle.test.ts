// End-to-end on a real Postgres: onboarding -> import -> sealed bidding ->
// recommendation -> assignment -> fulfillment -> earning -> release -> payout -> refund.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor } from '../../src/core/types.js';
import { closeBiddingNow, declineInvitation, reopenBidding, submitBid, tickBidding } from '../../src/services/bidding.js';
import { markDelivered, markProviderFailed, recordCompletion, recordRefund, releaseEarning, startWork } from '../../src/services/fulfillment.js';
import { importManualOrder } from '../../src/services/intake.js';
import { adjustBalance, balances, balancesFromLedger, decidePayout, reconcileBalances, requestPayout } from '../../src/services/ledger.js';
import { findOrder, getOrder } from '../../src/services/orders.js';
import { acceptProviderRules, revealPayoutDetails, reviewApplication, setAvailability, setLevelManually, setPayoutDetails, submitApplication } from '../../src/services/providers.js';
import { recomputeProvider } from '../../src/services/reputation.js';
import { assignBid, buildReview, confirmAssignment, releaseAssignment } from '../../src/services/selection.js';
import { bootstrapOwner, desiredRoleNames } from '../../src/services/users.js';
import { financialReport } from '../../src/services/reports.js';
import { actorOf, dbAvailable, discordUser, gameId, type Harness, jobs, makeStaff, serviceId, setupHarness } from './harness.js';

const available = await dbAvailable();

describe.skipIf(!available)('order lifecycle (integration)', () => {
  let h: Harness;
  let exec: Actor, manager: Actor, staff: Actor, otherStaff: Actor;
  let wow: string, mplus: string, dungeon: string;
  const providers: { du: ReturnType<typeof discordUser>; actor: Actor; code: string }[] = [];

  beforeAll(async () => {
    h = await setupHarness();
    wow = await gameId(h.db, 'wow');
    mplus = await serviceId(h.db, 'wow', 'mythic-plus', 'key-timed');
    dungeon = await serviceId(h.db, 'wow', 'dungeons', 'dungeon-run');
    const owner = discordUser('owner');
    await bootstrapOwner(h.ctx, owner);
    exec = await actorOf(h.db, owner);
    manager = await makeStaff(h, exec, discordUser('manager'), 'MANAGER', [wow]);
    staff = await makeStaff(h, exec, discordUser('staff'), 'STAFF', [wow]);
    otherStaff = await makeStaff(h, exec, discordUser('albion-staff'), 'STAFF', [await gameId(h.db, 'albion')]);

    for (const name of ['alice', 'bob', 'cara']) {
      const du = discordUser(name);
      await acceptProviderRules(h.ctx, du);
      const appId = await submitApplication(h.ctx, du, { displayName: name, timezone: 'Europe/Madrid', experience: 'years of M+', capabilities: [{ gameId: wow, serviceId: mplus }, { gameId: wow, serviceId: dungeon }] });
      const r = await reviewApplication(h.ctx, manager, appId, wow, 'APPROVE');
      expect(r.firstApproval).toBe(true);
      const actor = await actorOf(h.db, du);
      await setAvailability(h.ctx, actor, 'AVAILABLE');
      const code = (await h.db.query('SELECT code FROM providers WHERE id = $1', [(actor as any).providerId])).rows[0].code;
      providers.push({ du, actor, code });
    }
    // MEDIUM risk needs BRONZE (§13.1).
    for (const p of providers) await setLevelManually(h.ctx, exec, (p.actor as any).providerId, 'SILVER', 'seed for test');
  });
  afterAll(async () => h?.close());

  it('onboarding gives provider roles and codes; staff cannot review applications', async () => {
    expect(providers.map((p) => p.code)).toEqual(['P-100', 'P-101', 'P-102']);
    const roles = await desiredRoleNames(h.db, (providers[0]!.actor as any).userId);
    expect(roles.roles.sort()).toEqual(['Provider', 'WoW Provider']);
    const du = discordUser('dave');
    await acceptProviderRules(h.ctx, du);
    const app = await submitApplication(h.ctx, du, { displayName: 'dave', timezone: 'UTC', experience: 'x', capabilities: [{ gameId: wow, serviceId: dungeon }] });
    await expect(reviewApplication(h.ctx, staff, app, wow, 'APPROVE')).rejects.toThrow(/managers and executives/);
    await expect(reviewApplication(h.ctx, otherStaff, app, wow, 'APPROVE')).rejects.toThrow();
  });

  it('rejects applicants whose Discord account is too new', async () => {
    await expect(acceptProviderRules(h.ctx, { ...discordUser('fresh'), createdAt: new Date() })).rejects.toThrow(/days old/);
  });

  it('runs an order from import to released earning and payout', async () => {
    const { order } = await importManualOrder(h.ctx, staff, {
      marketplaceOrderId: '928173', serviceId: mplus, price: '60.00', commission: '6.00', paid: true,
      configuration: { region: 'EU', realm: 'Silvermoon / Alliance', character: 'Aria (Mage)' },
      deadlineAt: new Date(h.clock.now.getTime() + 6 * 3600_000),
    });
    expect(order.status).toBe('BIDDING');
    expect(order.internal_order_id).toMatch(/^TM-\d{8}$/);
    expect((await jobs(h.db, 'discord.bidInvite')).length).toBe(3);

    // Staff from another game can't see it; the same marketplace order can't be imported twice.
    await expect(importManualOrder(h.ctx, otherStaff, { marketplaceOrderId: 'x1', serviceId: mplus, price: '10', paid: true, configuration: {} })).rejects.toThrow(/not one of your games/);
    const again = await importManualOrder(h.ctx, staff, { marketplaceOrderId: '928173', serviceId: mplus, price: '60.00', paid: true, configuration: {} });
    expect(again.created).toBe(false);

    const [a, b, c] = providers;
    await submitBid(h.ctx, a!.actor, order.id, { amount: '35', etaStartMin: 5, etaDurationMin: 40 });
    const replaced = await submitBid(h.ctx, a!.actor, order.id, { amount: '29', etaStartMin: 5, etaDurationMin: 40 });
    expect(replaced.replaced).toBe(true);
    await submitBid(h.ctx, b!.actor, order.id, { amount: '26', etaStartMin: 10, etaDurationMin: 50 });
    await submitBid(h.ctx, c!.actor, order.id, { amount: '31', etaStartMin: 0, etaDurationMin: 40 });
    await expect(submitBid(h.ctx, staff, order.id, { amount: '1', etaStartMin: 0, etaDurationMin: 1 })).rejects.toThrow(/only providers/);
    const activeCount = (await h.db.query(`SELECT count(*)::int AS n FROM provider_bids WHERE order_id = $1 AND status = 'ACTIVE'`, [order.id])).rows[0].n;
    expect(activeCount).toBe(3);

    await closeBiddingNow(h.ctx, staff, order.id);
    const inReview = (await getOrder(h.db, order.id))!;
    expect(inReview.status).toBe('BID_REVIEW');
    await expect(submitBid(h.ctx, a!.actor, order.id, { amount: '20', etaStartMin: 0, etaDurationMin: 30 })).rejects.toThrow(/closed/);

    const review = await buildReview(h.db, inReview, h.clock.now);
    expect(review.recommendation.ranked).toHaveLength(3);
    const rec = review.recommendation.recommended!;
    expect(rec).toBeTruthy();

    // Choosing someone else needs a reason.
    const other = review.recommendation.ranked.find((r) => r.bidId !== rec.bidId)!;
    await expect(assignBid(h.ctx, staff, order.id, other.bidId)).rejects.toThrow(/reason/);
    const { assignmentId, overridden } = await assignBid(h.ctx, staff, order.id, rec.bidId);
    expect(overridden).toBe(false);
    const winner = providers.find((p) => p.code === rec.providerCode)!;
    const loser = providers.find((p) => p.code !== rec.providerCode)!;
    await expect(confirmAssignment(h.ctx, loser.actor, assignmentId)).rejects.toThrow(/selected provider/);
    const confirmed = await confirmAssignment(h.ctx, winner.actor, assignmentId);
    expect(confirmed.status).toBe('PROVIDER_CONFIRMED');
    expect(confirmed.provider_cost).toBe((rec.amount / 100).toFixed(2));
    expect((await jobs(h.db, 'discord.orderRoom')).length).toBe(1);

    await expect(startWork(h.ctx, loser.actor, order.id)).rejects.toThrow(/not your order/);
    await startWork(h.ctx, winner.actor, order.id);
    await markDelivered(h.ctx, winner.actor, order.id, 'Key timed, screenshot attached');
    const completed = await recordCompletion(h.ctx, staff, order.id, { rating: 5 });
    expect(completed.status).toBe('COMPLETED');
    expect(completed.snapshot.profit).toBe(6000 - 600 - rec.amount);
    const pid = (winner.actor as any).providerId;
    expect(await balances(h.db, pid)).toMatchObject({ pending: rec.amount, available: 0, lifetime: rec.amount });
    // Completing twice is a no-op (no double earning).
    await recordCompletion(h.ctx, staff, order.id);
    expect((await balances(h.db, pid)).pending).toBe(rec.amount);

    expect(await releaseEarning(h.ctx, order.id)).toBe('released');
    expect((await getOrder(h.db, order.id))!.status).toBe('EARNING_RELEASED');
    expect(await balances(h.db, pid)).toMatchObject({ pending: 0, available: rec.amount });

    // Payout: details are encrypted at rest; only executives can reveal them (audited).
    await expect(requestPayout(h.ctx, winner.actor, pid, '10', 'IBAN')).rejects.toThrow(/payout details/);
    await setPayoutDetails(h.ctx, winner.actor, 'IBAN ES00 1234 5678');
    const raw = (await h.db.query('SELECT payout_details_enc FROM providers WHERE id = $1', [pid])).rows[0].payout_details_enc as Buffer;
    expect(raw.toString('utf8')).not.toContain('ES00');
    await expect(revealPayoutDetails(h.ctx, manager, pid, 'x')).rejects.toThrow();
    expect(await revealPayoutDetails(h.ctx, exec, pid, 'paying out')).toBe('IBAN ES00 1234 5678');
    await expect(requestPayout(h.ctx, winner.actor, pid, '9999', 'IBAN')).rejects.toThrow(/available/);
    await expect(requestPayout(h.ctx, loser.actor, pid, '10', 'IBAN')).rejects.toThrow();
    const payoutId = await requestPayout(h.ctx, winner.actor, pid, '20', 'IBAN');
    expect(await balances(h.db, pid)).toMatchObject({ available: rec.amount - 2000, reserved: 2000 });
    await expect(decidePayout(h.ctx, manager, payoutId, 'APPROVE')).rejects.toThrow(/executives only/);
    await decidePayout(h.ctx, exec, payoutId, 'APPROVE');
    await decidePayout(h.ctx, exec, payoutId, 'PAID', 'SEPA-42');
    expect(await balances(h.db, pid)).toMatchObject({ reserved: 0, paid: 2000 });

    // Late refund, provider liable: reversal comes out of AVAILABLE and can go negative.
    await expect(recordRefund(h.ctx, staff, order.id, { amount: '60', liability: 'PROVIDER', reason: 'not delivered' })).rejects.toThrow(/managers/);
    const refunded = await recordRefund(h.ctx, manager, order.id, { amount: '60', liability: 'PROVIDER', reason: 'customer chargeback' });
    expect(refunded.status).toBe('REFUNDED');
    const bal = await balances(h.db, pid);
    expect(bal.available).toBe(rec.amount - 2000 - rec.amount);
    expect(bal.lifetime).toBe(0);
    expect(await balancesFromLedger(h.db, pid)).toEqual(bal);
    expect((await reconcileBalances(h.ctx)).mismatches).toEqual([]);

    // Bonus from an executive.
    await adjustBalance(h.ctx, exec, pid, 'BONUS', '5', 'great week');
    expect((await balances(h.db, pid)).lifetime).toBe(500);

    const report = await financialReport(h.db, { from: new Date(h.clock.now.getTime() - 86400_000), to: new Date(h.clock.now.getTime() + 86400_000) });
    expect(report.orders).toBe(1);
    expect(report.gross).toBe(6000);
    expect(report.refunds).toBe(6000);
    expect(report.profit).toBe(6000 - 600 - rec.amount - 6000);
  });

  it('ledger and audit log are append-only in the database', async () => {
    await expect(h.db.query(`UPDATE provider_ledger_entries SET amount = 1`)).rejects.toThrow(/append-only/);
    await expect(h.db.query(`DELETE FROM audit_logs`)).rejects.toThrow(/append-only/);
  });

  it('confirmation timeout and failure lead to reassignment with the next bid', async () => {
    const { order } = await importManualOrder(h.ctx, staff, { marketplaceOrderId: 'T-1', serviceId: mplus, price: '50', commission: '5', paid: true, configuration: { region: 'EU', realm: 'x', character: 'y' } });
    for (const [i, p] of providers.entries()) await submitBid(h.ctx, p.actor, order.id, { amount: String(20 + i), etaStartMin: 0, etaDurationMin: 30 });
    await closeBiddingNow(h.ctx, staff, order.id);
    const review = await buildReview(h.db, (await getOrder(h.db, order.id))!, h.clock.now);
    const { assignmentId } = await assignBid(h.ctx, manager, order.id, review.recommendation.recommended!.bidId);
    expect(await releaseAssignment(h.ctx, { kind: 'SYSTEM' }, assignmentId, 'EXPIRED')).toBe('not-yet');
    h.clock.advance(20 * 60_000);
    expect(await releaseAssignment(h.ctx, { kind: 'SYSTEM' }, assignmentId, 'EXPIRED')).toBe('BID_REVIEW');
    const review2 = await buildReview(h.db, (await getOrder(h.db, order.id))!, h.clock.now);
    expect(review2.recommendation.ranked).toHaveLength(2);
    const second = await assignBid(h.ctx, manager, order.id, review2.recommendation.recommended!.bidId);
    const p2 = providers.find((p) => p.code === review2.recommendation.recommended!.providerCode)!;
    await confirmAssignment(h.ctx, p2.actor, second.assignmentId);
    await startWork(h.ctx, p2.actor, order.id);
    const afterFail = await markProviderFailed(h.ctx, staff, order.id, 'went offline');
    // The other bids were closed when the provider confirmed, so staff reopen bidding.
    expect(afterFail.status).toBe('REASSIGNMENT_REQUIRED');
    expect(afterFail.assigned_provider_id).toBeNull();
    expect(afterFail.provider_cost).toBeNull();
    expect(await reopenBidding(h.ctx, staff, order.id)).toBeGreaterThan(0);
    expect((await getOrder(h.db, order.id))!.bid_round).toBe(2);
    await recomputeProvider(h.ctx, (p2.actor as any).providerId);
    const rep = (await h.db.query('SELECT global, counts FROM provider_reputation WHERE provider_id = $1', [(p2.actor as any).providerId])).rows[0];
    expect(rep.counts.failed).toBe(1);
  });

  it('two staff assigning at once: exactly one wins', async () => {
    const { order } = await importManualOrder(h.ctx, staff, { marketplaceOrderId: 'RACE-1', serviceId: mplus, price: '50', commission: '5', paid: true, configuration: { region: 'EU', realm: 'x', character: 'y' } });
    for (const p of providers) await submitBid(h.ctx, p.actor, order.id, { amount: '20', etaStartMin: 0, etaDurationMin: 30 });
    await closeBiddingNow(h.ctx, staff, order.id);
    const review = await buildReview(h.db, (await getOrder(h.db, order.id))!, h.clock.now);
    const bid = review.recommendation.recommended!.bidId;
    const results = await Promise.allSettled([assignBid(h.ctx, staff, order.id, bid), assignBid(h.ctx, manager, order.id, bid)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const live = (await h.db.query(`SELECT count(*)::int AS n FROM order_assignments WHERE order_id = $1 AND status = 'PENDING_CONFIRM'`, [order.id])).rows[0].n;
    expect(live).toBe(1);
  });

  it('bid window with no bids: extends once, then needs reassignment', async () => {
    const { order } = await importManualOrder(h.ctx, staff, { marketplaceOrderId: 'EMPTY-1', serviceId: dungeon, price: '15', paid: true, configuration: { region: 'EU', realm: 'x', character: 'y' } });
    expect(order.status).toBe('BIDDING');
    for (const p of providers) await declineInvitation(h.ctx, p.actor, order.id);
    h.clock.advance(order.bid_window_seconds! * 1000 + 1000);
    expect(await tickBidding(h.ctx, order.id, order.bid_round)).toBe('extended');
    h.clock.advance(order.bid_window_seconds! * 1000 + 1000);
    expect(await tickBidding(h.ctx, order.id, order.bid_round)).toBe('no-bids');
    expect((await findOrder(h.db, order.internal_order_id))!.status).toBe('REASSIGNMENT_REQUIRED');
    const declines = (await h.db.query(`SELECT count(*)::int AS n FROM bid_invitations WHERE order_id = $1 AND response = 'DECLINED'`, [order.id])).rows[0].n;
    expect(declines).toBe(3);
  });

  it('orders with missing details go to manual review', async () => {
    const { order } = await importManualOrder(h.ctx, staff, { marketplaceOrderId: 'MR-1', serviceId: mplus, price: '40', paid: true, configuration: { region: 'EU' } });
    expect(order.status).toBe('MANUAL_REVIEW');
    expect((await jobs(h.db, 'discord.alert')).some((j) => j.payload.text.includes('needs review'))).toBe(true);
  });
});
