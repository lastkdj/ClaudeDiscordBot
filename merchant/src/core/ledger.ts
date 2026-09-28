// Provider ledger (ARCHITECTURE §19): append-only, signed amounts in buckets.
// These builders return the entries to insert; they never mutate anything.
// Paired entries move money between buckets and always sum to zero.

import { type Cents, assertCents } from './money.js';
import { DomainError } from './types.js';

export const BUCKETS = ['PENDING', 'AVAILABLE', 'RESERVED', 'PAID'] as const;
export type Bucket = (typeof BUCKETS)[number];

export const ENTRY_TYPES = ['ORDER_EARNING', 'PAYOUT', 'REFUND_REVERSAL', 'ADJUSTMENT', 'BONUS', 'CORRECTION', 'TRANSFER'] as const;
export type EntryType = (typeof ENTRY_TYPES)[number];

export interface LedgerEntryDraft {
  entryType: EntryType;
  bucket: Bucket;
  amount: Cents; // signed
  memo: string;
  orderId?: string | null;
  payoutId?: string | null;
  reversesEntryId?: string | null;
}

export interface Balances {
  pending: Cents;
  available: Cents;
  reserved: Cents;
  paid: Cents;
  lifetime: Cents;
}

export const ZERO_BALANCES: Balances = { pending: 0, available: 0, reserved: 0, paid: 0, lifetime: 0 };

const positive = (c: Cents, what: string) => {
  assertCents(c, what);
  if (c <= 0) throw new DomainError('INVALID_AMOUNT', `${what} must be positive`);
  return c;
};

export function earningEntries(orderId: string, amount: Cents, code: string): LedgerEntryDraft[] {
  positive(amount, 'earning');
  return [{ entryType: 'ORDER_EARNING', bucket: 'PENDING', amount, orderId, memo: `Earning for ${code}` }];
}

/** Hold period over: PENDING -> AVAILABLE. */
export function releaseEntries(orderId: string, amount: Cents, code: string): LedgerEntryDraft[] {
  positive(amount, 'release');
  return [
    { entryType: 'TRANSFER', bucket: 'PENDING', amount: -amount, orderId, memo: `Hold released for ${code}` },
    { entryType: 'TRANSFER', bucket: 'AVAILABLE', amount, orderId, memo: `Hold released for ${code}` },
  ];
}

export function payoutRequestEntries(payoutId: string, amount: Cents, balances: Balances): LedgerEntryDraft[] {
  positive(amount, 'payout');
  if (amount > balances.available) throw new DomainError('INSUFFICIENT_BALANCE', 'payout is larger than the available balance');
  return [
    { entryType: 'TRANSFER', bucket: 'AVAILABLE', amount: -amount, payoutId, memo: 'Payout requested' },
    { entryType: 'TRANSFER', bucket: 'RESERVED', amount, payoutId, memo: 'Payout requested' },
  ];
}

export function payoutPaidEntries(payoutId: string, amount: Cents): LedgerEntryDraft[] {
  positive(amount, 'payout');
  return [
    { entryType: 'PAYOUT', bucket: 'RESERVED', amount: -amount, payoutId, memo: 'Payout sent' },
    { entryType: 'PAYOUT', bucket: 'PAID', amount, payoutId, memo: 'Payout sent' },
  ];
}

/** Rejected/cancelled payout: RESERVED -> AVAILABLE. */
export function payoutCancelEntries(payoutId: string, amount: Cents): LedgerEntryDraft[] {
  positive(amount, 'payout');
  return [
    { entryType: 'TRANSFER', bucket: 'RESERVED', amount: -amount, payoutId, memo: 'Payout rejected' },
    { entryType: 'TRANSFER', bucket: 'AVAILABLE', amount, payoutId, memo: 'Payout rejected' },
  ];
}

/**
 * Provider-liable refund. Taken from PENDING while the earning is still held,
 * else from AVAILABLE (which may go negative; the debt nets against future earnings).
 */
export function refundReversalEntries(orderId: string, amount: Cents, released: boolean, code: string, reversesEntryId?: string | null): LedgerEntryDraft[] {
  positive(amount, 'reversal');
  return [{ entryType: 'REFUND_REVERSAL', bucket: released ? 'AVAILABLE' : 'PENDING', amount: -amount, orderId, reversesEntryId: reversesEntryId ?? null, memo: `Refund reversal for ${code}` }];
}

export function adjustmentEntries(type: 'ADJUSTMENT' | 'BONUS' | 'CORRECTION', amount: Cents, memo: string, orderId?: string | null): LedgerEntryDraft[] {
  assertCents(amount, 'adjustment');
  if (amount === 0) throw new DomainError('INVALID_AMOUNT', 'adjustment cannot be zero');
  if (type === 'BONUS' && amount < 0) throw new DomainError('INVALID_AMOUNT', 'a bonus must be positive');
  if (!memo || memo.trim().length < 3) throw new DomainError('REASON_REQUIRED', 'adjustments need a memo');
  return [{ entryType: type, bucket: 'AVAILABLE', amount, memo, orderId: orderId ?? null }];
}

/** Applies entries to a balance snapshot (used for the cache and for checks). */
export function applyEntries(b: Balances, entries: Pick<LedgerEntryDraft, 'entryType' | 'bucket' | 'amount'>[]): Balances {
  const out = { ...b };
  for (const e of entries) {
    const key = e.bucket.toLowerCase() as 'pending' | 'available' | 'reserved' | 'paid';
    out[key] += e.amount;
    if (e.entryType === 'ORDER_EARNING' || e.entryType === 'BONUS' || e.entryType === 'REFUND_REVERSAL') out.lifetime += e.amount;
  }
  return out;
}

export function balancesFrom(entries: Pick<LedgerEntryDraft, 'entryType' | 'bucket' | 'amount'>[]): Balances {
  return applyEntries(ZERO_BALANCES, entries);
}

export function balancesEqual(a: Balances, b: Balances): boolean {
  return a.pending === b.pending && a.available === b.available && a.reserved === b.reserved && a.paid === b.paid && a.lifetime === b.lifetime;
}
