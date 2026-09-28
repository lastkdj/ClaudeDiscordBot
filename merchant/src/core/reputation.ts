// Provider reputation (ARCHITECTURE §15-16): Bayesian-smoothed, time-decayed.

export interface OrderOutcome {
  ageDays: number;
  /** COMPLETED (or EARNING_RELEASED). */
  completed: boolean;
  /** Provider-caused failure, decline after confirming, or timeout. */
  providerFailed: boolean;
  /** Cancelled by customer or marketplace: excluded from the provider's rates. */
  cancelledNotProviderFault: boolean;
  onTime: boolean | null;
  disputed: boolean;
  rating: number | null; // 1-5
}

export const REPUTATION_PRIORS = { completion: 0.9, onTime: 0.85, dispute: 0.03, failure: 0.03, rating: 0.8, m: 10, halfLifeDays: 120 };

export interface ReputationResult {
  reputation: number; // 0-100, 2 decimals
  components: { completionRate: number; onTimeRate: number; disputeRate: number; failureRate: number; ratingNorm: number };
  counts: { orders: number; completed: number; failed: number; disputed: number; rated: number };
}

const decay = (ageDays: number) => 0.5 ** (Math.max(0, ageDays) / REPUTATION_PRIORS.halfLifeDays);
const smooth = (hits: number, n: number, prior: number) => (hits + REPUTATION_PRIORS.m * prior) / (n + REPUTATION_PRIORS.m);
const r4 = (x: number) => Math.round(x * 10000) / 10000;

export function computeReputation(outcomes: OrderOutcome[]): ReputationResult {
  let n = 0, completed = 0, failed = 0, disputed = 0;
  let otN = 0, otHits = 0, rN = 0, rSum = 0;
  const counts = { orders: 0, completed: 0, failed: 0, disputed: 0, rated: 0 };
  for (const o of outcomes) {
    if (o.cancelledNotProviderFault) continue;
    const w = decay(o.ageDays);
    counts.orders++;
    n += w;
    if (o.completed) { completed += w; counts.completed++; }
    if (o.providerFailed) { failed += w; counts.failed++; }
    if (o.disputed) { disputed += w; counts.disputed++; }
    if (o.completed && o.onTime != null) { otN += w; if (o.onTime) otHits += w; }
    if (o.rating != null) { rN += w; rSum += w * ((o.rating - 1) / 4); counts.rated++; }
  }
  const P = REPUTATION_PRIORS;
  const completionRate = smooth(completed, n, P.completion);
  const onTimeRate = smooth(otHits, otN, P.onTime);
  const disputeRate = smooth(disputed, n, P.dispute);
  const failureRate = smooth(failed, n, P.failure);
  const ratingNorm = smooth(rSum, rN, P.rating);
  const rep = 100 * (0.3 * completionRate + 0.2 * onTimeRate + 0.2 * (1 - Math.min(1, 3 * disputeRate)) + 0.2 * ratingNorm + 0.1 * (1 - Math.min(1, 3 * failureRate)));
  return {
    reputation: Math.round(rep * 100) / 100,
    components: { completionRate: r4(completionRate), onTimeRate: r4(onTimeRate), disputeRate: r4(disputeRate), failureRate: r4(failureRate), ratingNorm: r4(ratingNorm) },
    counts,
  };
}

/** Service -> game -> global fallback: a specific reputation needs at least 5 orders (§16). */
export function specificReputation(service: ReputationResult | null, game: ReputationResult | null, global: ReputationResult): { service: number | null; game: number | null } {
  return {
    service: service && service.counts.orders >= 5 ? service.reputation : null,
    game: game && game.counts.orders >= 5 ? game.reputation : null,
  };
}
