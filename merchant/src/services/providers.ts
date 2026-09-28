// Provider onboarding (§5), capabilities, availability, suspension, payout details.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { authorize } from '../core/authz.js';
import { type Actor, actorId, DomainError, type Level, LEVELS } from '../core/types.js';
import { many, one, type Q } from '../db/pool.js';
import { audit } from './audit.js';
import type { Ctx } from './context.js';
import { enqueue } from './jobs.js';
import { getSettings } from './settings.js';
import { type DiscordUserRef, ensureUser, snowflakeTime } from './users.js';

export interface ProviderRow {
  id: string;
  user_id: string;
  code: string | null;
  status: 'APPLICANT' | 'ACTIVE' | 'PAUSED' | 'SUSPENDED' | 'OFFBOARDED';
  level: Level;
  elite_confirmed: boolean;
  reputation: string | null;
  max_concurrent: number | null;
  desk_thread_id: string | null;
  payout_details_enc: Buffer | null;
  approved_at: Date | null;
  created_at: Date;
}

export const getProvider = (q: Q, id: string) => one<ProviderRow>(q, 'SELECT * FROM providers WHERE id = $1', [id]);
export const getProviderByUser = (q: Q, userId: string) => one<ProviderRow>(q, 'SELECT * FROM providers WHERE user_id = $1', [userId]);

export interface CapabilityRequest {
  gameId: string;
  versionId?: string | null;
  categoryId?: string | null;
  serviceId?: string | null;
}

/** Step 1: accept the provider rules. Creates the applicant profile. */
export async function acceptProviderRules(ctx: Ctx, du: DiscordUserRef): Promise<ProviderRow> {
  return ctx.db.tx(async (q) => {
    const s = await getSettings(q);
    const created = du.createdAt ?? snowflakeTime(du.id);
    const ageDays = (ctx.now().getTime() - created.getTime()) / 86_400_000;
    if (ageDays < s.minAccountAgeDays) {
      throw new DomainError('ACCOUNT_TOO_NEW', `Your Discord account must be at least ${s.minAccountAgeDays} days old to apply.`);
    }
    const user = await ensureUser(q, du);
    if (user.org_role !== 'CUSTOMER' && user.org_role !== 'PROVIDER') throw new DomainError('CONFLICT', 'staff accounts cannot become providers');
    await q.query('INSERT INTO rules_acceptances (user_id, rules_version) VALUES ($1, $2) ON CONFLICT DO NOTHING', [user.id, s.providerRulesVersion]);
    let p = await getProviderByUser(q, user.id);
    if (!p) {
      p = await one<ProviderRow>(q, `INSERT INTO providers (user_id) VALUES ($1) RETURNING *`, [user.id]);
      await audit(q, { actor: { kind: 'SYSTEM' }, action: 'PROVIDER_APPLICANT_CREATED', objectType: 'provider', objectId: p!.id, newValue: { rulesVersion: s.providerRulesVersion }, source: ctx.source });
      await enqueue(q, 'discord.syncRoles', { userId: user.id }, { dedupeKey: `roles:${user.id}` });
    }
    if (p!.status === 'SUSPENDED' || p!.status === 'OFFBOARDED') throw new DomainError('FORBIDDEN', 'this provider profile cannot apply');
    return p!;
  });
}

export interface ApplicationInput {
  displayName: string;
  timezone: string;
  experience: string;
  proofLink?: string | null;
  capabilities: CapabilityRequest[];
}

