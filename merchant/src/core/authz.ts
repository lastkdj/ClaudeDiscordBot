// Authorization policy (ARCHITECTURE §3). Discord roles only control what
// people can see; every button, command and modal calls can() or authorize()
// with the actor resolved from the database.

import { type Actor, ForbiddenError, type RiskTier } from './types.js';

export const ACTIONS = [
  'order.view',
  'order.viewFinancials',
  'order.viewBids',
  'order.import',
  'order.classify',
  'order.note',
  'order.assign',
  'order.override',
  'order.approveHighValue',
  'order.editPrice',
  'order.cancel',
  'order.refund',
  'order.requestCancel',
  'order.work', // provider/staff fulfillment steps (start, deliver, report issue)
  'order.markFailed',
  'order.recordCompletion',
  'order.reopenBidding',
  'bid.submit',
  'provider.review', // see applications and approve/reject capabilities
  'provider.changeLevel',
  'provider.suspend',
  'provider.viewBalance',
  'provider.viewStats',
  'provider.revealPayoutDetails',
  'payout.request',
  'payout.approve',
  'ledger.adjust',
  'report.executive',
  'audit.view',
  'dashboard.game',
  'ticket.open',
  'ticket.handle',
  'quote.request',
  'quote.send',
  'settings.manage',
  'staff.manage',
  'catalog.manage',
] as const;
export type Action = (typeof ACTIONS)[number];

export interface Resource {
  gameId?: string | null;
  /** Provider the resource belongs to (balance, stats, bid) or the order's assigned provider. */
  providerId?: string | null;
  /** Order value in cents, for high-value thresholds. */
  valueCents?: number | null;
  riskTier?: RiskTier | null;
}

export interface Thresholds {
  /** Orders at or above this value (cents) need a manager to assign (default €150). */
  highValueCents: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = { highValueCents: 15000 };

export interface Decision {
  allowed: boolean;
  reason: string;
}

const allow = (reason = 'allowed'): Decision => ({ allowed: true, reason });
const deny = (reason: string): Decision => ({ allowed: false, reason });

export function decide(actor: Actor, action: Action, res: Resource = {}, t: Thresholds = DEFAULT_THRESHOLDS): Decision {
  if (actor.kind === 'SYSTEM') return allow('system');
  if (actor.kind === 'MARKETPLACE') {
    return ['order.import', 'order.cancel', 'order.refund', 'order.recordCompletion', 'order.editPrice'].includes(action)
      ? allow('marketplace event')
      : deny('marketplace events cannot do this');
  }
  if (actor.status !== 'ACTIVE') return deny('your account is not active');

  const overrides = actor.overrides ?? [];
  if (overrides.includes(action) || (res.gameId && overrides.includes(`${action}@${res.gameId}`))) return allow('explicit override');

  const role = actor.orgRole;
  if (role === 'EXECUTIVE') {
    if (action === 'bid.submit' || action === 'payout.request') return deny('executives do not bid or hold provider balances');
    return allow('executive');
  }

  const inGame = (ids: string[]) => !!res.gameId && ids.includes(res.gameId);
  const staffGame = inGame(actor.staffGameIds) || inGame(actor.managerGameIds);
  const managerGame = inGame(actor.managerGameIds);
  const ownProvider = !!actor.providerId && res.providerId === actor.providerId;
  const highValue = (res.valueCents ?? 0) >= t.highValueCents || res.riskTier === 'HIGH';
  const withinLimit = actor.approvalLimit == null || (res.valueCents ?? 0) <= actor.approvalLimit;

  switch (action) {
    case 'order.view':
      if (role === 'MANAGER' || role === 'STAFF') return staffGame ? allow() : deny('not one of your games');
      if (role === 'PROVIDER') return ownProvider ? allow('assigned provider') : deny('not your order');
      return deny('customers see orders on the marketplace');
    case 'order.viewFinancials':
    case 'order.viewBids':
    case 'order.import':
    case 'order.classify':
    case 'order.note':
    case 'order.requestCancel':
    case 'order.reopenBidding':
    case 'quote.send':
    case 'ticket.handle':
    case 'order.recordCompletion':
    case 'order.markFailed':
      if (role === 'MANAGER' || role === 'STAFF') return staffGame ? allow() : deny('not one of your games');
      return deny('staff only');
    case 'order.assign':
    case 'order.override':
      if (role === 'MANAGER') return managerGame ? allow() : deny('not one of your games');
      if (role === 'STAFF') {
        if (!staffGame) return deny('not one of your games');
        return highValue ? deny('high-value or HIGH-risk orders need a manager') : allow();
      }
      return deny('staff only');
    case 'order.approveHighValue':
      if (role === 'MANAGER') {
        if (!managerGame) return deny('not one of your games');
        return withinLimit ? allow() : deny('above your approval limit; ask an executive');
      }
      return deny('managers and executives only');
    case 'order.editPrice':
    case 'order.cancel':
    case 'order.refund':
    case 'provider.review':
    case 'dashboard.game':
      if (role === 'MANAGER') return managerGame ? allow() : deny('not one of your games');
      return deny('managers and executives only');
    case 'provider.suspend':
      if (role === 'MANAGER') return managerGame ? allow('game-scoped suspension') : deny('not one of your games');
      return deny('managers and executives only');
    case 'provider.viewStats':
      if (role === 'MANAGER') return managerGame ? allow() : deny('not one of your games');
      if (role === 'PROVIDER') return ownProvider ? allow() : deny('you can only see your own stats');
      return deny('not allowed');
    case 'provider.viewBalance':
    case 'payout.request':
      return role === 'PROVIDER' && ownProvider ? allow() : deny('only the provider (and executives) can see this');
    case 'order.work':
      if (role === 'PROVIDER') return ownProvider ? allow('assigned provider') : deny('not your order');
      if (role === 'MANAGER' || role === 'STAFF') return staffGame ? allow() : deny('not one of your games');
      return deny('not allowed');
    case 'bid.submit':
      return role === 'PROVIDER' && ownProvider ? allow() : deny('only providers can bid');
    case 'ticket.open':
    case 'quote.request':
      return role === 'CUSTOMER' || role === 'PROVIDER' ? allow() : deny('staff handle tickets; they do not open them');
    case 'provider.changeLevel':
    case 'provider.revealPayoutDetails':
    case 'payout.approve':
    case 'ledger.adjust':
    case 'report.executive':
    case 'audit.view':
    case 'settings.manage':
    case 'staff.manage':
    case 'catalog.manage':
      return deny('executives only');
  }
}

export function can(actor: Actor, action: Action, res?: Resource, t?: Thresholds): boolean {
  return decide(actor, action, res, t).allowed;
}

export function authorize(actor: Actor, action: Action, res?: Resource, t?: Thresholds): void {
  const d = decide(actor, action, res, t);
  if (!d.allowed) throw new ForbiddenError(`${action}: ${d.reason}`);
}
