// Recurring work (§20, §21, §25, §15, §19), in the report timezone (Q9).
import type { Ctx } from '../services/context.js';
import { enqueue } from '../services/jobs.js';
import { getSettings } from '../services/settings.js';

interface Slot { key: string; kind: string; payload?: Record<string, unknown> }

function localParts(now: Date, tz: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' }).formatToParts(now).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, day: Number(p.day), hour: Number(p.hour), minute: Number(p.minute), weekday: p.weekday as string };
}

/** Which scheduled runs are due at `now` (each has a unique key per period). */
export function dueSlots(now: Date, tz: string): Slot[] {
  const t = localParts(now, tz);
  const slots: Slot[] = [];
  const at = (h: number, m: number) => t.hour > h || (t.hour === h && t.minute >= m);
  if (at(8, 0)) slots.push({ key: `report:daily:${t.date}`, kind: 'reports.post', payload: { period: 'daily' } });
  if (at(8, 5) && t.weekday === 'Mon') slots.push({ key: `report:weekly:${t.date}`, kind: 'reports.post', payload: { period: 'weekly' } });
  if (at(8, 10) && t.day === 1) slots.push({ key: `report:monthly:${t.date}`, kind: 'reports.post', payload: { period: 'monthly' } });
  if (at(3, 30)) slots.push({ key: `reputation:nightly:${t.date}`, kind: 'reputation.nightly' });
  if (at(4, 0)) slots.push({ key: `ledger:reconcile:${t.date}`, kind: 'ledger.reconcile' });
  const quarter = Math.floor(t.minute / 15);
  slots.push({ key: `marketplace:reconcile:${t.date}T${t.hour}:${quarter}`, kind: 'marketplace.reconcile' });
  slots.push({ key: `dashboards:${t.date}T${t.hour}:${t.minute}`, kind: 'dashboards.refreshAll' });
  slots.push({ key: `roles:reconcile:${t.date}T${t.hour}`, kind: 'discord.reconcileRoles' });
  return slots;
}

export async function enqueueDue(ctx: Ctx): Promise<number> {
  const s = await getSettings(ctx.db);
  let n = 0;
  for (const slot of dueSlots(ctx.now(), s.timezone)) {
    const r = await ctx.db.query('INSERT INTO schedule_runs (key) VALUES ($1) ON CONFLICT DO NOTHING', [slot.key]);
    if (!r.rowCount) continue;
    await enqueue(ctx.db, slot.kind, slot.payload ?? {});
    n++;
  }
  // Keys include the local date, so rows older than a few days can never match again.
  await ctx.db.query(`DELETE FROM schedule_runs WHERE queued_at < now() - interval '3 days'`);
  return n;
}
