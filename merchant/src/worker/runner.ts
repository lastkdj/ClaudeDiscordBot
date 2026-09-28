// Runs jobs from the Postgres queue with retries/backoff (§24).
import type { Logger } from '../logger.js';
import type { Ctx } from '../services/context.js';
import { claimJobs, completeJob, failJob, type Job } from '../services/jobs.js';

export type Handler = (payload: any, job: Job) => Promise<unknown>;

export class JobRunner {
  private handlers = new Map<string, Handler>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;

  constructor(private readonly ctx: Ctx, private readonly log: Logger) {}

  register(kind: string, handler: Handler): this {
    this.handlers.set(kind, handler);
    return this;
  }

  kinds(): string[] {
    return [...this.handlers.keys()];
  }

  /** Runs every due job this process can handle; returns how many ran. */
  async drain(max = 50): Promise<number> {
    let ran = 0;
    while (ran < max) {
      const batch = await claimJobs(this.ctx.db, 10, 120, this.kinds());
      if (!batch.length) break;
      for (const job of batch) {
        ran++;
        await this.runOne(job);
      }
    }
    return ran;
  }

  private async runOne(job: Job): Promise<void> {
    const handler = this.handlers.get(job.kind)!;
    try {
      const result = await handler(job.payload, job);
      await completeJob(this.ctx.db, job.id);
      this.log.debug({ job: job.kind, id: job.id, result }, 'job done');
    } catch (err) {
      const e = err as Error & { retryAfterMs?: number; permanent?: boolean };
      const outcome = await failJob(this.ctx.db, e.permanent ? { ...job, attempts: job.maxAttempts } : job, e.message ?? String(err), e.retryAfterMs);
      this.log.warn({ job: job.kind, id: job.id, attempt: job.attempts, outcome, err: e.message }, 'job failed');
    }
  }

  start(intervalMs = 1000): void {
    const tick = async () => {
      if (this.running || this.stopped) return;
      this.running = true;
      try {
        await this.drain();
      } catch (err) {
        this.log.error({ err: (err as Error).message }, 'job loop error');
      } finally {
        this.running = false;
        if (!this.stopped) this.timer = setTimeout(tick, intervalMs);
      }
    };
    this.timer = setTimeout(tick, 0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }
}
