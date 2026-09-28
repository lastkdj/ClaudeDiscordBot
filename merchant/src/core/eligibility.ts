// Who may be invited to bid on an order (ARCHITECTURE §11.1, §17).
// services/bidding.ts runs the same rules as one SQL query; this pure version
// is re-checked when a bid arrives, so a stale invite cannot be used.

import { capacityFor, inProbation } from './levels.js';
import { RISK_MIN_LEVEL } from './scoring.js';
import { type Level, levelRank, type RiskTier } from './types.js';

export interface ProviderSnapshot {
  status: 'APPLICANT' | 'ACTIVE' | 'PAUSED' | 'SUSPENDED' | 'OFFBOARDED';
  level: Level;
  availability: 'AVAILABLE' | 'BUSY' | 'OFFLINE' | 'PAUSED';
  maxConcurrent: number | null;
  activeOrders: number;
  completedOrders: number;
  hasApprovedCapability: boolean;
  /** Game-scoped suspension for this order's game. */
  suspendedForGame: boolean;
  /** e.g. the provider is also the customer on this order. */
  conflict: boolean;
}

export interface OrderSnapshot {
  riskTier: RiskTier;
  trialEligible: boolean;
}

export interface EligibilityOptions {
  /** Let BUSY providers bid when they still have free capacity. */
  allowBusy: boolean;
}

export function ineligibilityReason(p: ProviderSnapshot, o: OrderSnapshot, opts: EligibilityOptions = { allowBusy: true }): string | null {
  if (p.status !== 'ACTIVE') return `provider is ${p.status.toLowerCase()}`;
  if (p.suspendedForGame) return 'suspended for this game';
  if (!p.hasApprovedCapability) return 'no approved capability for this service';
  if (p.conflict) return 'conflict of interest';
  const cap = inProbation(p.completedOrders) ? 1 : capacityFor(p.level, p.maxConcurrent);
  if (p.activeOrders >= cap) return 'at capacity';
  if (p.availability === 'OFFLINE' || p.availability === 'PAUSED') return `availability is ${p.availability.toLowerCase()}`;
  if (p.availability === 'BUSY' && !opts.allowBusy) return 'busy';
  if (levelRank(p.level) < levelRank(RISK_MIN_LEVEL[o.riskTier])) return `level ${p.level} is below ${RISK_MIN_LEVEL[o.riskTier]} for ${o.riskTier} risk`;
  if (inProbation(p.completedOrders) && !o.trialEligible) return 'probation: trial services only';
  return null;
}

export const isEligible = (p: ProviderSnapshot, o: OrderSnapshot, opts?: EligibilityOptions) => ineligibilityReason(p, o, opts) === null;

// ---------------------------------------------------------------- windows

export interface WindowState {
  openedAt: Date;
  windowSeconds: number;
  extended: boolean;
  activeBids: number;
  /** Close early once this many bids are in (0 = never). */
  closeAtBids: number;
}

export type WindowOutcome = 'OPEN' | 'CLOSE' | 'EXTEND' | 'NO_BIDS';

/** Decides what a bid window should do at `now` (§11.4). */
export function windowOutcome(w: WindowState, now: Date): WindowOutcome {
  if (w.closeAtBids > 0 && w.activeBids >= w.closeAtBids) return 'CLOSE';
  const endsAt = w.openedAt.getTime() + w.windowSeconds * 1000 * (w.extended ? 2 : 1);
  if (now.getTime() < endsAt) return 'OPEN';
  if (w.activeBids > 0) return 'CLOSE';
  return w.extended ? 'NO_BIDS' : 'EXTEND';
}

export function windowEndsAt(w: Pick<WindowState, 'openedAt' | 'windowSeconds' | 'extended'>): Date {
  return new Date(w.openedAt.getTime() + w.windowSeconds * 1000 * (w.extended ? 2 : 1));
}