/** Step 2: submit the application (the modal answers + selected capabilities). */
export async function submitApplication(ctx: Ctx, du: DiscordUserRef, input: ApplicationInput): Promise<string> {
  if (!input.capabilities.length) throw new DomainError('INVALID', 'pick at least one game and service');
  return ctx.db.tx(async (q) => {
    const s = await getSettings(q);
    const user = await ensureUser(q, du);
    const p = await getProviderByUser(q, user.id);
    if (!p) throw new DomainError('INVALID_STATE', 'accept the provider rules first');
    const accepted = await one(q, 'SELECT 1 FROM rules_acceptances WHERE user_id = $1 AND rules_version = $2', [user.id, s.providerRulesVersion]);
    if (!accepted) throw new DomainError('INVALID_STATE', 'accept the current provider rules first');
    const open = await one(q, `SELECT id FROM provider_applications WHERE provider_id = $1 AND status IN ('SUBMITTED','PARTIAL')`, [p.id]);
    if (open) throw new DomainError('CONFLICT', 'you already have an application under review');
    const app = await one(
      q,
      `INSERT INTO provider_applications (provider_id, answers, rules_version, status) VALUES ($1, $2, $3, 'SUBMITTED') RETURNING id`,
      [p.id, JSON.stringify({ displayName: input.displayName, timezone: input.timezone, experience: input.experience, proofLink: input.proofLink ?? null, kind: p.status === 'APPLICANT' ? 'APPLICATION' : 'CAPABILITY_REQUEST' }), s.providerRulesVersion],
    );
    await insertCapabilities(q, p.id, app!.id, input.capabilities);
    await q.query('UPDATE providers SET timezone = $2 WHERE id = $1', [p.id, input.timezone]);
    await audit(q, { actor: { kind: 'USER', userId: user.id, orgRole: user.org_role, status: user.status, staffGameIds: [], managerGameIds: [] }, action: 'PROVIDER_APPLICATION_SUBMITTED', objectType: 'application', objectId: app!.id, newValue: { capabilities: input.capabilities.length }, source: ctx.source });
    await enqueue(q, 'discord.applicationPost', { applicationId: app!.id });
    return app!.id as string;
  });
}

async function insertCapabilities(q: Q, providerId: string, applicationId: string, caps: CapabilityRequest[]): Promise<void> {
  for (const c of caps) {
    if (!c.serviceId && !c.categoryId) throw new DomainError('INVALID', 'each capability needs a category or service');
    const dup = await one(
      q,
      `SELECT 1 FROM provider_capabilities WHERE provider_id = $1 AND game_id = $2 AND service_id IS NOT DISTINCT FROM $3 AND category_id IS NOT DISTINCT FROM $4
         AND game_version_id IS NOT DISTINCT FROM $5 AND status IN ('PENDING','APPROVED')`,
      [providerId, c.gameId, c.serviceId ?? null, c.categoryId ?? null, c.versionId ?? null],
    );
    if (dup) continue;
    await q.query(
      `INSERT INTO provider_capabilities (provider_id, game_id, service_id, category_id, game_version_id, application_id) VALUES ($1,$2,$3,$4,$5,$6)`,
      [providerId, c.gameId, c.serviceId ?? null, c.categoryId ?? null, c.versionId ?? null, applicationId],
    );
  }
}

/** Approved providers asking for more services go through the same review. */
export async function requestCapabilities(ctx: Ctx, du: DiscordUserRef, caps: CapabilityRequest[]): Promise<string> {
  const p = await ctx.db.tx(async (q) => {
    const user = await ensureUser(q, du);
    return getProviderByUser(q, user.id);
  });
  if (!p || p.status !== 'ACTIVE') throw new DomainError('INVALID_STATE', 'only active providers can request more capabilities');
  return submitApplication(ctx, du, { displayName: du.username, timezone: 'unchanged', experience: 'Capability request', capabilities: caps });
}

