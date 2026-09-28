// Users, org roles, game assignments, and resolving a Discord user to an Actor.
import { authorize } from '../core/authz.js';
import { type Actor, DomainError, type OrgRole } from '../core/types.js';
import { fromDecimalString, parseMoney, toDecimalString } from '../core/money.js';
import { many, one, type Q } from '../db/pool.js';
import { audit } from './audit.js';
import type { Ctx } from './context.js';
import { enqueue } from './jobs.js';

export interface DiscordUserRef {
  id: string;
  username: string;
  /** From the snowflake: used for the minimum account age check. */
  createdAt?: Date;
}

export interface UserRow {
  id: string;
  display_name: string;
  org_role: OrgRole;
  status: 'ACTIVE' | 'SUSPENDED' | 'DISABLED';
  discord_user_id: string | null;
}

/** Discord snowflake -> creation time. */
export function snowflakeTime(id: string): Date {
  return new Date(Number((BigInt(id) >> 22n) + 1420070400000n));
}

export async function findUserByDiscord(q: Q, discordUserId: string): Promise<UserRow | null> {
  return one<UserRow>(
    q,
    `SELECT u.id, u.display_name, u.org_role, u.status, d.discord_user_id
     FROM discord_identities d JOIN users u ON u.id = d.user_id WHERE d.discord_user_id = $1`,
    [discordUserId],
  );
}

export async function getUser(q: Q, userId: string): Promise<UserRow | null> {
  return one<UserRow>(
    q,
    `SELECT u.id, u.display_name, u.org_role, u.status, d.discord_user_id
     FROM users u LEFT JOIN discord_identities d ON d.user_id = u.id WHERE u.id = $1`,
    [userId],
  );
}

/** Creates the user on first contact. New users are customers until promoted. */
export async function ensureUser(q: Q, du: DiscordUserRef, role: OrgRole = 'CUSTOMER'): Promise<UserRow> {
  const existing = await findUserByDiscord(q, du.id);
  if (existing) {
    await q.query('UPDATE discord_identities SET username = $2 WHERE discord_user_id = $1 AND username IS DISTINCT FROM $2', [du.id, du.username]);
    return existing;
  }
  const u = await one<{ id: string }>(q, 'INSERT INTO users (display_name, org_role) VALUES ($1, $2) RETURNING id', [du.username, role]);
  await q.query(
    `INSERT INTO discord_identities (user_id, discord_user_id, username, account_created_at) VALUES ($1, $2, $3, $4)
     ON CONFLICT (discord_user_id) DO NOTHING`,
    [u!.id, du.id, du.username, du.createdAt ?? snowflakeTime(du.id)],
  );
  return (await findUserByDiscord(q, du.id))!;
}

export async function actorForUser(q: Q, userId: string): Promise<Actor> {
  const u = await one(
    q,
    `SELECT u.id, u.org_role, u.status, p.id AS provider_id, mp.approval_limit,
       coalesce((SELECT array_agg(game_id::text) FROM staff_game_assignments WHERE user_id = u.id), '{}') AS staff_games,
       coalesce((SELECT array_agg(game_id::text) FROM manager_game_assignments WHERE user_id = u.id), '{}') AS manager_games,
       coalesce((SELECT array_agg(CASE WHEN game_id IS NULL THEN permission ELSE permission || '@' || game_id END)
                 FROM permissions_overrides WHERE user_id = u.id AND (expires_at IS NULL OR expires_at > now())), '{}') AS overrides
     FROM users u
     LEFT JOIN providers p ON p.user_id = u.id AND p.status <> 'APPLICANT'
     LEFT JOIN manager_profiles mp ON mp.user_id = u.id
     WHERE u.id = $1`,
    [userId],
  );
  if (!u) throw new DomainError('NOT_FOUND', 'unknown user');
  return {
    kind: 'USER',
    userId: u.id,
    orgRole: u.org_role,
    status: u.status,
    staffGameIds: u.staff_games,
    managerGameIds: u.manager_games,
    providerId: u.provider_id,
    approvalLimit: u.approval_limit == null ? null : fromDecimalString(u.approval_limit),
    overrides: u.overrides,
  };
}

/** Resolves who is clicking. Unknown Discord users become customers. */
export async function resolveActor(q: Q, du: DiscordUserRef): Promise<{ actor: Actor; user: UserRow }> {
  const user = await ensureUser(q, du);
  return { actor: await actorForUser(q, user.id), user };
}

/** Makes OWNER_DISCORD_ID an Executive on startup (idempotent). */
export async function bootstrapOwner(ctx: Ctx, du: DiscordUserRef): Promise<void> {
  await ctx.db.tx(async (q) => {
    const u = await ensureUser(q, du, 'EXECUTIVE');
    if (u.org_role !== 'EXECUTIVE') {
      await q.query(`UPDATE users SET org_role = 'EXECUTIVE' WHERE id = $1`, [u.id]);
      await audit(q, { actor: { kind: 'SYSTEM' }, action: 'USER_ROLE_CHANGED', objectType: 'user', objectId: u.id, oldValue: u.org_role, newValue: 'EXECUTIVE', reason: 'OWNER_DISCORD_ID bootstrap', source: 'CLI', important: true });
    }
  });
}

