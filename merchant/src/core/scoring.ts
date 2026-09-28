// Bid Selection Score (ARCHITECTURE §13) and fairness rules (§17).
// Pure: callers pass every input, and the full breakdown is returned so the
// recommendation can be stored, explained and replayed.

import { type Cents } from './money.js';
import { type Level, levelRank, type RiskTier, type ScoringProfile } from './types.js';

export interface Weights {
  P: number;
  R: number;
  E: number;
  T: number;
  D: number;
}

export interface ScoringParams {
  /** Price sensitivity k in P = (b_min / b)^k. */
  k: number;
  /** Reference volume N_ref for the expertise term. */
  nRef: number;
  /** Minimum margin (net - bid) / net. */
  minMargin: number;
  /** Near-tie window δ for rotation. */
  tieDelta: number;
  /** Exploration probability ε on LOW-risk orders. */
  epsilon: number;
  /** Exploration candidates must score within this many points of the top. */
  explorationWindow: number;
  /** "Newcomer" threshold for exploration: fewer than this many completed orders in the service. */
  explorationMaxCompleted: number;
  /** Bayesian smoothing for the recent composite T. */
  recentM: number;
  recentPrior: number;
}

export const DEFAULT_PARAMS: ScoringParams = {
  k: 2,
  nRef: 100,
  minMargin: 0.15,
  tieDelta: 2.0,
  epsilon: 0.1,
  explorationWindow: 15,
  explorationMaxCompleted: 10,
  recentM: 5,
  recentPrior: 0.85,
};

export const DEFAULT_WEIGHTS: Record<ScoringProfile, Weights> = {
  CURRENCY: { P: 0.45, R: 0.25, E: 0.1, T: 0.1, D: 0.1 },
  BOOSTING: { P: 0.2, R: 0.3, E: 0.25, T: 0.15, D: 0.1 },
  RAID: { P: 0.15, R: 0.35, E: 0.25, T: 0.15, D: 0.1 },
  DEFAULT: { P: 0.3, R: 0.25, E: 0.2, T: 0.15, D: 0.1 },
};

/** Minimum level per risk tier (§13.1). */
export const RISK_MIN_LEVEL: Record<RiskTier, Level> = { LOW: 'NEW', MEDIUM: 'BRONZE', HIGH: 'GOLD' };

export interface BidInput {
  bidId: string;
  providerId: string;
  providerCode: string;
  amount: Cents;
  /** Minutes until start + expected duration. */
  etaMinutes: number;
  level: Level;
  /** Global reputation 0-100 (§15). */
  globalReputation: number;
  /** Reputation 0-100 for this service; null if fewer than 5 orders (caller falls back). */
  serviceReputation: number | null;
  gameReputation: number | null;
  /** Completed orders of this exact service. */
  serviceCompleted: number;
  /** Last 30 days: good outcomes (completed on time) and total finished orders. */
  recentGood: number;
  recentTotal: number;
  /** Precomputed recent composite in [0, 1]; overrides recentGood/recentTotal when set. */
  recentComposite?: number;
  onTimeRate: number;
  /** Assignments in the last 7 days, for rotation. */
  recentAssignments: number;
  /** Lifetime completed orders, shown in the review table. */
  completedOrders: number;
  completionRate: number;
}

export interface OrderInput {
  customerPrice: Cents;
  commission: Cents;
  riskTier: RiskTier;
  /** Minutes from now until the deadline, or null. */
  minutesToDeadline: number | null;
}

export type Flag = 'BELOW_MARGIN_FLOOR' | 'MISSES_DEADLINE';

export interface ScoredBid {
  bidId: string;
  providerId: string;
  providerCode: string;
  amount: Cents;
  etaMinutes: number;
  level: Level;
  /** Fails the hard risk gate: never recommended, cannot be picked. */
  ineligible: string | null;
  /** Soft gates: shown, but only a manager can pick the bid. */
  flags: Flag[];
  components: Weights;
  score: number;
  estProfit: Cents;
  margin: number;
}

