// Seeds the catalog and scoring configurations. Idempotent: existing rows keep
// any edits (only missing rows are inserted).
import { fileURLToPath } from 'node:url';
import { DEFAULT_PARAMS, DEFAULT_WEIGHTS } from '../core/scoring.js';
import { SCORING_PROFILES } from '../core/types.js';
import { createDb, type Q } from './pool.js';
import { SEED } from './seed-data.js';

export async function seed(q: Q): Promise<{ games: number; services: number }> {
  let services = 0;
  for (const g of SEED) {
    const game = (await q.query(
      `INSERT INTO games (code, name, emoji) VALUES ($1, $2, $3)
       ON CONFLICT (code) DO UPDATE SET code = EXCLUDED.code RETURNING id`,
      [g.code, g.name, g.emoji],
    )).rows[0];
    for (const [i, [code, name]] of g.versions.entries()) {
      await q.query(`INSERT INTO game_versions (game_id, code, name, sort) VALUES ($1, $2, $3, $4) ON CONFLICT (game_id, code) DO NOTHING`, [game.id, code, name, i]);
    }
    for (const [ci, c] of g.categories.entries()) {
      const cat = (await q.query(
        `INSERT INTO service_categories (game_id, code, name, sort) VALUES ($1, $2, $3, $4)
         ON CONFLICT (game_id, code) DO UPDATE SET code = EXCLUDED.code RETURNING id`,
        [game.id, c.code, c.name, ci],
      )).rows[0];
      for (const s of c.services ?? []) {
        const r = await q.query(
          `INSERT INTO services (category_id, code, name, kind, pricing_unit, scoring_profile, risk_tier, trial_eligible, bid_window_seconds, hold_days, requirement_schema)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (category_id, code) DO NOTHING`,
          [cat.id, s.code, s.name, s.kind ?? 'SERVICE', s.pricingUnit ?? 'fixed', s.profile ?? 'DEFAULT', s.risk ?? 'MEDIUM', !!s.trial, s.windowSec ?? 1200, s.holdDays ?? 3, JSON.stringify(g.requirements)],
        );
        services += r.rowCount ?? 0;
      }
    }
  }
  for (const profile of SCORING_PROFILES) {
    await q.query(
      `INSERT INTO scoring_configurations (profile, version, weights, params, active) VALUES ($1, 1, $2, $3, true) ON CONFLICT (profile, version) DO NOTHING`,
      [profile, JSON.stringify(DEFAULT_WEIGHTS[profile]), JSON.stringify(DEFAULT_PARAMS)],
    );
  }
  return { games: SEED.length, services };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { loadConfig } = await import('../config.js');
  const cfg = loadConfig({ requireDiscord: false });
  const db = createDb(cfg.databaseUrl, { ssl: cfg.databaseSsl });
  const r = await db.tx((q) => seed(q));
  console.log(`catalog seeded: ${r.games} games, ${r.services} new services`);
  await db.close();
}
