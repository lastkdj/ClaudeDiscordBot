// HTTP: POST /webhooks/:marketplace and GET /health (§7, §26).
// Verify signature + timestamp, store the event once, queue processing, reply fast.
import Fastify, { type FastifyInstance } from 'fastify';
import type { MarketplaceAdapter } from '../marketplace/types.js';
import type { Ctx } from '../services/context.js';
import { receiveEvents } from '../services/intake.js';
import { enqueue } from '../services/jobs.js';

export interface ApiDeps {
  ctx: Ctx;
  adapter: MarketplaceAdapter;
  /** Reports whether the Discord gateway is connected (for /health). */
  discordReady?: () => boolean;
  /** Requests per minute per IP on the webhook route. */
  rateLimit?: number;
}

export function buildApi(deps: ApiDeps): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 256 * 1024, trustProxy: true });
  const hits = new Map<string, { n: number; reset: number }>();
  const limit = deps.rateLimit ?? 120;

  // Keep the raw body: the signature is over the exact bytes.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  app.get('/health', async (_req, reply) => {
    try {
      await deps.ctx.db.query('SELECT 1');
      const discord = deps.discordReady ? deps.discordReady() : null;
      return reply.code(discord === false ? 503 : 200).send({ ok: discord !== false, db: true, discord });
    } catch {
      return reply.code(503).send({ ok: false, db: false });
    }
  });

  app.post<{ Params: { marketplace: string } }>('/webhooks/:marketplace', async (req, reply) => {
    const now = deps.ctx.now().getTime();
    const key = req.ip;
    const h = hits.get(key);
    if (!h || h.reset < now) hits.set(key, { n: 1, reset: now + 60_000 });
    else if (++h.n > limit) return reply.code(429).send({ error: 'rate limited' });

    if (req.params.marketplace !== deps.adapter.name || !deps.adapter.capabilities.webhooks) return reply.code(404).send({ error: 'unknown marketplace' });
    const raw = req.body as Buffer;
    if (!Buffer.isBuffer(raw)) return reply.code(415).send({ error: 'send application/json' });
    if (!deps.adapter.verifyWebhook(req.headers as Record<string, string>, raw, new Date(now))) {
      await enqueue(deps.ctx.db, 'discord.alert', { channel: 'system-alerts', text: `🔐 Rejected a webhook with a bad signature or timestamp from ${req.ip}.` }, { dedupeKey: `badsig:${Math.floor(now / 600_000)}` });
      return reply.code(401).send({ error: 'invalid signature' });
    }
    let body: unknown;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      return reply.code(400).send({ error: 'invalid JSON' });
    }
    let events;
    try {
      events = deps.adapter.normalize(body);
    } catch (err) {
      return reply.code(422).send({ error: 'unrecognized payload', detail: (err as Error).message.slice(0, 500) });
    }
    const r = await receiveEvents({ ...deps.ctx, source: 'WEBHOOK' }, deps.adapter.name, events, body);
    return reply.code(200).send({ ok: true, ...r });
  });

  return app;
}
