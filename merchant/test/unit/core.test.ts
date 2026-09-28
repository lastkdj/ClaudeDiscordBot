import { describe, expect, it } from 'vitest';
import { applyRate, formatMoney, parseMoney, toDecimalString } from '../../src/core/money.js';
import { ORDER_STATUSES, type OrderStatus, assertTransition, canTransition, statusTag } from '../../src/core/order-state.js';
import { type Actor, SYSTEM } from '../../src/core/types.js';
import { computeReputation, type OrderOutcome } from '../../src/core/reputation.js';
import { evaluateLevel, type LevelInputs } from '../../src/core/levels.js';
import * as L from '../../src/core/ledger.js';
import { commissionFor, pickFeeRule, profit } from '../../src/core/accounting.js';
import { ineligibilityReason, type ProviderSnapshot, windowOutcome } from '../../src/core/eligibility.js';

const user = (orgRole: Actor extends infer A ? (A extends { kind: 'USER'; orgRole: infer R } ? R : never) : never, over: Record<string, unknown> = {}): Actor => ({
  kind: 'USER', userId: 'u1', orgRole, status: 'ACTIVE', staffGameIds: ['wow'], managerGameIds: orgRole === 'MANAGER' ? ['wow'] : [], providerId: orgRole === 'PROVIDER' ? 'p1' : null, ...over,
}) as Actor;

describe('money', () => {
  it('parses and formats without floats', () => {
    expect(parseMoney('29')).toBe(2900);
    expect(parseMoney('29.5')).toBe(2950);
    expect(parseMoney('€1,234.56')).toBe(123456);
    expect(parseMoney('29,50')).toBe(2950);
    expect(parseMoney('-3.10')).toBe(-310);
    expect(() => parseMoney('2.999')).toThrow();
    expect(() => parseMoney('abc')).toThrow();
    expect(toDecimalString(-5)).toBe('-0.05');
    expect(formatMoney(123456)).toBe('€1,234.56');
    expect(formatMoney(-2900, 'EUR')).toBe('-€29.00');
  });

  it('applies rates with half-even rounding', () => {
    expect(applyRate(6000, 0.1)).toBe(600);
    expect(applyRate(25, 0.5)).toBe(12); // 12.5 -> 12 (even)
    expect(applyRate(35, 0.5)).toBe(18); // 17.5 -> 18 (even)
    expect(applyRate(1999, 0.075)).toBe(150); // 149.925 -> 150
  });
});

