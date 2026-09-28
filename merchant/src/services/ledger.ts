// Provider ledger & payouts (ARCHITECTURE §19). Entries are only inserted, and
// the provider_balances cache is updated in the same transaction.
import { authorize } from '../core/authz.js';
import * as L from '../core/ledger.js';
import { type Cents, fromDecimalString, parseMoney, toDecimalString } from '../core/money.js';
import { type Actor, actorId, DomainError } from '../core/types.js';
import { many, one, type Q } from '../db/pool.js';
import { audit } from './audit.js';
import type { Ctx } from './context.js';
import { enqueue } from './jobs.js';

export async function postEntries(q: Q, providerId: string, entries: L.LedgerEntryDraft[], actor: Actor, currency = 'EUR'): Promise<string[]> {
  if (!entries.length) return [];
  // Serialize writers per provider so the cache never races.
  await q.query('INSERT INTO provider_balances (provider_id) VALUES ($1) ON CONFLICT DO NOTHING', [providerId]);
  const cur = await one(q, 'SELECT * FROM provider_balances WHERE provider_id = $1 FOR UPDATE', [providerId]);
  const ids: string[] = [];
  for (const e of entries) {
    const r = await one(
      q,
      `INSERT INTO provider_ledger_entries (provider_id, entry_type, bucket, amount, currency, order_id, payout_id, reverses_entry_id, memo, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [providerId, e.entryType, e.bucket, toDecimalString(e.amount), currency, e.orderId ?? null, e.payoutId ?? null, e.reversesEntryId ?? null, e.memo, actorId(actor)],
    );
    ids.push(String(r!.id));
  }
  const next = L.applyEntries(toBalances(cur), entries);
  await q.query(
    `UPDATE provider_balances SET pending = $2, available = $3, reserved = $4, paid = $5, lifetime = $6, updated_at = now() WHERE provider_id = $1`,
    [providerId, toDecimalString(next.pending), toDecimalString(next.available), toDecimalString(next.reserved), toDecimalString(next.paid), toDecimalString(next.lifetime)],
  );
  return ids;
}

const toBalances = (r: any): L.Balances =>
  r ? { pending: fromDecimalString(r.pending), available: fromDecimalString(r.available), reserved: fromDecimalString(r.reserved), paid: fromDecimalString(r.paid), lifetime: fromDecimalString(r.lifetime) } : L.ZERO_BALANCES;

export async function balances(q: Q, providerId: string): Promise<L.Balances> {
  return toBalances(await one(q, 'SELECT * FROM provider_balances WHERE provider_id = $1', [providerId]));
}

/** Recomputes balances from the entries. */
export async function balancesFromLedger(q: Q, providerId: string): Promise<L.Balances> {
  const rows = await many(q, 'SELECT entry_type, bucket, amount FROM provider_ledger_entries WHERE provider_id = $1', [providerId]);
  return L.balancesFrom(rows.map((r) => ({ entryType: r.entry_type, bucket: r.bucket, amount: fromDecimalString(r.amount) })));
}

/** Nightly check: cache == sum of entries for every provider; alerts on mismatch. */
export async function reconcileBalances(ctx: Ctx): Promise<{ checked: number; mismatches: string[] }> {
  const providers = await many(ctx.db, 'SELECT DISTINCT provider_id FROM provider_ledger_entries');
  const mismatches: string[] = [];
  for (const p of providers) {
    const [cache, truth] = [await balances(ctx.db, p.provider_id), await balancesFromLedger(ctx.db, p.provider_id)];
    if (!L.balancesEqual(cache, truth)) mismatches.push(p.provider_id);
  }
  if (mismatches.length) {
    await enqueue(ctx.db, 'discord.alert', { channel: 'system-alerts', text: `Ledger reconciliation: balance cache differs from entries for ${mismatches.length} provider(s): ${mismatches.join(', ')}` });
  }
  return { checked: providers.length, mismatches };
}

export async function ledgerHistory(q: Q, providerId: string, limit = 10) {
  return many(q, `SELECT l.*, o.internal_order_id FROM provider_ledger_entries l LEFT JOIN orders o ON o.id = l.order_id WHERE provider_id = $1 ORDER BY id DESC LIMIT $2`, [providerId, limit]);
}

// ------------------------------------------------------------------ payouts

export async function requestPayout(ctx: Ctx, actor: Actor, providerId: string, amountText: string, method: string): Promise<string> {
  authorize(actor, 'payout.request', { providerId });
  const amount = parseMoney(amountText);
  return ctx.db.tx(async (q) => {
    const p = await one(q, 'SELECT status, payout_details_enc FROM providers WHERE id = $1', [providerId]);
    if (!p || p.status === 'SUSPENDED') throw new DomainError('FORBIDDEN', 'payouts are frozen while suspended');
    if (!p.payout_details_enc) throw new DomainError('MISSING_DETAILS', 'add your payout details first ([My balance] → Payout details)');
    const pending = await one(q, `SELECT 1 FROM provider_payouts WHERE provider_id = $1 AND status IN ('REQUESTED','APPROVED')`, [providerId]);
    if (pending) throw new DomainError('CONFLICT', 'you already have a payout in progress');
    await q.query('INSERT INTO provider_balances (provider_id) VALUES ($1) ON CONFLICT DO NOTHING', [providerId]);
    const bal = toBalances(await one(q, 'SELECT * FROM provider_balances WHERE provider_id = $1 FOR UPDATE', [providerId]));
    const payout = await one(q, `INSERT INTO provider_payouts (provider_id, amount, status, method) VALUES ($1,$2,'REQUESTED',$3) RETURNING id`, [providerId, toDecimalString(amount), method]);
    await postEntries(q, providerId, L.payoutRequestEntries(payout!.id, amount, bal), actor);
    await audit(q, { actor, action: 'PAYOUT_REQUESTED', objectType: 'payout', objectId: payout!.id, newValue: { amount: toDecimalString(amount), method }, source: ctx.source, important: true });
    await enqueue(q, 'discord.payoutPost', { payoutId: payout!.id });
    return payout!.id as string;
  });
}

export async function decidePayout(ctx: Ctx, actor: Actor, payoutId: string, decision: 'APPROVE' | 'REJECT' | 'PAID', externalRef?: string | null, reason?: string | null): Promise<void> {
  authorize(actor, 'payout.approve');
  await ctx.db.tx(async (q) => {
    const p = await one(q, 'SELECT * FROM provider_payouts WHERE id = $1 FOR UPDATE', [payoutId]);
    if (!p) throw new DomainError('NOT_FOUND', 'payout not found');
    const amount: Cents = fromDecimalString(p.amount);
    if (decision === 'APPROVE') {
      if (p.status !== 'REQUESTED') throw new DomainError('INVALID_STATE', `payout is ${p.status}`);
      await q.query(`UPDATE provider_payouts SET status = 'APPROVED', approved_by = $2, approved_at = now() WHERE id = $1`, [payoutId, actorId(actor)]);
    } else if (decision === 'PAID') {
      if (p.status !== 'APPROVED') throw new DomainError('INVALID_STATE', 'approve the payout before marking it paid');
      if (!externalRef) throw new DomainError('REASON_REQUIRED', 'enter the transfer reference');
      await q.query(`UPDATE provider_payouts SET status = 'PAID', paid_at = now(), external_ref = $2 WHERE id = $1`, [payoutId, externalRef]);
      await postEntries(q, p.provider_id, L.payoutPaidEntries(payoutId, amount), actor);
      await enqueue(q, 'discord.providerNotice', { providerId: p.provider_id, text: `💸 Payout of ${toDecimalString(amount)} ${p.currency} sent (ref ${externalRef}).` });
    } else {
      if (!['REQUESTED', 'APPROVED'].includes(p.status)) throw new DomainError('INVALID_STATE', `payout is ${p.status}`);
      if (!reason) throw new DomainError('REASON_REQUIRED', 'rejections need a reason');
      await q.query(`UPDATE provider_payouts SET status = 'REJECTED', approved_by = $2, approved_at = now() WHERE id = $1`, [payoutId, actorId(actor)]);
      await postEntries(q, p.provider_id, L.payoutCancelEntries(payoutId, amount), actor);
      await enqueue(q, 'discord.providerNotice', { providerId: p.provider_id, text: `Your payout request of ${toDecimalString(amount)} ${p.currency} was not approved: ${reason}` });
    }
    await audit(q, { actor, action: `PAYOUT_${decision === 'APPROVE' ? 'APPROVED' : decision === 'PAID' ? 'PAID' : 'REJECTED'}`, objectType: 'payout', objectId: payoutId, oldValue: p.status, newValue: { externalRef }, reason, source: ctx.source, important: true });
    await enqueue(q, 'discord.payoutPost', { payoutId });
  });
}

export async function adjustBalance(ctx: Ctx, actor: Actor, providerId: string, type: 'ADJUSTMENT' | 'BONUS' | 'CORRECTION', amountText: string, memo: string): Promise<void> {
  authorize(actor, 'ledger.adjust');
  const amount = parseMoney(amountText);
  await ctx.db.tx(async (q) => {
    await postEntries(q, providerId, L.adjustmentEntries(type, amount, memo), actor);
    await audit(q, { actor, action: 'BALANCE_ADJUSTED', objectType: 'provider', objectId: providerId, newValue: { type, amount: toDecimalString(amount) }, reason: memo, source: ctx.source, important: true });
    await enqueue(q, 'discord.providerNotice', { providerId, text: `Your balance was adjusted by ${toDecimalString(amount)} (${type.toLowerCase()}): ${memo}` });
  });
}
