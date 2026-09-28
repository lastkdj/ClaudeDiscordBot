// Provider levels (ARCHITECTURE §14) and capacity/probation rules (§17).

import { type Level, LEVELS, levelRank } from './types.js';

interface Criteria {
  completed: number;
  tenureDays: number;
  reputation: number;
  maxDisputeRate?: number;
  minOnTime?: number;
  activeLast30?: boolean;
  executiveConfirmation?: boolean;
}

export const LEVEL_CRITERIA: Record<Exclude<Level, 'NEW'>, Criteria> = {
  BRONZE: { completed: 5, tenureDays: 7, reputation: 70 },
  SILVER: { completed: 25, tenureDays: 30, reputation: 80, maxDisputeRate: 0.05 },
  GOLD: { completed: 100, tenureDays: 90, reputation: 85, minOnTime: 0.9 },
  PLATINUM: { completed: 300, tenureDays: 180, reputation: 90, maxDisputeRate: 0.02 },
  DIAMOND: { completed: 600, tenureDays: 365, reputation: 93, activeLast30: true },
  ELITE: { completed: 1000, tenureDays: 365, reputation: 95, executiveConfirmation: true },
};

export const DEMOTION_MARGIN = 5;
export const DEMOTION_DAYS = 30;
export const PROBATION_ORDERS = 5;

export interface LevelInputs {
  current: Level;
  completed: number;
  tenureDays: number;
  reputation: number;
  disputeRate: number;
  onTimeRate: number;
  activeLast30: boolean;
  openSeriousFlags: number;
  /** Consecutive days the provider has been below (current threshold - 5). */
  daysBelowThreshold: number;
  eliteConfirmed: boolean;
}

export interface LevelDecision {
  level: Level;
  change: 'PROMOTE' | 'DEMOTE' | 'NONE';
  reason: string;
  /** ELITE criteria met but waiting for an executive. */
  eliteCandidate: boolean;
}

function meets(level: Exclude<Level, 'NEW'>, x: LevelInputs): boolean {
  const c = LEVEL_CRITERIA[level];
  if (x.openSeriousFlags > 0) return false;
  if (x.completed < c.completed || x.tenureDays < c.tenureDays || x.reputation < c.reputation) return false;
  if (c.maxDisputeRate != null && x.disputeRate > c.maxDisputeRate) return false;
  if (c.minOnTime != null && x.onTimeRate < c.minOnTime) return false;
  if (c.activeLast30 && !x.activeLast30) return false;
  if (c.executiveConfirmation && !x.eliteConfirmed) return false;
  return true;
}

/** Nightly evaluation. Promotions need every criterion; demotions use hysteresis. */
export function evaluateLevel(x: LevelInputs): LevelDecision {
  const eliteCandidate = x.current !== 'ELITE' && meets('ELITE', { ...x, eliteConfirmed: true });
  let best: Level = 'NEW';
  for (const l of LEVELS) if (l !== 'NEW' && meets(l, x)) best = l;

  if (levelRank(best) > levelRank(x.current)) {
    return { level: best, change: 'PROMOTE', reason: `meets every ${best} criterion`, eliteCandidate };
  }
  if (x.current === 'NEW') return { level: 'NEW', change: 'NONE', reason: 'no change', eliteCandidate };

  if (x.openSeriousFlags > 0 && levelRank(x.current) > 0) {
    // Suspension-grade flags demote immediately, one level.
    const to = LEVELS[levelRank(x.current) - 1]!;
    return { level: to, change: 'DEMOTE', reason: 'open serious flag', eliteCandidate: false };
  }
  if (x.daysBelowThreshold >= DEMOTION_DAYS) {
    const to = LEVELS[levelRank(x.current) - 1]!;
    return { level: to, change: 'DEMOTE', reason: `reputation below ${LEVEL_CRITERIA[x.current as Exclude<Level, 'NEW'>].reputation - DEMOTION_MARGIN} for ${DEMOTION_DAYS} days`, eliteCandidate };
  }
  return { level: x.current, change: 'NONE', reason: 'no change', eliteCandidate };
}

/** True when today's reputation counts toward the demotion streak. */
export function belowDemotionLine(level: Level, reputation: number): boolean {
  if (level === 'NEW') return false;
  return reputation < LEVEL_CRITERIA[level].reputation - DEMOTION_MARGIN;
}

export const DEFAULT_CAPACITY: Record<Level, number> = { NEW: 1, BRONZE: 2, SILVER: 3, GOLD: 5, PLATINUM: 5, DIAMOND: 6, ELITE: 8 };

export function capacityFor(level: Level, override?: number | null): number {
  return override ?? DEFAULT_CAPACITY[level];
}

export function inProbation(completedOrders: number): boolean {
  return completedOrders < PROBATION_ORDERS;
}