export interface Recommendation {
  profile: ScoringProfile;
  weights: Weights;
  params: ScoringParams;
  net: Cents;
  maxBidAtFloor: Cents;
  ranked: ScoredBid[];
  recommended: ScoredBid | null;
  mode: 'SCORE' | 'ROTATION' | 'EXPLORATION' | 'NONE';
  explanation: string;
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const round1 = (x: number) => Math.round(x * 10) / 10;
const round3 = (x: number) => Math.round(x * 1000) / 1000;

export function expertise(serviceCompleted: number, specificReputation: number, nRef: number): number {
  const volume = Math.min(1, Math.log(1 + serviceCompleted) / Math.log(1 + nRef));
  return volume * (specificReputation / 100);
}

export function recentComposite(good: number, total: number, m: number, prior: number): number {
  return (good + m * prior) / (total + m);
}

export function marginOf(net: Cents, bid: Cents): number {
  return net > 0 ? (net - bid) / net : -Infinity;
}

export interface RecommendOptions {
  profile: ScoringProfile;
  weights?: Weights;
  params?: Partial<ScoringParams>;
  /** Injected randomness for exploration, in [0, 1). */
  random?: () => number;
}

export function recommend(order: OrderInput, bids: BidInput[], opts: RecommendOptions): Recommendation {
  const params = { ...DEFAULT_PARAMS, ...opts.params };
  const weights = opts.weights ?? DEFAULT_WEIGHTS[opts.profile];
  const net = order.customerPrice - order.commission;
  const maxBidAtFloor = Math.floor(net * (1 - params.minMargin));
  const minLevel = RISK_MIN_LEVEL[order.riskTier];

  const pre = bids.map((b) => {
    const flags: Flag[] = [];
    let ineligible: string | null = null;
    if (levelRank(b.level) < levelRank(minLevel)) ineligible = `level ${b.level} below ${minLevel} required for ${order.riskTier} risk`;
    if (marginOf(net, b.amount) < params.minMargin) flags.push('BELOW_MARGIN_FLOOR');
    if (order.minutesToDeadline != null && b.etaMinutes > order.minutesToDeadline) flags.push('MISSES_DEADLINE');
    return { b, flags, ineligible };
  });

  // b_min and eta_min come from bids that pass every gate; fall back to all eligible bids.
  const clean = pre.filter((x) => !x.ineligible && !x.flags.length);
  const basis = clean.length ? clean : pre.filter((x) => !x.ineligible);
  const bMin = basis.length ? Math.min(...basis.map((x) => x.b.amount)) : 0;
  const etaMin = basis.length ? Math.min(...basis.map((x) => Math.max(1, x.b.etaMinutes))) : 1;

  const ranked: ScoredBid[] = pre.map(({ b, flags, ineligible }) => {
    const P = bMin > 0 ? clamp01((bMin / b.amount) ** params.k) : 0;
    const R = clamp01(b.globalReputation / 100);
    const specific = b.serviceReputation ?? b.gameReputation ?? b.globalReputation;
    const E = clamp01(expertise(b.serviceCompleted, specific, params.nRef));
    const T = clamp01(b.recentComposite ?? recentComposite(b.recentGood, b.recentTotal, params.recentM, params.recentPrior));
    const D = clamp01(b.onTimeRate * Math.sqrt(etaMin / Math.max(1, b.etaMinutes)));
    const components = { P: round3(P), R: round3(R), E: round3(E), T: round3(T), D: round3(D) };
    const raw = weights.P * P + weights.R * R + weights.E * E + weights.T * T + weights.D * D;
    return {
      bidId: b.bidId,
      providerId: b.providerId,
      providerCode: b.providerCode,
      amount: b.amount,
      etaMinutes: b.etaMinutes,
      level: b.level,
      ineligible,
      flags,
      components,
      score: ineligible ? 0 : round1(100 * raw),
      estProfit: net - b.amount,
      margin: marginOf(net, b.amount),
    };
  });
  ranked.sort((a, b) => Number(!!a.ineligible) - Number(!!b.ineligible) || b.score - a.score || a.amount - b.amount);

  const pickable = ranked.filter((r) => !r.ineligible && !r.flags.length);
  const base: Omit<Recommendation, 'recommended' | 'mode' | 'explanation'> = { profile: opts.profile, weights, params, net, maxBidAtFloor, ranked };
  if (!pickable.length) {
    return { ...base, recommended: null, mode: 'NONE', explanation: 'No bid passes every gate; a manager must decide.' };
  }

  const top = pickable[0]!;
  const byId = new Map(bids.map((b) => [b.bidId, b]));

  // Exploration (§17): LOW risk only, with probability ε.
  if (order.riskTier === 'LOW' && (opts.random ?? Math.random)() < params.epsilon) {
    const newcomer = pickable.find((r) => {
      const b = byId.get(r.bidId)!;
      return b.serviceCompleted < params.explorationMaxCompleted && top.score - r.score <= params.explorationWindow;
    });
    if (newcomer && newcomer !== top) {
      return { ...base, recommended: newcomer, mode: 'EXPLORATION', explanation: `EXPLORATION: giving ${newcomer.providerCode} (fewer than ${params.explorationMaxCompleted} orders in this service) a chance; within ${params.explorationWindow} points of ${top.providerCode}.` };
    }
  }

  // Rotation: near-ties go to the provider with fewer recent assignments.
  const near = pickable.filter((r) => top.score - r.score <= params.tieDelta);
  if (near.length > 1) {
    const pick = near.slice().sort((a, b) => byId.get(a.bidId)!.recentAssignments - byId.get(b.bidId)!.recentAssignments || b.score - a.score)[0]!;
    if (pick !== top) {
      return { ...base, recommended: pick, mode: 'ROTATION', explanation: `ROTATION: ${pick.providerCode} is within ${params.tieDelta} points of ${top.providerCode} and has fewer assignments this week.` };
    }
  }

  return { ...base, recommended: top, mode: 'SCORE', explanation: explain(top, pickable) };
}

function explain(top: ScoredBid, pickable: ScoredBid[]): string {
  const cheapest = pickable.slice().sort((a, b) => a.amount - b.amount)[0]!;
  if (cheapest === top) return `${top.providerCode} has the best score and the lowest clean bid.`;
  const d = (k: keyof Weights) => top.components[k] - cheapest.components[k];
  const parts = (['R', 'E', 'T', 'D'] as const)
    .filter((k) => d(k) > 0.01)
    .sort((a, b) => d(b) - d(a))
    .slice(0, 2)
    .map((k) => `+${d(k).toFixed(2)} ${{ R: 'reliability', E: 'service expertise', T: 'recent performance', D: 'delivery confidence' }[k]}`);
  return `${top.providerCode} over cheapest ${cheapest.providerCode}: ${parts.join(', ') || 'higher overall score'}.`;
}

/** Expected value sanity check shown to managers (§13.4). */
export function expectedValue(net: Cents, bid: Cents, pSuccess: number, failureCost: Cents): number {
  return (net - bid) * pSuccess - failureCost * (1 - pSuccess);
}

/** Can this actor pick a given scored bid? Flags need a manager; ineligible bids nobody. */
export function pickRestriction(bid: ScoredBid): 'ANY_STAFF' | 'MANAGER' | 'NOBODY' {
  if (bid.ineligible) return 'NOBODY';
  return bid.flags.length ? 'MANAGER' : 'ANY_STAFF';
}