describe('order state machine (§10)', () => {
  const staff = user('STAFF');
  const provider = user('PROVIDER');
  it('allows the happy path', () => {
    const path: OrderStatus[] = ['RECEIVED', 'VALIDATED', 'PROCUREMENT', 'BIDDING', 'BID_REVIEW', 'PROVIDER_SELECTED'];
    for (let i = 1; i < path.length; i++) assertTransition({ from: path[i - 1]!, to: path[i]!, actor: SYSTEM });
    assertTransition({ from: 'PROVIDER_SELECTED', to: 'PROVIDER_CONFIRMED', actor: provider });
    assertTransition({ from: 'PROVIDER_CONFIRMED', to: 'IN_PROGRESS', actor: provider });
    assertTransition({ from: 'IN_PROGRESS', to: 'DELIVERED', actor: staff });
    assertTransition({ from: 'DELIVERED', to: 'MARKETPLACE_COMPLETION', actor: { kind: 'MARKETPLACE', source: 'm' } });
    assertTransition({ from: 'MARKETPLACE_COMPLETION', to: 'COMPLETED', actor: SYSTEM });
    assertTransition({ from: 'COMPLETED', to: 'EARNING_RELEASED', actor: SYSTEM });
  });

  it('rejects skipped steps, wrong actors, and missing reasons', () => {
    expect(canTransition({ from: 'RECEIVED', to: 'BIDDING', actor: SYSTEM })).toBe(false);
    expect(canTransition({ from: 'BID_REVIEW', to: 'PROVIDER_SELECTED', actor: provider })).toBe(false);
    expect(canTransition({ from: 'PROVIDER_SELECTED', to: 'PROVIDER_CONFIRMED', actor: staff })).toBe(false);
    expect(() => assertTransition({ from: 'BIDDING', to: 'CANCELLED', actor: user('MANAGER') })).toThrow(/reason/);
    expect(canTransition({ from: 'BIDDING', to: 'CANCELLED', actor: user('MANAGER'), reason: 'customer asked' })).toBe(true);
    expect(canTransition({ from: 'BIDDING', to: 'CANCELLED', actor: staff, reason: 'customer asked' })).toBe(false);
    expect(() => assertTransition({ from: 'BIDDING', to: 'BIDDING', actor: SYSTEM })).toThrow(/already/);
    expect(() => assertTransition({ from: 'BIDDING', to: 'BID_REVIEW', actor: user('CUSTOMER') })).toThrow();
  });

  it('terminal states only allow late refunds', () => {
    for (const to of ORDER_STATUSES) {
      if (to === 'CANCELLED') continue;
      expect(canTransition({ from: 'CANCELLED', to, actor: SYSTEM, reason: 'x x x' })).toBe(false);
    }
    expect(canTransition({ from: 'EARNING_RELEASED', to: 'PARTIAL_REFUND', actor: SYSTEM, reason: 'late refund' })).toBe(true);
    expect(canTransition({ from: 'EARNING_RELEASED', to: 'CANCELLED', actor: SYSTEM, reason: 'nope' })).toBe(false);
  });

  it('manual review returns only to the previous status or VALIDATED', () => {
    expect(canTransition({ from: 'BIDDING', to: 'MANUAL_REVIEW', actor: staff, reason: 'odd price' })).toBe(true);
    expect(canTransition({ from: 'MANUAL_REVIEW', to: 'BIDDING', actor: staff, previousStatus: 'BIDDING' })).toBe(true);
    expect(canTransition({ from: 'MANUAL_REVIEW', to: 'VALIDATED', actor: staff, previousStatus: 'BIDDING' })).toBe(true);
    expect(canTransition({ from: 'MANUAL_REVIEW', to: 'IN_PROGRESS', actor: staff, previousStatus: 'BIDDING' })).toBe(false);
  });

  it('failure leads to reassignment; disputes resolve', () => {
    expect(canTransition({ from: 'IN_PROGRESS', to: 'PROVIDER_FAILED', actor: staff, reason: 'no show' })).toBe(true);
    expect(canTransition({ from: 'PROVIDER_FAILED', to: 'REASSIGNMENT_REQUIRED', actor: SYSTEM })).toBe(true);
    expect(canTransition({ from: 'REASSIGNMENT_REQUIRED', to: 'BIDDING', actor: staff })).toBe(true);
    expect(canTransition({ from: 'COMPLETED', to: 'DISPUTED', actor: SYSTEM, reason: 'chargeback' })).toBe(true);
    expect(canTransition({ from: 'DISPUTED', to: 'COMPLETED', actor: user('MANAGER') })).toBe(true);
  });

  it('maps statuses to forum tags', () => {
    expect(statusTag('BID_REVIEW')).toBe('Bidding');
    expect(statusTag('MARKETPLACE_COMPLETION')).toBe('Delivered');
    expect(statusTag('DISPUTED')).toBe('Problem');
  });
});

describe('reputation (§15)', () => {
  const ok = (ageDays = 0): OrderOutcome => ({ ageDays, completed: true, providerFailed: false, cancelledNotProviderFault: false, onTime: true, disputed: false, rating: 5 });
  it('starts at the priors and is smoothed', () => {
    expect(computeReputation([]).reputation).toBeCloseTo(87.3, 1);
    const three = computeReputation([ok(), ok(), ok()]).reputation;
    const many = computeReputation(Array.from({ length: 600 }, (_, i) => (i % 100 === 0 ? { ...ok(), onTime: false } : ok()))).reputation;
    expect(many).toBeGreaterThan(three);
  });
  it('ignores customer cancellations and punishes failures; old events weigh less', () => {
    const base = Array.from({ length: 20 }, () => ok());
    const cancel = { ...ok(), completed: false, cancelledNotProviderFault: true };
    expect(computeReputation([...base, cancel]).reputation).toBe(computeReputation(base).reputation);
    const fail = { ...ok(), completed: false, providerFailed: true, onTime: null, rating: null };
    expect(computeReputation([...base, fail]).reputation).toBeLessThan(computeReputation(base).reputation);
    const oldFail = { ...fail, ageDays: 720 };
    expect(computeReputation([...base, oldFail]).reputation).toBeGreaterThan(computeReputation([...base, fail]).reputation);
  });
});

