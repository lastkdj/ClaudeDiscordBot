// Postgres access: a pool, a transaction helper, and a tiny query interface
// that services use for both pooled and transactional work.
import pg from 'pg';

export interface Q {
  query<R extends pg.QueryResultRow = any>(text: string, params?: unknown[]): Promise<pg.QueryResult<R>>;
}

export interface Db extends Q {
  pool: pg.Pool;
  tx<T>(fn: (q: Q) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export function createDb(connectionString: string, opts: { max?: number; ssl?: boolean; ca?: string | null } = {}): Db {
  const pool = new pg.Pool({
    connectionString,
    max: opts.max ?? 10,
    // Certificates are always verified; pass Supabase's CA via DATABASE_SSL_CA.
    ssl: opts.ssl ? { rejectUnauthorized: true, ...(opts.ca ? { ca: opts.ca } : {}) } : undefined,
    application_name: 'themerchant',
  });
  return {
    pool,
    query: (text, params) => pool.query(text, params as any[]),
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await fn({ query: (t, p) => client.query(t, p as any[]) });
        await client.query('COMMIT');
        return out;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

/** Returns the single row or null. */
export async function one<R extends pg.QueryResultRow = any>(q: Q, text: string, params?: unknown[]): Promise<R | null> {
  const r = await q.query<R>(text, params);
  return r.rows[0] ?? null;
}

export async function many<R extends pg.QueryResultRow = any>(q: Q, text: string, params?: unknown[]): Promise<R[]> {
  return (await q.query<R>(text, params)).rows;
}
