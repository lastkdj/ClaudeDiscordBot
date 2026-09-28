// Generic signed-webhook adapter. Until the real marketplace is chosen (Q8), any
// marketplace (or a small relay/Zapier-style bridge) can post this format:
//
//   POST /webhooks/<MARKETPLACE_NAME>
//   X-Timestamp: <unix seconds>
//   X-Signature: sha256=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>
//   { "events": [ { "id": "evt_1", "type": "ORDER_CREATED", "occurred_at": "2026-09-28T10:00:00Z",
//                   "order_id": "928173", "order": { ...ExternalOrder JSON... } } ] }
//
// Money is sent as decimal strings ("60.00"). See test/fixtures/generic-*.json.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { parseMoney } from '../core/money.js';
import type { ExternalOrder, MarketplaceAdapter, MarketplaceEvent, MarketplaceEventType } from './types.js';

const Money = z.union([z.string(), z.number()]).transform((v) => parseMoney(v));
const OrderSchema = z.object({
  id: z.string().min(1),
  listing_id: z.string().nullish(),
  buyer: z.string().nullish(),
  price: Money,
  commission: Money.nullish(),
  currency: z.string().length(3).default('EUR'),
  quantity: z.number().positive().default(1),
  deadline_at: z.string().datetime({ offset: true }).nullish(),
  fields: z.record(z.string(), z.string()).default({}),
  note: z.string().nullish(),
  paid: z.boolean().default(false),
  status: z.enum(['OPEN', 'COMPLETED', 'CANCELLED', 'REFUNDED', 'DISPUTED']).default('OPEN'),
  updated_at: z.string().datetime({ offset: true }),
});
const TYPES = ['ORDER_CREATED', 'PAYMENT_CONFIRMED', 'CUSTOMER_MESSAGE', 'ORDER_UPDATED', 'ORDER_CANCELLED', 'REFUND', 'DISPUTE_OPENED', 'DISPUTE_RESOLVED', 'ORDER_COMPLETED'] as const;
const EventSchema = z.object({
  id: z.string().min(1).optional(),
  type: z.enum(TYPES),
  occurred_at: z.string().datetime({ offset: true }),
  order_id: z.string().min(1),
  order: OrderSchema.optional(),
  message: z.string().max(4000).optional(),
  refund: z.object({ amount: Money, reference: z.string(), reason: z.string().default(''), full: z.boolean().default(false) }).optional(),
  dispute: z.object({ reason: z.string().default(''), outcome: z.enum(['BUYER', 'SELLER']).optional() }).optional(),
  rating: z.number().int().min(1).max(5).nullish(),
});
const BodySchema = z.union([z.object({ events: z.array(EventSchema).min(1).max(100) }), EventSchema]);

export function toExternalOrder(o: z.infer<typeof OrderSchema>): ExternalOrder {
  return {
    externalOrderId: o.id,
    listingId: o.listing_id ?? null,
    buyer: o.buyer ?? null,
    price: o.price,
    commission: o.commission ?? null,
    currency: o.currency.toUpperCase(),
    quantity: o.quantity,
    deadlineAt: o.deadline_at ? new Date(o.deadline_at) : null,
    fields: o.fields,
    note: o.note ?? null,
    paid: o.paid,
    status: o.status,
    updatedAt: new Date(o.updated_at),
  };
}

export interface GenericOptions {
  name: string;
  secret: string;
  apiBase?: string | null;
  apiKey?: string | null;
  /** Replay window for signatures (default 5 minutes, §26). */
  toleranceSeconds?: number;
  fetchImpl?: typeof fetch;
}

export class GenericWebhookAdapter implements MarketplaceAdapter {
  readonly name: string;
  readonly capabilities;
  constructor(private readonly o: GenericOptions) {
    this.name = o.name;
    const api = !!(o.apiBase && o.apiKey);
    this.capabilities = { webhooks: true, pullOrders: api, markDelivered: api, sendMessage: api, commissionInPayload: true };
  }

  verifyWebhook(headers: Record<string, string | string[] | undefined>, rawBody: Buffer, now = new Date()): boolean {
    const h = (k: string) => {
      const v = headers[k] ?? headers[k.toLowerCase()];
      return Array.isArray(v) ? v[0] : v;
    };
    const ts = Number(h('x-timestamp'));
    const sig = h('x-signature')?.replace(/^sha256=/, '') ?? '';
    if (!Number.isFinite(ts) || Math.abs(now.getTime() / 1000 - ts) > (this.o.toleranceSeconds ?? 300)) return false;
    const expected = createHmac('sha256', this.o.secret).update(`${ts}.`).update(rawBody).digest();
    const given = Buffer.from(sig, 'hex');
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  normalize(body: unknown): MarketplaceEvent[] {
    const parsed = BodySchema.parse(body);
    const events = 'events' in parsed ? parsed.events : [parsed];
    return events.map((e) => ({
      type: e.type as MarketplaceEventType,
      // No event id from the sender: hash the event so retries of the same payload dedupe.
      eventId: e.id ?? createHash('sha256').update(JSON.stringify(e)).digest('hex').slice(0, 32),
      occurredAt: new Date(e.occurred_at),
      externalOrderId: e.order_id,
      order: e.order ? toExternalOrder(e.order) : undefined,
      message: e.message,
      refund: e.refund,
      dispute: e.dispute,
      rating: e.rating ?? null,
    }));
  }

  private async call(method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<any> {
    if (!this.o.apiBase || !this.o.apiKey) throw new Error(`${this.name}: API access is not configured`);
    const res = await (this.o.fetchImpl ?? fetch)(`${this.o.apiBase.replace(/\/$/, '')}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.o.apiKey}`, 'Content-Type': 'application/json', ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${this.name}: ${method} ${path} -> ${res.status}`);
    return res.status === 204 ? null : res.json();
  }

  async fetchOrder(id: string): Promise<ExternalOrder> {
    return toExternalOrder(OrderSchema.parse(await this.call('GET', `/orders/${encodeURIComponent(id)}`)));
  }

  async listOrdersSince(since: Date): Promise<ExternalOrder[]> {
    const r = await this.call('GET', `/orders?updated_since=${encodeURIComponent(since.toISOString())}`);
    return z.array(OrderSchema).parse(r.orders ?? r).map(toExternalOrder);
  }

  async markDelivered(id: string, note: string, idempotencyKey: string): Promise<void> {
    await this.call('POST', `/orders/${encodeURIComponent(id)}/deliver`, { note }, idempotencyKey);
  }

  async sendCustomerMessage(id: string, text: string): Promise<void> {
    await this.call('POST', `/orders/${encodeURIComponent(id)}/messages`, { text });
  }
}

/** Signs a body the way senders must (used by tests and the local simulator). */
export function signGeneric(secret: string, rawBody: string, ts = Math.floor(Date.now() / 1000)): Record<string, string> {
  return { 'x-timestamp': String(ts), 'x-signature': `sha256=${createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex')}` };
}
