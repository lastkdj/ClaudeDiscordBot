// Shared setup for integration tests: a fresh schema in a real Postgres.
// TEST_DATABASE_URL defaults to a local database; tests are skipped if it's unreachable.
import pg from 'pg';
import { createDb, type Db } from '../../src/db/pool.js';
import { migrate } from '../../src/db/migrate.js';
import { seed } from '../../src/db/seed.js';
import { silentLogger } from '../../src/logger.js';
import type { Ctx } from '../../src/services/context.js';
import { actorForUser, type DiscordUserRef, ensureUser, setStaffRole } from '../../src/services/users.js';
import type { Actor } from '../../src/core/types.js';

export const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgres://merchant:merchant@localhost:5432/merchant_test';

export async function dbAvailable(): Promise<boolean> {
  const c = new pg.Client({ connectionString: TEST_DB, connectionTimeoutMillis: 2000 });
  try {
    await c.connect();
    await c.end();
    return true;
  } catch {
    return false;
  }
}

export interface Harness {
  db: Db;
  ctx: Ctx;
  clock: { now: Date; advance(ms: number): void };
  close(): Promise<void>;
}

export async function setupHarness(): Promise<Harness> {
  const admin = new pg.Client({ connectionString: TEST_DB });
  await admin.connect();
  await admin.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await admin.end();
  const db = createDb(TEST_DB, { max: 8 });
  await migrate(db);
  await db.tx((q) => seed(q));
  const clock = { now: new Date(), advance(ms: number) { this.now = new Date(this.now.getTime() + ms); } };
  const ctx: Ctx = { db, log: silentLogger, now: () => clock.now, payoutKey: Buffer.alloc(32, 7), source: 'DISCORD' };
  return { db, ctx, clock, close: () => db.close() };
}

let n = 0;
/** A Discord user whose account is old enough to apply as a provider. */
export function discordUser(name: string): DiscordUserRef {
  n++;
  return { id: String(100000000000000000n + BigInt(n) * 1000n), username: name, createdAt: new Date('2020-01-01') };
}

export async function actorOf(db: Db, du: DiscordUserRef): Promise<Actor> {
  const u = await db.tx((q) => ensureUser(q, du));
  return actorForUser(db, u.id);
}

export async function gameId(db: Db, code: string): Promise<string> {
  return (await db.query('SELECT id FROM games WHERE code = $1', [code])).rows[0].id;
}

export async function serviceId(db: Db, game: string, category: string, code: string): Promise<string> {
  return (await db.query(
    `SELECT s.id FROM services s JOIN service_categories c ON c.id = s.category_id JOIN games g ON g.id = c.game_id WHERE g.code = $1 AND c.code = $2 AND s.code = $3`,
    [game, category, code],
  )).rows[0].id;
}

export async function makeStaff(h: Harness, exec: Actor, du: DiscordUserRef, role: 'STAFF' | 'MANAGER' | 'EXECUTIVE', games: string[]): Promise<Actor> {
  await setStaffRole(h.ctx, exec, du, { role, gameIds: games });
  return actorOf(h.db, du);
}

export async function jobs(db: Db, kind: string): Promise<any[]> {
  return (await db.query(`SELECT * FROM jobs WHERE kind = $1 AND status = 'PENDING' ORDER BY id`, [kind])).rows;
}
