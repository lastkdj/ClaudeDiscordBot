// Applies src/db/migrations/*.sql in order, once each, inside a transaction.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, type Db } from './pool.js';

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

export async function migrate(db: Db, log: (m: string) => void = () => {}): Promise<string[]> {
  await db.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const done = new Set((await db.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  const applied: string[] = [];
  for (const file of readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(file)) continue;
    const sql = readFileSync(join(DIR, file), 'utf8');
    await db.tx(async (q) => {
      await q.query('SELECT pg_advisory_xact_lock(727274)');
      if ((await q.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file])).rowCount) return;
      await q.query(sql);
      await q.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      applied.push(file);
      log(`applied ${file}`);
    });
  }
  return applied;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { loadConfig } = await import('../config.js');
  const cfg = loadConfig({ requireDiscord: false });
  const db = createDb(cfg.databaseUrl, { ssl: cfg.databaseSsl, ca: cfg.databaseCa });
  const applied = await migrate(db, console.log);
  console.log(applied.length ? `${applied.length} migration(s) applied` : 'database is up to date');
  await db.close();
}
