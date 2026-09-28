import { formatMoney } from '../core/money.js';
import type { OrderStatus } from '../core/order-state.js';

export const money = (cents: number | null | undefined, currency = 'EUR') => (cents == null ? '—' : formatMoney(cents, currency));
export const ts = (d: Date | string | null | undefined, style: 'R' | 'f' | 't' | 'd' = 'f') => (d ? `<t:${Math.floor(new Date(d).getTime() / 1000)}:${style}>` : '—');
export const pct = (x: number | null | undefined, digits = 1) => (x == null || !Number.isFinite(x) ? '—' : `${(x * 100).toFixed(digits)}%`);
export const mins = (m: number) => (m >= 120 ? `${Math.round(m / 60)} h` : `${m} min`);
export const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export const STATUS_EMOJI: Record<OrderStatus, string> = {
  QUOTE_REQUESTED: '💬', RECEIVED: '📥', VALIDATED: '✔️', PROCUREMENT: '🧾', BIDDING: '🪙', BID_REVIEW: '⚖️',
  PROVIDER_SELECTED: '⏳', PROVIDER_CONFIRMED: '🤝', IN_PROGRESS: '⚙️', DELIVERED: '📦', MARKETPLACE_COMPLETION: '🏁',
  COMPLETED: '✅', EARNING_RELEASED: '💸', REASSIGNMENT_REQUIRED: '↩️', PROVIDER_FAILED: '❌', MANUAL_REVIEW: '🔎',
  DISPUTED: '⚖️', CANCELLED: '🛑', REFUNDED: '↩️', PARTIAL_REFUND: '↩️',
};

export const COLORS = { info: 0x3498db, ok: 0x2ecc71, warn: 0xf1c40f, bad: 0xe74c3c, neutral: 0x95a5a6, money: 0x9b59b6 };

/** Monospace table for embeds (keeps columns aligned). */
export function table(header: string[], rows: string[][]): string {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[]) => cells.map((c, i) => (c ?? '').padEnd(widths[i]!)).join('  ').trimEnd();
  return '```\n' + [line(header), ...rows.map(line)].join('\n') + '\n```';
}
