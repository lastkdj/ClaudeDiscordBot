// Provider isolation at the presentation layer (§6): provider-facing messages
// never include price, commission, margin, customer identity or other bids.
import { describe, expect, it } from 'vitest';
import * as V from '../../src/discord-ui/views.js';
import { parseCid, cid, mid } from '../../src/discord-ui/ids.js';
import { dueSlots } from '../../src/worker/schedule.js';
import { periodRange } from '../../src/services/reports.js';

const po = { id: '6f1c2c4e-1111-4a4a-8888-123456789abc', code: 'TM-00018421', game: 'World of Warcraft', version: 'Retail', service: 'Mythic+ key (timed)', quantity: '1', deadlineAt: new Date('2026-09-28T20:00:00Z'), requirements: ['Region (EU/US)', 'Realm and faction'], windowEndsAt: new Date('2026-09-28T10:30:00Z'), currency: 'EUR' };
const json = (p: V.Payload) => JSON.stringify({ content: p.content, embeds: p.embeds.map((e) => e.toJSON()), components: p.components.map((c) => c.toJSON()) });

describe('provider views', () => {
  it('bid invitation shows no customer money or bids', () => {
    const s = json(V.bidInvite(po));
    expect(s).toContain('TM-00018421');
    expect(s).not.toMatch(/€|60\.00|commission|margin|customer price|buyer/i);
  });
  it('order room brief carries requirements only', () => {
    const s = json(V.orderRoomBrief({ ...po, configuration: { region: 'EU', character: 'Aria' }, providerCode: 'P-184', staffMention: null }));
    expect(s).toContain('Aria');
    expect(s).not.toMatch(/€|price|commission|profit/i);
    expect(s).toMatch(/Never post or ask for account passwords/);
  });
  it('selection notice shows only the provider\'s own bid', () => {
    const s = json(V.selectionNotice({ ...po, assignmentId: 'a1', bid: 2900, confirmBy: new Date() }));
    expect(s).toContain('€29.00');
    expect(s).not.toMatch(/60\.00|profit|commission/);
  });
});

describe('custom ids', () => {
  it('round-trip and stay under 100 characters', () => {
    const id = cid('order.assignRec', po.id, po.id);
    expect(id.length).toBeLessThanOrEqual(100);
    expect(parseCid(id)).toEqual({ verb: 'order.assignRec', modal: false, args: [po.id, po.id] });
    expect(parseCid(mid('bid.open', po.id))).toEqual({ verb: 'bid.open', modal: true, args: [po.id] });
    expect(parseCid('tm|evil.verb|x')).toBeNull();
    expect(parseCid('something-else')).toBeNull();
  });
});

describe('schedule and report periods (Europe/Madrid)', () => {
  const tz = 'Europe/Madrid';
  it('queues the daily report from 08:00 local, weekly on Mondays, monthly on the 1st', () => {
    const before = dueSlots(new Date('2026-06-01T05:59:00Z'), tz).map((s) => s.key); // 07:59 CEST, Monday the 1st
    const after = dueSlots(new Date('2026-06-01T06:11:00Z'), tz).map((s) => s.key); // 08:11 CEST
    expect(before.some((k) => k.startsWith('report:'))).toBe(false);
    expect(after).toEqual(expect.arrayContaining(['report:daily:2026-06-01', 'report:weekly:2026-06-01', 'report:monthly:2026-06-01']));
  });
  it('computes local-midnight ranges across DST', () => {
    const d = periodRange('daily', new Date('2026-10-26T07:00:00Z'), tz); // day after the October DST change
    expect(d.from.toISOString()).toBe('2026-10-24T22:00:00.000Z');
    expect(d.to.toISOString()).toBe('2026-10-25T23:00:00.000Z');
    const w = periodRange('weekly', new Date('2026-09-30T10:00:00Z'), tz); // Wednesday
    expect(w.from.toISOString()).toBe('2026-09-20T22:00:00.000Z'); // Mon 21 Sep 00:00 CEST
    expect(w.to.toISOString()).toBe('2026-09-27T22:00:00.000Z');
    const m = periodRange('monthly', new Date('2026-10-01T09:00:00Z'), tz);
    expect(m.from.toISOString()).toBe('2026-08-31T22:00:00.000Z');
    expect(m.label).toContain('September 2026');
  });
});