describe('levels (§14)', () => {
  const x = (over: Partial<LevelInputs>): LevelInputs => ({ current: 'NEW', completed: 0, tenureDays: 0, reputation: 82, disputeRate: 0, onTimeRate: 1, activeLast30: true, openSeriousFlags: 0, daysBelowThreshold: 0, eliteConfirmed: false, ...over });
  it('promotes when every criterion is met', () => {
    expect(evaluateLevel(x({ completed: 5, tenureDays: 7, reputation: 75 })).level).toBe('BRONZE');
    expect(evaluateLevel(x({ completed: 120, tenureDays: 100, reputation: 88, onTimeRate: 0.85 })).level).toBe('SILVER');
    expect(evaluateLevel(x({ completed: 120, tenureDays: 100, reputation: 88, onTimeRate: 0.95 })).level).toBe('GOLD');
  });
  it('needs an executive for ELITE', () => {
    const d = evaluateLevel(x({ current: 'DIAMOND', completed: 1200, tenureDays: 400, reputation: 97 }));
    expect(d.level).toBe('DIAMOND');
    expect(d.eliteCandidate).toBe(true);
    expect(evaluateLevel(x({ current: 'DIAMOND', completed: 1200, tenureDays: 400, reputation: 97, eliteConfirmed: true })).level).toBe('ELITE');
  });
  it('demotes only after 30 days below the line, or on serious flags', () => {
    expect(evaluateLevel(x({ current: 'GOLD', completed: 100, tenureDays: 90, reputation: 79, daysBelowThreshold: 29 })).change).toBe('NONE');
    expect(evaluateLevel(x({ current: 'GOLD', completed: 100, tenureDays: 90, reputation: 79, daysBelowThreshold: 30 })).level).toBe('SILVER');
    expect(evaluateLevel(x({ current: 'SILVER', completed: 30, tenureDays: 40, reputation: 90, openSeriousFlags: 1 })).level).toBe('BRONZE');
  });
});

describe('ledger (§19)', () => {
  it('keeps bucket invariants through the full cycle', () => {
    let b = L.ZERO_BALANCES;
    b = L.applyEntries(b, L.earningEntries('o1', 2900, 'TM-1'));
    expect(b).toMatchObject({ pending: 2900, available: 0, lifetime: 2900 });
    b = L.applyEntries(b, L.releaseEntries('o1', 2900, 'TM-1'));
    expect(b).toMatchObject({ pending: 0, available: 2900 });
    b = L.applyEntries(b, L.payoutRequestEntries('pay1', 2000, b));
    expect(b).toMatchObject({ available: 900, reserved: 2000 });
    b = L.applyEntries(b, L.payoutPaidEntries('pay1', 2000));
    expect(b).toMatchObject({ available: 900, reserved: 0, paid: 2000, lifetime: 2900 });
    b = L.applyEntries(b, L.refundReversalEntries('o1', 1500, true, 'TM-1'));
    expect(b).toMatchObject({ available: -600, lifetime: 1400 });
    // Invariant: all buckets together = lifetime + adjustments (none here).
    expect(b.pending + b.available + b.reserved + b.paid).toBe(b.lifetime);
  });
  it('rejects overdrawn payouts and zero or unexplained adjustments', () => {
    expect(() => L.payoutRequestEntries('p', 100, L.ZERO_BALANCES)).toThrow(/available/);
    expect(() => L.adjustmentEntries('ADJUSTMENT', 0, 'x x x')).toThrow();
    expect(() => L.adjustmentEntries('ADJUSTMENT', 100, '')).toThrow(/memo/);
    expect(() => L.adjustmentEntries('BONUS', -100, 'oops')).toThrow();
  });
});

