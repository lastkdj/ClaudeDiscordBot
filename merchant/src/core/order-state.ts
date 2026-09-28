// Order lifecycle (ARCHITECTURE §10). This table is the only definition of
// which status changes are legal; services/orders.ts applies it inside a
// transaction with SELECT ... FOR UPDATE, and nothing else writes orders.status.

import { type Actor, DomainError } from './types.js';

export const ORDER_STATUSES = [
  'QUOTE_REQUESTED',
  'RECEIVED',
  'VALIDATED',
  'PROCUREMENT',
  'BIDDING',
  'BID_REVIEW',
  'PROVIDER_SELECTED',
  'PROVIDER_CONFIRMED',
  'IN_PROGRESS',
  'DELIVERED',
  'MARKETPLACE_COMPLETION',
  'COMPLETED',
  'EARNING_RELEASED',
  'REASSIGNMENT_REQUIRED',
  'PROVIDER_FAILED',
  'MANUAL_REVIEW',
  'DISPUTED',
  'CANCELLED',
  'REFUNDED',
  'PARTIAL_REFUND',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** Statuses from which nothing but late refunds can follow. */
export const TERMINAL: ReadonlySet<OrderStatus> = new Set(['EARNING_RELEASED', 'CANCELLED', 'REFUNDED']);
/** Done from an operations point of view (no more fulfillment work). */
export const CLOSED: ReadonlySet<OrderStatus> = new Set(['COMPLETED', 'EARNING_RELEASED', 'CANCELLED', 'REFUNDED']);

type Who = 'SYSTEM' | 'MARKETPLACE' | 'STAFF' | 'MANAGER' | 'EXECUTIVE' | 'PROVIDER';
const OPS: Who[] = ['STAFF', 'MANAGER', 'EXECUTIVE'];
const MGMT: Who[] = ['MANAGER', 'EXECUTIVE'];
const AUTO: Who[] = ['SYSTEM', 'MARKETPLACE'];

interface Rule {
  from: OrderStatus[] | 'NON_TERMINAL';
  to: OrderStatus;
  who: Who[];
  /** Transition needs a written reason (audited). */
  reason?: boolean;
}

const RULES: Rule[] = [
  { from: ['QUOTE_REQUESTED'], to: 'RECEIVED', who: [...OPS, ...AUTO] },
  { from: ['RECEIVED'], to: 'VALIDATED', who: [...OPS, ...AUTO] },
  { from: ['VALIDATED'], to: 'PROCUREMENT', who: [...OPS, ...AUTO] },
  { from: ['PROCUREMENT', 'REASSIGNMENT_REQUIRED'], to: 'BIDDING', who: [...OPS, 'SYSTEM'] },
  { from: ['BID_REVIEW'], to: 'BIDDING', who: OPS, reason: false }, // reopen bidding
  { from: ['BIDDING'], to: 'BID_REVIEW', who: [...OPS, 'SYSTEM'] },
  { from: ['REASSIGNMENT_REQUIRED'], to: 'BID_REVIEW', who: [...OPS, 'SYSTEM'] },
  { from: ['BID_REVIEW'], to: 'PROVIDER_SELECTED', who: [...OPS, 'SYSTEM'] },
  { from: ['PROVIDER_SELECTED'], to: 'PROVIDER_CONFIRMED', who: ['PROVIDER', ...MGMT] },
  { from: ['BIDDING', 'PROVIDER_SELECTED', 'PROVIDER_FAILED'], to: 'REASSIGNMENT_REQUIRED', who: [...OPS, 'SYSTEM', 'PROVIDER'] },
  { from: ['PROVIDER_CONFIRMED'], to: 'IN_PROGRESS', who: ['PROVIDER', ...OPS] },
  { from: ['IN_PROGRESS'], to: 'DELIVERED', who: ['PROVIDER', ...OPS] },
  { from: ['PROVIDER_CONFIRMED', 'IN_PROGRESS', 'DELIVERED'], to: 'PROVIDER_FAILED', who: OPS, reason: true },
  { from: ['DELIVERED'], to: 'MARKETPLACE_COMPLETION', who: [...OPS, ...AUTO] },
  { from: ['MARKETPLACE_COMPLETION', 'PARTIAL_REFUND'], to: 'COMPLETED', who: [...OPS, ...AUTO] },
  { from: ['COMPLETED', 'PARTIAL_REFUND'], to: 'EARNING_RELEASED', who: ['SYSTEM', 'EXECUTIVE'] },
  { from: 'NON_TERMINAL', to: 'MANUAL_REVIEW', who: [...OPS, ...AUTO], reason: true },
  { from: 'NON_TERMINAL', to: 'CANCELLED', who: [...MGMT, ...AUTO], reason: true },
  { from: 'NON_TERMINAL', to: 'DISPUTED', who: [...MGMT, ...AUTO], reason: true },
  // A marketplace dispute can still open during the hold period after completion.
  { from: ['COMPLETED'], to: 'DISPUTED', who: [...MGMT, ...AUTO], reason: true },
  { from: ['DISPUTED'], to: 'IN_PROGRESS', who: [...MGMT, ...AUTO] },
  { from: ['DISPUTED'], to: 'COMPLETED', who: [...MGMT, ...AUTO] },
  { from: [...nonTerminal(), 'COMPLETED', 'EARNING_RELEASED'], to: 'REFUNDED', who: [...MGMT, ...AUTO], reason: true },
  { from: [...nonTerminal(), 'COMPLETED', 'EARNING_RELEASED'], to: 'PARTIAL_REFUND', who: [...MGMT, ...AUTO], reason: true },
];

function nonTerminal(): OrderStatus[] {
  return ORDER_STATUSES.filter((s) => !['EARNING_RELEASED', 'CANCELLED', 'REFUNDED', 'COMPLETED', 'PARTIAL_REFUND'].includes(s));
}

// Statuses MANUAL_REVIEW can return to: wherever the order was before, or VALIDATED.
const REVIEW_RETURNS: OrderStatus[] = ['RECEIVED', 'VALIDATED', 'PROCUREMENT', 'BIDDING', 'BID_REVIEW', 'PROVIDER_SELECTED',
  'PROVIDER_CONFIRMED', 'IN_PROGRESS', 'DELIVERED', 'MARKETPLACE_COMPLETION', 'REASSIGNMENT_REQUIRED', 'QUOTE_REQUESTED'];

function who(actor: Actor): Who {
  if (actor.kind === 'SYSTEM') return 'SYSTEM';
  if (actor.kind === 'MARKETPLACE') return 'MARKETPLACE';
  if (actor.orgRole === 'CUSTOMER') throw new DomainError('FORBIDDEN', 'customers cannot change order status');
  return actor.orgRole;
}

export interface TransitionCheck {
  from: OrderStatus;
  to: OrderStatus;
  actor: Actor;
  reason?: string | null;
  /** For MANUAL_REVIEW -> X: the status the order had before review. */
  previousStatus?: OrderStatus | null;
}

/** Throws DomainError when the transition is not allowed. Game scoping is checked by authz. */
export function assertTransition({ from, to, actor, reason, previousStatus }: TransitionCheck): void {
  if (from === to) throw new DomainError('NOOP_TRANSITION', `order is already ${to}`);
  const w = who(actor);
  if (from === 'MANUAL_REVIEW') {
    if (to === 'CANCELLED' || to === 'DISPUTED' || to === 'REFUNDED' || to === 'PARTIAL_REFUND') {
      // handled by the NON_TERMINAL rules below
    } else {
      if (!REVIEW_RETURNS.includes(to) || (to !== 'VALIDATED' && to !== previousStatus)) {
        throw new DomainError('ILLEGAL_TRANSITION', `MANUAL_REVIEW can only return to ${previousStatus ?? 'its previous status'} or VALIDATED, not ${to}`);
      }
      if (!['STAFF', 'MANAGER', 'EXECUTIVE', 'SYSTEM'].includes(w)) throw new DomainError('FORBIDDEN', `${w} cannot resolve a manual review`);
      return;
    }
  }
  const candidates = RULES.filter((r) => r.to === to && (r.from === 'NON_TERMINAL' ? !TERMINAL.has(from) && from !== to && !CLOSED.has(from) : r.from.includes(from)));
  if (!candidates.length) throw new DomainError('ILLEGAL_TRANSITION', `cannot move an order from ${from} to ${to}`);
  const rule = candidates.find((r) => r.who.includes(w));
  if (!rule) throw new DomainError('FORBIDDEN', `${w} cannot move an order from ${from} to ${to}`);
  if (rule.reason && !(reason && reason.trim().length >= 3)) throw new DomainError('REASON_REQUIRED', `moving to ${to} needs a reason`);
}

export function canTransition(c: TransitionCheck): boolean {
  try {
    assertTransition(c);
    return true;
  } catch {
    return false;
  }
}

/** Forum tag (ARCHITECTURE §10) that mirrors the status group. */
export type StatusTag = 'Needs Review' | 'Bidding' | 'Awaiting Provider' | 'In Progress' | 'Delivered' | 'Completed' | 'Problem';

export function statusTag(s: OrderStatus): StatusTag {
  switch (s) {
    case 'QUOTE_REQUESTED':
    case 'RECEIVED':
    case 'MANUAL_REVIEW':
      return 'Needs Review';
    case 'VALIDATED':
    case 'PROCUREMENT':
    case 'BIDDING':
    case 'BID_REVIEW':
      return 'Bidding';
    case 'PROVIDER_SELECTED':
    case 'REASSIGNMENT_REQUIRED':
      return 'Awaiting Provider';
    case 'PROVIDER_CONFIRMED':
    case 'IN_PROGRESS':
      return 'In Progress';
    case 'DELIVERED':
    case 'MARKETPLACE_COMPLETION':
      return 'Delivered';
    case 'COMPLETED':
    case 'EARNING_RELEASED':
      return 'Completed';
    case 'PROVIDER_FAILED':
    case 'DISPUTED':
    case 'CANCELLED':
    case 'REFUNDED':
    case 'PARTIAL_REFUND':
      return 'Problem';
  }
}

/** Statuses in which the order counts as "active" work for a provider's capacity. */
export const PROVIDER_ACTIVE: ReadonlySet<OrderStatus> = new Set(['PROVIDER_SELECTED', 'PROVIDER_CONFIRMED', 'IN_PROGRESS', 'DELIVERED']);
