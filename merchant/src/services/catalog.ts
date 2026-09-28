// Game / service catalog (ARCHITECTURE §4). Everything is data: adding a game is
// rows here plus one ClaudeBot config block, with no code change.
import { authorize } from '../core/authz.js';
import { parseMoney, toDecimalString } from '../core/money.js';
import { type Actor, DomainError, type RiskTier, type ScoringProfile } from '../core/types.js';
import { many, one, type Q } from '../db/pool.js';
import { audit } from './audit.js';
import type { Ctx } from './context.js';

export interface Game { id: string; code: string; name: string; emoji: string | null; short_name: string; channel_prefix: string; active: boolean; direct_orders_enabled: boolean }
export interface GameVersion { id: string; game_id: string; code: string; name: string }
export interface Category { id: string; game_id: string; code: string; name: string }
export interface Requirement { key: string; label: string; required: boolean }
export interface Service {
  id: string; category_id: string; game_id: string; code: string; name: string; kind: 'SERVICE' | 'CURRENCY';
  pricing_unit: string; scoring_profile: ScoringProfile; risk_tier: RiskTier; trial_eligible: boolean;
  bid_window_seconds: number; hold_days: number; bid_ceiling: string | null; requirement_schema: Requirement[]; active: boolean;
  category_name: string;
}
export interface Binding {
  game_id: string; orders_forum_id: string | null; order_rooms_channel_id: string | null; dashboard_channel_id: string | null;
  dashboard_message_id: string | null; ops_channel_id: string | null; team_role_id: string | null; provider_role_id: string | null;
}

export const listGames = (q: Q, all = false) => many<Game>(q, `SELECT * FROM games ${all ? '' : 'WHERE active'} ORDER BY name`);
export const getGame = (q: Q, id: string) => one<Game>(q, 'SELECT * FROM games WHERE id = $1', [id]);
export const getGameByCode = (q: Q, code: string) => one<Game>(q, 'SELECT * FROM games WHERE code = $1', [code]);
export const listVersions = (q: Q, gameId: string) => many<GameVersion>(q, 'SELECT * FROM game_versions WHERE game_id = $1 AND active ORDER BY sort, name', [gameId]);
export const listCategories = (q: Q, gameId: string) => many<Category>(q, 'SELECT * FROM service_categories WHERE game_id = $1 AND active ORDER BY sort, name', [gameId]);

const SERVICE_SQL = `SELECT s.*, c.game_id, c.name AS category_name FROM services s JOIN service_categories c ON c.id = s.category_id`;
export const listServices = (q: Q, categoryId: string) => many<Service>(q, `${SERVICE_SQL} WHERE s.category_id = $1 AND s.active ORDER BY s.name`, [categoryId]);
export const listGameServices = (q: Q, gameId: string) => many<Service>(q, `${SERVICE_SQL} WHERE c.game_id = $1 AND s.active ORDER BY c.sort, s.name`, [gameId]);
export const getService = (q: Q, id: string) => one<Service>(q, `${SERVICE_SQL} WHERE s.id = $1`, [id]);
export const getVersion = (q: Q, id: string) => one<GameVersion>(q, 'SELECT * FROM game_versions WHERE id = $1', [id]);

export const getBinding = (q: Q, gameId: string) => one<Binding>(q, 'SELECT * FROM discord_bindings WHERE game_id = $1', [gameId]);
export const listBindings = (q: Q) => many<Binding & { code: string; name: string }>(q, 'SELECT b.*, g.code, g.name FROM discord_bindings b JOIN games g ON g.id = b.game_id');

export async function upsertBinding(q: Q, gameId: string, b: Partial<Omit<Binding, 'game_id'>>): Promise<void> {
  const cols = Object.keys(b) as (keyof typeof b)[];
  if (!cols.length) return;
  await q.query(
    `INSERT INTO discord_bindings (game_id, ${cols.join(', ')}) VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')})
     ON CONFLICT (game_id) DO UPDATE SET ${cols.map((c) => `${c} = EXCLUDED.${c}`).join(', ')}`,
    [gameId, ...cols.map((c) => b[c] ?? null)],
  );
}

/** Validates an order configuration against the service's requirement schema. */
export function validateConfiguration(service: Pick<Service, 'requirement_schema' | 'name'>, config: Record<string, unknown>): string[] {
  const missing: string[] = [];
  for (const r of service.requirement_schema ?? []) {
    const v = config[r.key];
    if (r.required && (v == null || String(v).trim() === '')) missing.push(r.label);
  }
  return missing;
}

/** Resolves a marketplace listing to a service/version (§7 classification). */
export async function classifyListing(q: Q, marketplace: string, listingId: string | null | undefined) {
  if (!listingId) return null;
  return one<{ service_id: string; game_version_id: string | null; quantity_rule: any }>(
    q,
    'SELECT service_id, game_version_id, quantity_rule FROM marketplace_listing_map WHERE marketplace = $1 AND external_listing_id = $2',
    [marketplace, listingId],
  );
}

