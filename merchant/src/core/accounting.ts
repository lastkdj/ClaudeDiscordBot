// TheMerchant's own books (ARCHITECTURE §18).

import { type Cents, applyRate, sum } from './money.js';

export interface OrderMoney {
  customerPrice: Cents;
  marketplaceCommission: Cents;
  providerCost: Cents | null;
  refunds: Cents[];
  otherCosts: Cents[];
}

/** profit = price - commission - provider cost - refunds - other costs */
export function profit(o: OrderMoney): Cents {
  return o.customerPrice - o.marketplaceCommission - (o.providerCost ?? 0) - sum(o.refunds) - sum(o.otherCosts);
}

export function netBeforeProvider(o: Pick<OrderMoney, 'customerPrice' | 'marketplaceCommission'>): Cents {
  return o.customerPrice - o.marketplaceCommission;
}

export function marginPct(o: OrderMoney): number | null {
  return o.customerPrice > 0 ? profit(o) / o.customerPrice : null;
}

export interface FeeRule {
  marketplace: string;
  gameId: string | null;
  serviceId: string | null;
  rate: number;
  validFrom: Date;
  validTo: Date | null;
}

/** Picks the most specific rule valid at `at`: service > game > marketplace-wide. */
export function pickFeeRule(rules: FeeRule[], marketplace: string, gameId: string, serviceId: string, at: Date): FeeRule | null {
  const valid = rules.filter(
    (r) => r.marketplace === marketplace && r.validFrom <= at && (!r.validTo || r.validTo > at) && (r.gameId == null || r.gameId === gameId) && (r.serviceId == null || r.serviceId === serviceId),
  );
  const spec = (r: FeeRule) => (r.serviceId ? 2 : 0) + (r.gameId ? 1 : 0);
  return valid.sort((a, b) => spec(b) - spec(a) || b.validFrom.getTime() - a.validFrom.getTime())[0] ?? null;
}

/** Commission from the marketplace if given, else estimated from the fee rule (half-even). */
export function commissionFor(price: Cents, actual: Cents | null | undefined, rule: FeeRule | null): { amount: Cents; estimate: boolean } {
  if (actual != null) return { amount: actual, estimate: false };
  if (!rule) return { amount: 0, estimate: true };
  return { amount: applyRate(price, rule.rate), estimate: true };
}
