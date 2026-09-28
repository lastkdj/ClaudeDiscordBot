// Runs the bot, webhook API and worker in one process by default (§24);
// RUN_BOT / RUN_API / RUN_WORKER split them across processes.
import { buildApi } from './api/server.js';
import { startBot } from './bot/index.js';
import { loadConfig } from './config.js';
import { migrate } from './db/migrate.js';
import { createDb } from './db/pool.js';
import { seed } from './db/seed.js';
import { createLogger } from './logger.js';
import { createAdapter } from './marketplace/index.js';
import type { Ctx } from './services/context.js';
import { registerBusinessJobs } from './worker/business-jobs.js';
import { JobRunner } from './worker/runner.js';
import { enqueueDue } from './worker/schedule.js';

const cfg = loadConfig({ requireDiscord: true });
const log = createLogger(cfg.logLevel, cfg.secrets);
const db = createDb(cfg.databaseUrl, { ssl: cfg.databaseSsl });
const ctx: Ctx = { db, log, now: () => new Date(), payoutKey: cfg.payoutKey, source: 'JOB' };

await migrate(db, (m) => log.info(m));
await db.tx((q) => seed(q));
if (!cfg.payoutKey) log.warn('PAYOUT_ENC_KEY is not set: providers cannot save payout details until it is.');

const adapter = createAdapter(cfg);
const runner = cfg.run.worker ? new JobRunner(ctx, log) : null;
if (runner) registerBusinessJobs(runner, ctx, adapter);

const bot = cfg.run.bot ? await startBot(cfg, ctx, log, runner) : null;

let scheduleTimer: NodeJS.Timeout | null = null;
if (runner) {
  // Discord effect handlers register once the bot is ready; the runner only claims kinds it can handle.
  runner.start(1000);
  const tick = () => enqueueDue(ctx).catch((err) => log.error({ err: err.message }, 'schedule failed'));
  await tick();
  scheduleTimer = setInterval(tick, 30_000);
}

const api = cfg.run.api ? buildApi({ ctx, adapter, discordReady: bot ? bot.ready : undefined }) : null;
if (api) {
  await api.listen({ port: cfg.port, host: '0.0.0.0' });
  log.info({ port: cfg.port, marketplace: adapter.name, webhooks: adapter.capabilities.webhooks }, 'API listening');
}

async function shutdown(signal: string) {
  log.info({ signal }, 'shutting down');
  if (scheduleTimer) clearInterval(scheduleTimer);
  runner?.stop();
  await api?.close();
  await bot?.stop();
  await db.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