describe('accounting (§18)', () => {
  it('computes profit and commission', () => {
    expect(profit({ customerPrice: 6000, marketplaceCommission: 600, providerCost: 2900, refunds: [], otherCosts: [] })).toBe(2500);
    expect(profit({ customerPrice: 6000, marketplaceCommission: 600, providerCost: 2900, refunds: [1000], otherCosts: [200] })).toBe(1300);
    const rules = [
      { marketplace: 'm', gameId: null, serviceId: null, rate: 0.1, validFrom: new Date('2026-01-01'), validTo: null },
      { marketplace: 'm', gameId: 'wow', serviceId: null, rate: 0.08, validFrom: new Date('2026-01-01'), validTo: null },
    ];
    const r = pickFeeRule(rules, 'm', 'wow', 'mplus', new Date('2026-09-01'));
    expect(r?.rate).toBe(0.08);
    expect(commissionFor(6000, null, r)).toEqual({ amount: 480, estimate: true });
    expect(commissionFor(6000, 555, r)).toEqual({ amount: 555, estimate: false });
  });
});

describe('eligibility and bid windows (§11)', () => {
  const p = (over: Partial<ProviderSnapshot> = {}): ProviderSnapshot => ({ status: 'ACTIVE', level: 'SILVER', availability: 'AVAILABLE', maxConcurrent: null, activeOrders: 0, completedOrders: 40, hasApprovedCapability: true, suspendedForGame: false, conflict: false, ...over });
  const o = { riskTier: 'MEDIUM' as const, trialEligible: false };
  it('applies every rule', () => {
    expect(ineligibilityReason(p(), o)).toBeNull();
    expect(ineligibilityReason(p({ status: 'SUSPENDED' }), o)).toMatch(/suspended/);
    expect(ineligibilityReason(p({ hasApprovedCapability: false }), o)).toMatch(/capability/);
    expect(ineligibilityReason(p({ activeOrders: 3 }), o)).toMatch(/capacity/);
    expect(ineligibilityReason(p({ availability: 'OFFLINE' }), o)).toMatch(/offline/);
    expect(ineligibilityReason(p({ level: 'NEW', completedOrders: 2 }), o)).toMatch(/below/);
    expect(ineligibilityReason(p({ level: 'NEW', completedOrders: 2 }), { riskTier: 'LOW', trialEligible: false })).toMatch(/probation/);
    expect(ineligibilityReason(p({ level: 'NEW', completedOrders: 2 }), { riskTier: 'LOW', trialEligible: true })).toBeNull();
    expect(ineligibilityReason(p({ level: 'NEW', completedOrders: 2, activeOrders: 1 }), { riskTier: 'LOW', trialEligible: true })).toMatch(/capacity/);
  });
  it('closes, extends once, then gives up', () => {
    const openedAt = new Date('2026-09-28T10:00:00Z');
    const w = { openedAt, windowSeconds: 600, extended: false, activeBids: 0, closeAtBids: 5 };
    expect(windowOutcome(w, new Date('2026-09-28T10:05:00Z'))).toBe('OPEN');
    expect(windowOutcome({ ...w, activeBids: 5 }, new Date('2026-09-28T10:05:00Z'))).toBe('CLOSE');
    expect(windowOutcome(w, new Date('2026-09-28T10:10:00Z'))).toBe('EXTEND');
    expect(windowOutcome({ ...w, extended: true }, new Date('2026-09-28T10:15:00Z'))).toBe('OPEN');
    expect(windowOutcome({ ...w, extended: true }, new Date('2026-09-28T10:20:00Z'))).toBe('NO_BIDS');
    expect(windowOutcome({ ...w, activeBids: 2 }, new Date('2026-09-28T10:10:00Z'))).toBe('CLOSE');
  });
});
