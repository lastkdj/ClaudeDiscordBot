// Direct orders (§8) and support tickets. Direct requests become quotes; the
// order itself still comes through the marketplace (REDIRECT / CONVERT). Mode
// DIRECT stays off until the marketplace's seller terms are checked (Q4).
import { authorize } from '../core/authz.js';
import { parseMoney, toDecimalString } from '../core/money.js';
import { type Actor, actorId, DomainError } from '../core/types.js';
import { one, type Q } from '../db/pool.js';
import { audit } from './audit.js';
import { getService } from './catalog.js';
import type { Ctx } from './context.js';
import { enqueue } from './jobs.js';
import { getSettings } from './settings.js';

export async function requestQuote(ctx: Ctx, actor: Actor, input: { serviceId: string; versionId?: string | null; spec: Record<string, string> }): Promise<{ id: string; code: string }> {
  authorize(actor, 'quote.request');
  return ctx.db.tx(async (q) => {
    const service = await getService(q, input.serviceId);
    if (!service) throw new DomainError('NOT_FOUND', 'unknown service');
    const open = await one(q, `SELECT count(*)::int AS n FROM quotes WHERE customer_user_id = $1 AND status IN ('REQUESTED','QUOTED')`, [actorId(actor)]);
    if (open!.n >= 3) throw new DomainError('RATE_LIMITED', 'you already have 3 open quote requests');
    const r = await one(
      q,
      `INSERT INTO quotes (customer_user_id, game_id, game_version_id, service_id, spec) VALUES ($1,$2,$3,$4,$5) RETURNING id, code`,
      [actorId(actor), service.game_id, input.versionId ?? null, service.id, JSON.stringify(input.spec)],
    );
    await audit(q, { actor, action: 'QUOTE_REQUESTED', objectType: 'quote', objectId: r!.code, newValue: { service: service.name }, source: ctx.source });
    await enqueue(q, 'discord.quoteThread', { quoteId: r!.id });
    return { id: r!.id as string, code: r!.code as string };
  });
}

export async function sendQuote(ctx: Ctx, actor: Actor, quoteId: string, input: { price: string; mode: 'REDIRECT' | 'CONVERT' | 'DIRECT'; listingUrl?: string | null }): Promise<void> {
  await ctx.db.tx(async (q) => {
    const quote = await one(q, 'SELECT q.*, g.direct_orders_enabled FROM quotes q JOIN games g ON g.id = q.game_id WHERE q.id = $1 FOR UPDATE', [quoteId]);
    if (!quote) throw new DomainError('NOT_FOUND', 'quote not found');
    authorize(actor, 'quote.send', { gameId: quote.game_id });
    const s = await getSettings(q);
    if (!s.directModes[input.mode]) throw new DomainError('DISABLED', `mode ${input.mode} is turned off`);
    if (input.mode === 'DIRECT' && !quote.direct_orders_enabled) throw new DomainError('DISABLED', 'direct orders are disabled for this game');
    if (input.mode === 'REDIRECT' && !input.listingUrl) throw new DomainError('INVALID', 'add the marketplace listing link');
    if (input.listingUrl && !/^https:\/\//.test(input.listingUrl)) throw new DomainError('INVALID', 'the listing link must start with https://');
    const price = parseMoney(input.price);
    if (price <= 0) throw new DomainError('INVALID_AMOUNT', 'price must be positive');
    await q.query(`UPDATE quotes SET quoted_price = $2, mode = $3, listing_url = $4, status = 'QUOTED' WHERE id = $1`, [quoteId, toDecimalString(price), input.mode, input.listingUrl ?? null]);
    await audit(q, { actor, action: 'QUOTE_SENT', objectType: 'quote', objectId: quote.code, newValue: { price: toDecimalString(price), mode: input.mode }, source: ctx.source });
    await enqueue(q, 'discord.quoteThread', { quoteId });
  });
}

export async function closeQuote(ctx: Ctx, actor: Actor, quoteId: string): Promise<void> {
  await ctx.db.tx(async (q) => {
    const quote = await one(q, 'SELECT * FROM quotes WHERE id = $1 FOR UPDATE', [quoteId]);
    if (!quote) throw new DomainError('NOT_FOUND', 'quote not found');
    if (quote.customer_user_id !== actorId(actor)) authorize(actor, 'quote.send', { gameId: quote.game_id });
    await q.query(`UPDATE quotes SET status = 'CLOSED' WHERE id = $1`, [quoteId]);
    await enqueue(q, 'discord.archiveThread', { threadId: quote.thread_id });
  });
}

export const getQuote = (q: Q, id: string) =>
  one(q, `SELECT q.*, s.name AS service_name, g.name AS game_name, v.name AS version_name FROM quotes q JOIN services s ON s.id = q.service_id JOIN games g ON g.id = q.game_id LEFT JOIN game_versions v ON v.id = q.game_version_id WHERE q.id = $1`, [id]);

// ------------------------------------------------------------------ tickets

export async function openTicket(ctx: Ctx, actor: Actor, input: { subject: string; gameId?: string | null }): Promise<{ id: string; code: string }> {
  authorize(actor, 'ticket.open');
  if (!input.subject || input.subject.trim().length < 3) throw new DomainError('INVALID', 'add a short subject');
  return ctx.db.tx(async (q) => {
    const open = await one(q, `SELECT count(*)::int AS n FROM tickets WHERE opener_user_id = $1 AND status = 'OPEN'`, [actorId(actor)]);
    if (open!.n >= 3) throw new DomainError('RATE_LIMITED', 'you already have 3 open tickets');
    const r = await one(q, `INSERT INTO tickets (opener_user_id, game_id, subject) VALUES ($1,$2,$3) RETURNING id, code`, [actorId(actor), input.gameId ?? null, input.subject.trim().slice(0, 200)]);
    await enqueue(q, 'discord.ticketThread', { ticketId: r!.id });
    return { id: r!.id as string, code: r!.code as string };
  });
}

export async function closeTicket(ctx: Ctx, actor: Actor, ticketId: string): Promise<void> {
  await ctx.db.tx(async (q) => {
    const t = await one(q, 'SELECT * FROM tickets WHERE id = $1 FOR UPDATE', [ticketId]);
    if (!t) throw new DomainError('NOT_FOUND', 'ticket not found');
    if (t.opener_user_id !== actorId(actor)) authorize(actor, 'ticket.handle', { gameId: t.game_id });
    await q.query(`UPDATE tickets SET status = 'CLOSED', closed_at = now() WHERE id = $1`, [ticketId]);
    await enqueue(q, 'discord.archiveThread', { threadId: t.thread_id });
  });
}
