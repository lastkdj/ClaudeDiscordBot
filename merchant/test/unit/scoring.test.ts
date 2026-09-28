import { describe, expect, it } from 'vitest';
import { type BidInput, recommend, pickRestriction } from '../../src/core/scoring.js';

// ARCHITECTURE §13.4: TM-00018421, WoW Mythic+ +10, €60 price, €6 commission.
const order = { customerPrice: 6000, commission: 600, riskTier: 'MEDIUM' as const, minutesToDeadline: 240 };

const bid = (over: Partial<BidInput> & Pick<BidInput, 'bidId' | 'providerCode'>): BidInput => ({
  providerId: over.providerCode,
  amount: 0,
  etaMinutes: 60,
  level: 'BRONZE',
  globalReputation: 80,
  serviceReputation: 80,
  gameReputation: 80,
  serviceCompleted: 10,
  recentGood: 0,
  recentTotal: 0,
  onTimeRate: 0.9,
  recentAssignments: 0,
  completedOrders: 10,
  completionRate: 0.9,
  ...over,
});

const example = (): BidInput[] => [
  bid({ bidId: 'b184', providerCode: 'P-184', amount: 2900, etaMinutes: 45, level: 'DIAMOND', globalReputation: 96, serviceReputation: 97, serviceCompleted: 210, recentComposite: 0.97, onTimeRate: 0.98, completedOrders: 642, completionRate: 0.991 }),
  bid({ bidId: 'b291', providerCode: 'P-291', amount: 2600, etaMinutes: 60, level: 'BRONZE', globalReputation: 73, serviceReputation: 80, serviceCompleted: 8, recentComposite: 0.84, onTimeRate: 0.88, completedOrders: 18, completionRate: 0.91 }),
  bid({ bidId: 'b448', providerCode: 'P-448', amount: 3100, etaMinutes: 40, level: 'PLATINUM', globalReputation: 93, serviceReputation: 94, serviceCompleted: 95, recentComposite: 0.99, onTimeRate: 0.97, completedOrders: 391, completionRate: 0.987 }),
];

describe('Bid Selection Score (§13.4 worked example)', () => {
  it('reproduces the BOOSTING scores and recommends P-184', () => {
    const r = recommend(order, example(), { profile: 'BOOSTING', random: () => 0.99 });
    const score = Object.fromEntries(r.ranked.map((b) => [b.providerCode, b.score]));
    expect(score['P-184']).toBeCloseTo(92.9, 1);
    expect(score['P-448']).toBeCloseTo(89.8, 1);
    expect(score['P-291']).toBeCloseTo(71.2, 1);
    expect(r.recommended?.providerCode).toBe('P-184');
    expect(r.mode).toBe('SCORE');
    expect(r.recommended?.estProfit).toBe(2500);
    expect(r.net).toBe(5400);
    expect(r.maxBidAtFloor).toBe(4590);
    const c = r.ranked.find((b) => b.providerCode === 'P-184')!.components;
    expect(c).toEqual({ P: 0.804, R: 0.96, E: 0.97, T: 0.97, D: 0.924 });
    expect(r.explanation).toMatch(/P-184 over cheapest P-291/);
  });

  it('under CURRENCY weights price matters more and P-291 closes the gap', () => {
    const r = recommend(order, example(), { profile: 'CURRENCY', random: () => 0.99 });
    const score = Object.fromEntries(r.ranked.map((b) => [b.providerCode, b.score]));
    expect(score['P-184']).toBeCloseTo(88.8, 1);
    expect(score['P-448']).toBeCloseTo(83.8, 1);
    expect(Math.abs(score['P-291']! - 82.6)).toBeLessThanOrEqual(0.1);
  });

  it('a €23 bid from P-291 leads under CURRENCY but still trails under BOOSTING', () => {
    const bids = example();
    bids[1]!.amount = 2300;
    expect(recommend(order, bids, { profile: 'CURRENCY', random: () => 0.99 }).recommended?.providerCode).toBe('P-291');
    expect(recommend(order, bids, { profile: 'BOOSTING', random: () => 0.99 }).recommended?.providerCode).toBe('P-184');
  });
});

describe('hard gates', () => {
  it('flags bids below the margin floor and after the deadline; only managers may pick them', () => {
    const bids = example();
    bids[0]!.amount = 4700; // margin (5400-4700)/5400 = 13% < 15%
    bids[2]!.etaMinutes = 300; // deadline in 240 min
    const r = recommend(order, bids, { profile: 'BOOSTING', random: () => 0.99 });
    const f = Object.fromEntries(r.ranked.map((b) => [b.providerCode, b]));
    expect(f['P-184']!.flags).toContain('BELOW_MARGIN_FLOOR');
    expect(f['P-448']!.flags).toContain('MISSES_DEADLINE');
    expect(pickRestriction(f['P-184']!)).toBe('MANAGER');
    expect(r.recommended?.providerCode).toBe('P-291');
  });

  it('excludes providers below the level required for the risk tier', () => {
    const r = recommend({ ...order, riskTier: 'HIGH' }, example(), { profile: 'RAID', random: () => 0.99 });
    const p291 = r.ranked.find((b) => b.providerCode === 'P-291')!;
    expect(p291.ineligible).toMatch(/GOLD/);
    expect(p291.score).toBe(0);
    expect(pickRestriction(p291)).toBe('NOBODY');
    expect(r.ranked.at(-1)!.providerCode).toBe('P-291');
  });

  it('returns no recommendation when nothing passes', () => {
    const bids = example().map((b) => ({ ...b, amount: 5300 }));
    const r = recommend(order, bids, { profile: 'BOOSTING' });
    expect(r.recommended).toBeNull();
    expect(r.mode).toBe('NONE');
  });
});

describe('fairness (§17)', () => {
  it('rotation: near-ties go to the provider with fewer recent assignments', () => {
    const a = bid({ bidId: 'a', providerCode: 'P-1', amount: 2000, globalReputation: 90, recentAssignments: 9 });
    const b = bid({ bidId: 'b', providerCode: 'P-2', amount: 2010, globalReputation: 90, recentAssignments: 1 });
    const r = recommend({ ...order, riskTier: 'LOW' }, [a, b], { profile: 'DEFAULT', random: () => 0.99 });
    expect(r.ranked[0]!.providerCode).toBe('P-1');
    expect(r.recommended?.providerCode).toBe('P-2');
    expect(r.mode).toBe('ROTATION');
  });

  it('exploration: LOW risk only, newcomer within the window', () => {
    const vet = bid({ bidId: 'v', providerCode: 'P-VET', amount: 2300, globalReputation: 95, serviceCompleted: 300, serviceReputation: 95, recentComposite: 0.98, onTimeRate: 0.98 });
    const rookie = bid({ bidId: 'r', providerCode: 'P-NEW', amount: 2000, level: 'NEW', globalReputation: 82, serviceCompleted: 2, serviceReputation: null, gameReputation: null, onTimeRate: 0.85 });
    const low = recommend({ ...order, riskTier: 'LOW' }, [vet, rookie], { profile: 'DEFAULT', random: () => 0.01 });
    expect(low.mode).toBe('EXPLORATION');
    expect(low.recommended?.providerCode).toBe('P-NEW');
    const medium = recommend({ ...order, riskTier: 'MEDIUM' }, [vet, { ...rookie, level: 'BRONZE' }], { profile: 'DEFAULT', random: () => 0.01 });
    expect(medium.mode).toBe('SCORE');
    expect(medium.recommended?.providerCode).toBe('P-VET');
  });
});
