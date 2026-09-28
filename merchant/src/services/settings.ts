// system_settings with defaults. Executives change these with /settings (audited).
import type { Q } from '../db/pool.js';

export const DEFAULT_SETTINGS = {
  /** Report timezone (Q9). */
  timezone: 'Europe/Madrid',
  currency: 'EUR',
  /** Orders at or above this value (cents) or HIGH risk need a manager (§3). */
  highValueCents: 15000,
  minMargin: 0.15,
  epsilon: 0.1,
  /** Close a bid window early once this many bids are in (0 = never). */
  closeAtBids: 8,
  /** Minutes a selected provider has to confirm (§22). */
  confirmTimeoutMinutes: 15,
  allowBusyBidding: true,
  /** Max invitations per wave when many providers are eligible (§28). */
  inviteWave: 200,
  rulesVersion: '2026-09-28',
  providerRulesVersion: '2026-09-28',
  minAccountAgeDays: 30,
  /** Default marketplace name for manual imports. */
  marketplace: 'marketplace',
  /** Hours before the deadline when an order counts as "at risk". */
  atRiskHours: 2,
  /** Direct-order modes (Q4): B redirect + C convert on, A direct off. */
  directModes: { REDIRECT: true, CONVERT: true, DIRECT: false },
  /** Service ids where LOW-risk orders are assigned automatically (§30 phase 15). Empty = ASSISTED only. */
  autoAssignServices: [] as string[],
  /** Expected-value failure cost as a share of net (§13.4). */
  failureCostShare: 0.5,
};

export type Settings = typeof DEFAULT_SETTINGS;

export async function getSettings(q: Q): Promise<Settings> {
  const r = await q.query<{ key: string; value: unknown }>('SELECT key, value FROM system_settings');
  const out: any = structuredClone(DEFAULT_SETTINGS);
  for (const row of r.rows) if (row.key in out) out[row.key] = row.value;
  return out;
}

export async function setSetting(q: Q, key: keyof Settings, value: unknown, userId: string | null): Promise<unknown> {
  if (!(key in DEFAULT_SETTINGS)) throw new Error(`unknown setting ${String(key)}`);
  const def = (DEFAULT_SETTINGS as any)[key];
  if (typeof def !== typeof value) throw new Error(`${String(key)} must be a ${typeof def}`);
  const old = await q.query('SELECT value FROM system_settings WHERE key = $1', [key]);
  await q.query(
    `INSERT INTO system_settings (key, value, updated_by) VALUES ($1, $2, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [key, JSON.stringify(value), userId],
  );
  return old.rows[0]?.value ?? def;
}