/** Executive-only: set someone's org role and game assignments. */
export async function setStaffRole(
  ctx: Ctx,
  actor: Actor,
  target: DiscordUserRef,
  input: { role: Exclude<OrgRole, 'PROVIDER'>; gameIds: string[]; approvalLimit?: string | null },
): Promise<UserRow> {
  authorize(actor, 'staff.manage');
  return ctx.db.tx(async (q) => {
    const u = await ensureUser(q, target);
    const old = { role: u.org_role, games: (await many(q, 'SELECT game_id FROM staff_game_assignments WHERE user_id = $1', [u.id])).map((r) => r.game_id) };
    if (u.org_role === 'PROVIDER') {
      const p = await one(q, `SELECT status FROM providers WHERE user_id = $1`, [u.id]);
      if (p && p.status === 'ACTIVE') throw new DomainError('CONFLICT', 'offboard the provider profile before giving this user a staff role');
    }
    await q.query('UPDATE users SET org_role = $2 WHERE id = $1', [u.id, input.role]);
    await q.query('DELETE FROM staff_game_assignments WHERE user_id = $1', [u.id]);
    await q.query('DELETE FROM manager_game_assignments WHERE user_id = $1', [u.id]);
    if (input.role === 'STAFF' || input.role === 'MANAGER') {
      for (const g of input.gameIds) await q.query('INSERT INTO staff_game_assignments (user_id, game_id) VALUES ($1, $2)', [u.id, g]);
    }
    if (input.role === 'MANAGER') {
      for (const g of input.gameIds) await q.query('INSERT INTO manager_game_assignments (user_id, game_id) VALUES ($1, $2)', [u.id, g]);
      const limit = input.approvalLimit ? toDecimalString(parseMoney(input.approvalLimit)) : null;
      await q.query(
        `INSERT INTO manager_profiles (user_id, approval_limit) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET approval_limit = EXCLUDED.approval_limit`,
        [u.id, limit],
      );
    }
    await audit(q, { actor, action: 'USER_ROLE_CHANGED', objectType: 'user', objectId: u.id, oldValue: old, newValue: { role: input.role, games: input.gameIds }, source: ctx.source, important: true });
    await enqueue(q, 'discord.syncRoles', { userId: u.id }, { dedupeKey: `roles:${u.id}` });
    return (await getUser(q, u.id))!;
  });
}

/** Everything the role reconciler needs: which Discord roles this user should hold. */
export async function desiredRoleNames(q: Q, userId: string): Promise<{ discordUserId: string | null; roles: string[] }> {
  const u = await getUser(q, userId);
  if (!u) return { discordUserId: null, roles: [] };
  const roles: string[] = [];
  if (u.status !== 'ACTIVE') return { discordUserId: u.discord_user_id, roles };
  if (u.org_role === 'CUSTOMER') roles.push('Customer');
  if (u.org_role === 'STAFF' || u.org_role === 'MANAGER') {
    const games = await many(q, `SELECT g.short_name FROM staff_game_assignments s JOIN games g ON g.id = s.game_id WHERE s.user_id = $1`, [userId]);
    for (const g of games) roles.push(teamRoleName(g.short_name));
  }
  const p = await one(q, `SELECT id, status FROM providers WHERE user_id = $1`, [userId]);
  if (p) {
    if (p.status === 'APPLICANT') roles.push('Provider Applicant');
    if (p.status === 'ACTIVE' || p.status === 'PAUSED') {
      roles.push('Provider');
      const games = await many(
        q,
        `SELECT DISTINCT g.short_name FROM provider_capabilities c JOIN games g ON g.id = c.game_id
         WHERE c.provider_id = $1 AND c.status = 'APPROVED'
           AND NOT EXISTS (SELECT 1 FROM provider_game_suspensions s WHERE s.provider_id = c.provider_id AND s.game_id = c.game_id AND s.lifted_at IS NULL)`,
        [p.id],
      );
      for (const g of games) roles.push(providerRoleName(g.short_name));
    }
  }
  return { discordUserId: u.discord_user_id, roles: [...new Set(roles)] };
}

/** Per-game Discord role names (must match server-config.json). */
export const teamRoleName = (shortName: string) => `${shortName} Team`;
export const providerRoleName = (shortName: string) => `${shortName} Provider`;

/** Roles TheMerchant manages; anything else on a member is left alone. */
export async function managedRoleNames(q: Q): Promise<string[]> {
  const games = await many(q, 'SELECT short_name FROM games');
  return ['Customer', 'Provider', 'Provider Applicant', ...games.flatMap((g) => [teamRoleName(g.short_name), providerRoleName(g.short_name)])];
}
