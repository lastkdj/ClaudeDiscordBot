// Shared domain types. core/ has no Discord, HTTP or database imports.

export const ORG_ROLES = ['EXECUTIVE', 'MANAGER', 'STAFF', 'PROVIDER', 'CUSTOMER'] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

export const LEVELS = ['NEW', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'DIAMOND', 'ELITE'] as const;
export type Level = (typeof LEVELS)[number];
export const levelRank = (l: Level): number => LEVELS.indexOf(l);

export const RISK_TIERS = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type RiskTier = (typeof RISK_TIERS)[number];

export const SCORING_PROFILES = ['CURRENCY', 'BOOSTING', 'RAID', 'DEFAULT'] as const;
export type ScoringProfile = (typeof SCORING_PROFILES)[number];

/** Who is acting. Users are resolved from the database, never from Discord roles. */
export type Actor =
  | {
      kind: 'USER';
      userId: string;
      orgRole: OrgRole;
      status: 'ACTIVE' | 'SUSPENDED' | 'DISABLED';
      /** Games this user is assigned to as staff, or manages as a manager. */
      staffGameIds: string[];
      managerGameIds: string[];
      providerId?: string | null;
      /** Order value (cents) up to which a manager may approve high-value assignments; null = no limit. */
      approvalLimit?: number | null;
      /** Explicit elevations from permissions_overrides: "action" or "action@gameId". */
      overrides?: string[];
    }
  | { kind: 'SYSTEM' }
  | { kind: 'MARKETPLACE'; source: string };

export const SYSTEM: Actor = { kind: 'SYSTEM' };

export function actorId(a: Actor): string | null {
  return a.kind === 'USER' ? a.userId : null;
}

export function actorKind(a: Actor): string {
  return a.kind === 'USER' ? a.orgRole : a.kind;
}

export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export class ForbiddenError extends DomainError {
  constructor(message: string) {
    super('FORBIDDEN', message);
    this.name = 'ForbiddenError';
  }
}
