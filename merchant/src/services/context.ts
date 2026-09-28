// What every service function receives. Services own transactions; the
// Discord, HTTP and worker layers only call them.
import type { Db } from '../db/pool.js';
import type { Logger } from '../logger.js';

export interface Ctx {
  db: Db;
  log: Logger;
  now: () => Date;
  /** 32-byte key for payout details (AES-256-GCM), or null if not configured. */
  payoutKey: Buffer | null;
  /** Source recorded in the audit log for actions in this context. */
  source: 'DISCORD' | 'WEBHOOK' | 'JOB' | 'CLI';
}