/** A manager decides one game's part of an application (managers only see their games). */
export async function reviewApplication(ctx: Ctx, actor: Actor, applicationId: string, gameId: string, decision: 'APPROVE' | 'REJECT', reason?: string | null): Promise<{ firstApproval: boolean; status: string }> {
  authorize(actor, 'provider.review', { gameId });
  if (decision === 'REJECT' && !(reason && reason.trim().length >= 3)) throw new DomainError('REASON_REQUIRED', 'rejections need a reason');
  return ctx.db.tx(async (q) => {
    const app = await one(q, 'SELECT * FROM provider_applications WHERE id = $1 FOR UPDATE', [applicationId]);
    if (!app) throw new DomainError('NOT_FOUND', 'application not found');
    const p = (await one<ProviderRow>(q, 'SELECT * FROM providers WHERE id = $1 FOR UPDATE', [app.provider_id]))!;
    if (p.user_id === actorId(actor)) throw new DomainError('FORBIDDEN', 'you cannot review your own application');
    const caps = await many(q, `SELECT id FROM provider_capabilities WHERE application_id = $1 AND game_id = $2 AND status = 'PENDING'`, [applicationId, gameId]);
    if (!caps.length) throw new DomainError('INVALID_STATE', 'nothing pending for this game');
    await q.query(
      `UPDATE provider_capabilities SET status = $3, approved_by = $4, approved_at = now() WHERE application_id = $1 AND game_id = $2 AND status = 'PENDING'`,
      [applicationId, gameId, decision === 'APPROVE' ? 'APPROVED' : 'REJECTED', actorId(actor)],
    );
    let firstApproval = false;
    if (decision === 'APPROVE' && p.status === 'APPLICANT') {
      firstApproval = true;
      const code = await one(q, `SELECT 'P-' || nextval('provider_code_seq') AS code`);
      await q.query(`UPDATE providers SET status = 'ACTIVE', code = $2, level = 'NEW', approved_at = now() WHERE id = $1`, [p.id, code!.code]);
      await q.query(`UPDATE users SET org_role = 'PROVIDER' WHERE id = $1 AND org_role = 'CUSTOMER'`, [p.user_id]);
      await q.query(`INSERT INTO provider_availability (provider_id, state) VALUES ($1, 'OFFLINE') ON CONFLICT DO NOTHING`, [p.id]);
      await q.query('INSERT INTO provider_balances (provider_id) VALUES ($1) ON CONFLICT DO NOTHING', [p.id]);
      await enqueue(q, 'discord.deskThread', { providerId: p.id });
    }
    const rest = await one(
      q,
      `SELECT count(*) FILTER (WHERE status = 'PENDING') AS pending, count(*) FILTER (WHERE status = 'APPROVED') AS approved FROM provider_capabilities WHERE application_id = $1`,
      [applicationId],
    );
    const status = Number(rest!.pending) > 0 ? 'PARTIAL' : Number(rest!.approved) > 0 ? 'APPROVED' : 'REJECTED';
    await q.query('UPDATE provider_applications SET status = $2, reviewed_by = $3, reviewed_at = now() WHERE id = $1', [applicationId, status, actorId(actor)]);
    await audit(q, { actor, action: decision === 'APPROVE' ? 'CAPABILITIES_APPROVED' : 'CAPABILITIES_REJECTED', objectType: 'application', objectId: applicationId, newValue: { gameId, count: caps.length, applicationStatus: status }, reason, source: ctx.source, important: firstApproval });
    const game = await one(q, 'SELECT name FROM games WHERE id = $1', [gameId]);
    await enqueue(q, 'discord.syncRoles', { userId: p.user_id }, { dedupeKey: `roles:${p.user_id}` });
    await enqueue(q, 'discord.applicationPost', { applicationId });
    await enqueue(q, 'discord.dm', {
      userId: p.user_id,
      text: decision === 'APPROVE'
        ? `✅ Your provider application for **${game?.name}** was approved.${firstApproval ? ' Your private desk thread is being set up in #provider-desks. Set yourself available in #provider-panel to start receiving opportunities.' : ''}`
        : `Your provider application for **${game?.name}** was not approved: ${reason}`,
    });
    return { firstApproval, status };
  });
}

export async function setAvailability(ctx: Ctx, actor: Actor, state: 'AVAILABLE' | 'BUSY' | 'OFFLINE'): Promise<void> {
  if (actor.kind !== 'USER' || !actor.providerId) throw new DomainError('FORBIDDEN', 'only providers set availability');
  const providerId = actor.providerId;
  await ctx.db.tx(async (q) => {
    const p = await getProvider(q, providerId);
    if (!p || p.status !== 'ACTIVE') throw new DomainError('FORBIDDEN', `your provider profile is ${p?.status.toLowerCase()}`);
    await q.query(
      `INSERT INTO provider_availability (provider_id, state, changed_at) VALUES ($1, $2, now())
       ON CONFLICT (provider_id) DO UPDATE SET state = EXCLUDED.state, changed_at = now()`,
      [providerId, state],
    );
  });
}