// ------------------------------------------------------------ management (executives)

export async function mapListing(ctx: Ctx, actor: Actor, input: { marketplace: string; listingId: string; serviceId: string; versionId?: string | null }): Promise<void> {
  authorize(actor, 'catalog.manage');
  await ctx.db.tx(async (q) => {
    if (!(await getService(q, input.serviceId))) throw new DomainError('NOT_FOUND', 'unknown service');
    await q.query(
      `INSERT INTO marketplace_listing_map (marketplace, external_listing_id, service_id, game_version_id) VALUES ($1,$2,$3,$4)
       ON CONFLICT (marketplace, external_listing_id) DO UPDATE SET service_id = EXCLUDED.service_id, game_version_id = EXCLUDED.game_version_id`,
      [input.marketplace, input.listingId, input.serviceId, input.versionId ?? null],
    );
    await audit(q, { actor, action: 'LISTING_MAPPED', objectType: 'listing', objectId: `${input.marketplace}:${input.listingId}`, newValue: input, source: ctx.source });
  });
}

export async function setFeeRule(ctx: Ctx, actor: Actor, input: { marketplace: string; rate: number; gameId?: string | null; serviceId?: string | null }): Promise<void> {
  authorize(actor, 'catalog.manage');
  if (!(input.rate >= 0 && input.rate < 1)) throw new DomainError('INVALID', 'rate must be between 0 and 1 (e.g. 0.1 for 10%)');
  await ctx.db.tx(async (q) => {
    await q.query(
      `UPDATE marketplace_fee_rules SET valid_to = now() WHERE marketplace = $1 AND game_id IS NOT DISTINCT FROM $2 AND service_id IS NOT DISTINCT FROM $3 AND valid_to IS NULL`,
      [input.marketplace, input.gameId ?? null, input.serviceId ?? null],
    );
    await q.query(`INSERT INTO marketplace_fee_rules (marketplace, game_id, service_id, rate) VALUES ($1,$2,$3,$4)`, [input.marketplace, input.gameId ?? null, input.serviceId ?? null, input.rate]);
    await audit(q, { actor, action: 'FEE_RULE_SET', objectType: 'fee_rule', objectId: input.marketplace, newValue: input, source: ctx.source, important: true });
  });
}

export async function updateService(
  ctx: Ctx,
  actor: Actor,
  serviceId: string,
  patch: { risk_tier?: RiskTier; scoring_profile?: ScoringProfile; trial_eligible?: boolean; bid_window_seconds?: number; hold_days?: number; bid_ceiling?: string | null; active?: boolean },
): Promise<void> {
  authorize(actor, 'catalog.manage');
  await ctx.db.tx(async (q) => {
    const old = await getService(q, serviceId);
    if (!old) throw new DomainError('NOT_FOUND', 'unknown service');
    const p: Record<string, unknown> = { ...patch };
    if (patch.bid_ceiling !== undefined) p.bid_ceiling = patch.bid_ceiling == null ? null : toDecimalString(parseMoney(patch.bid_ceiling));
    const cols = Object.keys(p);
    if (!cols.length) return;
    await q.query(`UPDATE services SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE id = $1`, [serviceId, ...cols.map((c) => p[c])]);
    await audit(q, { actor, action: 'SERVICE_UPDATED', objectType: 'service', objectId: serviceId, oldValue: Object.fromEntries(cols.map((c) => [c, (old as any)[c]])), newValue: p, source: ctx.source });
  });
}

export async function addService(
  ctx: Ctx,
  actor: Actor,
  input: { categoryId: string; code: string; name: string; kind: 'SERVICE' | 'CURRENCY'; profile: ScoringProfile; risk: RiskTier; trial?: boolean },
): Promise<string> {
  authorize(actor, 'catalog.manage');
  return ctx.db.tx(async (q) => {
    const cat = await one(q, `SELECT c.id, g.id AS game_id FROM service_categories c JOIN games g ON g.id = c.game_id WHERE c.id = $1`, [input.categoryId]);
    if (!cat) throw new DomainError('NOT_FOUND', 'unknown category');
    const reqs = await one(q, `SELECT s.requirement_schema FROM services s JOIN service_categories c ON c.id = s.category_id WHERE c.game_id = $1 LIMIT 1`, [cat.game_id]);
    const r = await one(
      q,
      `INSERT INTO services (category_id, code, name, kind, scoring_profile, risk_tier, trial_eligible, pricing_unit, requirement_schema)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [input.categoryId, input.code, input.name, input.kind, input.profile, input.risk, !!input.trial, input.kind === 'CURRENCY' ? 'per_1M' : 'fixed', JSON.stringify(reqs?.requirement_schema ?? [])],
    );
    await audit(q, { actor, action: 'SERVICE_ADDED', objectType: 'service', objectId: r!.id, newValue: input, source: ctx.source });
    return r!.id as string;
  });
}
