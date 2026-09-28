// Postgres-backed job queue that doubles as the transactional outbox (§24):
// enqueue() inside the business transaction; the worker runs jobs after commit
// with retries and exponential backoff. SKIP LOCKED lets several workers share it.
import type { Db, Q } from '../db/pool.js';

export interface EnqueueOptions {
  runAt?: Date;
  /** While a job with this key is pending, further enqueues are ignored (debounce / idempotency). */
  dedupeKey?: string;
  maxAttempts?: number;
}

export async function enqueue(q: Q, kind: string, payload: Record<string, unknown> = {}, opts: EnqueueOptions = {}): Promise<void> {
  await q.query(
    `INSERT INTO jobs (kind, payload, run_at, dedupe_key, max_attempts) VALUES ($1, $2, coalesce($3, now()), $4, $5)
     ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('PENDING','RUNNING') DO NOTHING`,
    [kind, JSON.stringify(payload), opts.runAt ?? null, opts.dedupeKey ?? null, opts.maxAttempts ?? 8],
  );
}

export async function cancelJobs(q: Q, kind: string, match: Record<string, unknown>): Promise<void> {
  await q.query(`UPDATE jobs SET status = 'CANCELLED', finished_at = now() WHERE kind = $1 AND status = 'PENDING' AND payload @> $2::jsonb`, [kind, JSON.stringify(match)]);
}

export interface Job {
  id: string;
  kind: string;
  payload: any;
  attempts: number;
  maxAttempts: number;
}

/** Claims up to `limit` due jobs, leasing them for `leaseSeconds`. */
export async function claimJobs(db: Db, limit = 10, leaseSeconds = 120, kinds?: string[]): Promise<Job[]> {
  const r = await db.query(
    `UPDATE jobs SET status = 'RUNNING', attempts = attempts + 1, locked_until = now() + make_interval(secs => $2)
     WHERE id IN (
       SELECT id FROM jobs
       WHERE ((status = 'PENDING' AND run_at <= now()) OR (status = 'RUNNING' AND locked_until < now()))
         AND ($3::text[] IS NULL OR kind = ANY($3))
       ORDER BY run_at, id LIMIT $1 FOR UPDATE SKIP LOCKED)
     RETURNING id, kind, payload, attempts, max_attempts`,
    [limit, leaseSeconds, kinds ?? null],
  );
  return r.rows.map((x) => ({ id: String(x.id), kind: x.kind, payload: x.payload, attempts: x.attempts, maxAttempts: x.max_attempts }));
}

export async function completeJob(db: Db, id: string): Promise<void> {
  await db.query(`UPDATE jobs SET status = 'DONE', finished_at = now(), locked_until = NULL WHERE id = $1`, [id]);
}

/** Retries with backoff (5s, 10s, 20s ... capped at 30 min) until max_attempts, then FAILED. */
export async function failJob(db: Db, job: Job, error: string, retryAfterMs?: number): Promise<'RETRY' | 'FAILED'> {
  if (job.attempts >= job.maxAttempts) {
    await db.query(`UPDATE jobs SET status = 'FAILED', last_error = $2, finished_at = now(), locked_until = NULL WHERE id = $1`, [job.id, error.slice(0, 2000)]);
    return 'FAILED';
  }
  const delay = retryAfterMs ?? Math.min(30 * 60_000, 5000 * 2 ** (job.attempts - 1));
  await db.query(`UPDATE jobs SET status = 'PENDING', last_error = $2, run_at = now() + make_interval(secs => $3), locked_until = NULL WHERE id = $1`, [job.id, error.slice(0, 2000), delay / 1000]);
  return 'RETRY';
}