export async function suspendProvider(ctx: Ctx, actor: Actor, providerId: string, reason: string, gameId?: string | null): Promise<void> {
  if (!(reason && reason.trim().length >= 3)) throw new DomainError('REASON_REQUIRED', 'suspensions need a reason');
  if (gameId) authorize(actor, 'provider.suspend', { gameId });
  else authorize(actor, 'provider.changeLevel'); // global suspension: executives only
  await ctx.db.tx(async (q) => {
    const p = await getProvider(q, providerId);
    if (!p) throw new DomainError('NOT_FOUND', 'provider not found');
    if (gameId) {
      await q.query('INSERT INTO provider_game_suspensions (provider_id, game_id, reason, created_by) VALUES ($1,$2,$3,$4)', [providerId, gameId, reason, actorId(actor)]);
    } else {
      await q.query(`UPDATE providers SET status = 'SUSPENDED' WHERE id = $1`, [providerId]);
      await q.query(`UPDATE provider_availability SET state = 'PAUSED', changed_at = now() WHERE provider_id = $1`, [providerId]);
      // Suspension freezes bidding: withdraw active bids.
      await q.query(`UPDATE provider_bids SET status = 'WITHDRAWN' WHERE provider_id = $1 AND status = 'ACTIVE'`, [providerId]);
    }
    await q.query(`INSERT INTO provider_flags (provider_id, type, severity, note, created_by) VALUES ($1, 'SUSPENSION', 'SERIOUS', $2, $3)`, [providerId, reason, actorId(actor)]);
    await audit(q, { actor, action: gameId ? 'PROVIDER_SUSPENDED_FOR_GAME' : 'PROVIDER_SUSPENDED', objectType: 'provider', objectId: p.code ?? p.id, newValue: { gameId: gameId ?? null }, reason, source: ctx.source, important: true });
    await enqueue(q, 'discord.syncRoles', { userId: p.user_id }, { dedupeKey: `roles:${p.user_id}` });
    await enqueue(q, 'discord.providerNotice', { providerId, text: `⛔ Your provider account has been suspended${gameId ? ' for one game' : ''}: ${reason}` });
  });
}

export async function liftSuspension(ctx: Ctx, actor: Actor, providerId: string, gameId?: string | null): Promise<void> {
  if (gameId) authorize(actor, 'provider.suspend', { gameId });
  else authorize(actor, 'provider.changeLevel');
  await ctx.db.tx(async (q) => {
    const p = await getProvider(q, providerId);
    if (!p) throw new DomainError('NOT_FOUND', 'provider not found');
    if (gameId) await q.query('UPDATE provider_game_suspensions SET lifted_at = now() WHERE provider_id = $1 AND game_id = $2 AND lifted_at IS NULL', [providerId, gameId]);
    else await q.query(`UPDATE providers SET status = 'ACTIVE' WHERE id = $1 AND status = 'SUSPENDED'`, [providerId]);
    await q.query(`UPDATE provider_flags SET resolved_at = now() WHERE provider_id = $1 AND type = 'SUSPENSION' AND resolved_at IS NULL`, [providerId]);
    await audit(q, { actor, action: 'PROVIDER_SUSPENSION_LIFTED', objectType: 'provider', objectId: p.code ?? p.id, newValue: { gameId: gameId ?? null }, source: ctx.source, important: true });
    await enqueue(q, 'discord.syncRoles', { userId: p.user_id }, { dedupeKey: `roles:${p.user_id}` });
  });
}

export async function setLevelManually(ctx: Ctx, actor: Actor, providerId: string, level: Level, reason: string): Promise<void> {
  authorize(actor, 'provider.changeLevel');
  if (!LEVELS.includes(level)) throw new DomainError('INVALID', 'unknown level');
  if (!(reason && reason.trim().length >= 3)) throw new DomainError('REASON_REQUIRED', 'level changes need a reason');
  await ctx.db.tx(async (q) => {
    const p = await getProvider(q, providerId);
    if (!p) throw new DomainError('NOT_FOUND', 'provider not found');
    await q.query('UPDATE providers SET level = $2, elite_confirmed = ($2 = \'ELITE\'), days_below_threshold = 0 WHERE id = $1', [providerId, level]);
    await q.query('INSERT INTO provider_level_history (provider_id, from_level, to_level, reason, actor) VALUES ($1,$2,$3,$4,$5)', [providerId, p.level, level, reason, actorId(actor)]);
    await audit(q, { actor, action: 'PROVIDER_LEVEL_CHANGED', objectType: 'provider', objectId: p.code, oldValue: p.level, newValue: level, reason, source: ctx.source, important: true });
    await enqueue(q, 'discord.providerNotice', { providerId, text: `Your provider level is now **${level}**.` });
  });
}

// ------------------------------------------------------------------ payout details (encrypted)

export function encrypt(key: Buffer, plaintext: string): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]);
}

export function decrypt(key: Buffer, blob: Buffer): string {
  const d = createDecipheriv('aes-256-gcm', key, blob.subarray(0, 12));
  d.setAuthTag(blob.subarray(12, 28));
  return Buffer.concat([d.update(blob.subarray(28)), d.final()]).toString('utf8');
}

