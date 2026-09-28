// Contract tests for the generic marketplace adapter (§25).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GenericWebhookAdapter, signGeneric } from '../../src/marketplace/generic.js';

const fixture = readFileSync(new URL('../fixtures/generic-order-created.json', import.meta.url), 'utf8');
const adapter = new GenericWebhookAdapter({ name: 'mp', secret: 'test-secret-123' });

describe('generic adapter', () => {
  it('accepts a correct signature within the replay window', () => {
    const now = new Date('2026-09-28T10:00:30Z');
    const headers = signGeneric('test-secret-123', fixture, Math.floor(now.getTime() / 1000) - 30);
    expect(adapter.verifyWebhook(headers, Buffer.from(fixture), now)).toBe(true);
  });
  it('rejects tampered bodies, wrong secrets and replays', () => {
    const now = new Date('2026-09-28T10:00:30Z');
    const ts = Math.floor(now.getTime() / 1000);
    expect(adapter.verifyWebhook(signGeneric('test-secret-123', fixture, ts), Buffer.from(fixture.replace('60.00', '1.00')), now)).toBe(false);
    expect(adapter.verifyWebhook(signGeneric('other-secret', fixture, ts), Buffer.from(fixture), now)).toBe(false);
    expect(adapter.verifyWebhook(signGeneric('test-secret-123', fixture, ts - 600), Buffer.from(fixture), now)).toBe(false);
    expect(adapter.verifyWebhook({}, Buffer.from(fixture), now)).toBe(false);
  });
  it('normalizes events into integer cents and dates', () => {
    const [e] = adapter.normalize(JSON.parse(fixture));
    expect(e).toMatchObject({ type: 'ORDER_CREATED', eventId: 'evt_1001', externalOrderId: 'MP-5001' });
    expect(e!.order).toMatchObject({ price: 6000, commission: 600, listingId: 'LST-MPLUS-10', paid: true, currency: 'EUR' });
    expect(e!.order!.deadlineAt?.toISOString()).toBe('2026-09-28T20:00:00.000Z');
  });
  it('derives a stable id when the sender has none, and rejects junk', () => {
    const e = { type: 'ORDER_COMPLETED', occurred_at: '2026-09-28T12:00:00Z', order_id: 'MP-1' };
    expect(adapter.normalize(e)[0]!.eventId).toBe(adapter.normalize({ ...e })[0]!.eventId);
    expect(() => adapter.normalize({ type: 'NOPE' })).toThrow();
    expect(() => adapter.normalize({ events: [{ ...e, order: { id: 'x', price: 'abc', updated_at: 'now' } }] })).toThrow();
  });
});