export async function setPayoutDetails(ctx: Ctx, actor: Actor, details: string): Promise<void> {
  if (actor.kind !== 'USER' || !actor.providerId) throw new DomainError('FORBIDDEN', 'only providers set payout details');
  if (!ctx.payoutKey) throw new DomainError('NOT_CONFIGURED', 'payout details are not enabled yet (PAYOUT_ENC_KEY is not set)');
  if (details.trim().length < 5) throw new DomainError('INVALID', 'payout details look too short');
  const blob = encrypt(ctx.payoutKey, details.trim());
  await ctx.db.tx(async (q) => {
    await q.query('UPDATE providers SET payout_details_enc = $2 WHERE id = $1', [actor.providerId, blob]);
    await audit(q, { actor, action: 'PAYOUT_DETAILS_SET', objectType: 'provider', objectId: actor.providerId, source: ctx.source });
  });
}

export async function revealPayoutDetails(ctx: Ctx, actor: Actor, providerId: string, reason: string): Promise<string> {
  authorize(actor, 'provider.revealPayoutDetails');
  if (!ctx.payoutKey) throw new DomainError('NOT_CONFIGURED', 'PAYOUT_ENC_KEY is not set');
  return ctx.db.tx(async (q) => {
    const p = await getProvider(q, providerId);
    if (!p?.payout_details_enc) throw new DomainError('NOT_FOUND', 'no payout details on file');
    await audit(q, { actor, action: 'PAYOUT_DETAILS_REVEALED', objectType: 'provider', objectId: p.code, reason, source: ctx.source, important: true });
    return decrypt(ctx.payoutKey!, p.payout_details_enc);
  });
}

// ------------------------------------------------------------------ views

export async function providerStats(q: Q, providerId: string) {
  const p = await getProvider(q, providerId);
  const rep = await one(q, 'SELECT * FROM provider_reputation WHERE provider_id = $1', [providerId]);
  const counts = await one(
    q,
    `SELECT count(*) FILTER (WHERE status IN ('COMPLETED','EARNING_RELEASED')) AS completed,
            count(*) FILTER (WHERE status IN ('PROVIDER_SELECTED','PROVIDER_CONFIRMED','IN_PROGRESS','DELIVERED')) AS active
     FROM orders WHERE assigned_provider_id = $1`,
    [providerId],
  );
  const bids = await one(
    q,
    `SELECT count(*) AS invites, count(*) FILTER (WHERE response = 'BID') AS bids FROM bid_invitations WHERE provider_id = $1 AND sent_at > now() - interval '30 days'`,
    [providerId],
  );
  const avail = await one(q, 'SELECT state FROM provider_availability WHERE provider_id = $1', [providerId]);
  const caps = await many(
    q,
    `SELECT c.status, g.name AS game, coalesce(s.name, sc.name) AS what, v.name AS version
     FROM provider_capabilities c JOIN games g ON g.id = c.game_id
     LEFT JOIN services s ON s.id = c.service_id LEFT JOIN service_categories sc ON sc.id = c.category_id
     LEFT JOIN game_versions v ON v.id = c.game_version_id
     WHERE c.provider_id = $1 AND c.status IN ('APPROVED','PENDING') ORDER BY g.name, what`,
    [providerId],
  );
  return { provider: p, reputation: rep, completed: Number(counts?.completed ?? 0), active: Number(counts?.active ?? 0), invites30: Number(bids?.invites ?? 0), bids30: Number(bids?.bids ?? 0), availability: avail?.state ?? 'OFFLINE', capabilities: caps };
}

export async function applicationView(q: Q, applicationId: string) {
  const app = await one(q, `SELECT a.*, p.code, p.user_id, d.discord_user_id, d.account_created_at FROM provider_applications a JOIN providers p ON p.id = a.provider_id LEFT JOIN discord_identities d ON d.user_id = p.user_id WHERE a.id = $1`, [applicationId]);
  if (!app) return null;
  const caps = await many(
    q,
    `SELECT c.game_id, g.name AS game, g.code AS game_code, c.status, coalesce(s.name, sc.name || ' (all)') AS what, v.name AS version
     FROM provider_capabilities c JOIN games g ON g.id = c.game_id
     LEFT JOIN services s ON s.id = c.service_id LEFT JOIN service_categories sc ON sc.id = c.category_id
     LEFT JOIN game_versions v ON v.id = c.game_version_id
     WHERE c.application_id = $1 ORDER BY g.name, what`,
    [applicationId],
  );
  return { app, caps };
}
