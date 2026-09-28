// Money is handled as integer minor units (cents). Floats never hold amounts.
// Postgres stores NUMERIC(14,2); the db layer converts at the boundary.

export type Cents = number;

const MAX = Number.MAX_SAFE_INTEGER;

export function assertCents(v: number, what = 'amount'): Cents {
  if (!Number.isSafeInteger(v)) throw new RangeError(`${what} must be an integer number of cents, got ${v}`);
  return v;
}

/** Parses "29", "29.5", "29.50", "-3.10", "1,234.56" (commas as thousands) or "29,50" (comma decimal). */
export function parseMoney(input: string | number): Cents {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new RangeError('amount must be finite');
    return parseMoney(input.toFixed(2));
  }
  let s = input.trim().replace(/[€$£\s]/g, '');
  if (/^-?\d+,\d{1,2}$/.test(s)) s = s.replace(',', '.');
  else s = s.replace(/,/g, '');
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) throw new RangeError(`"${input}" is not a valid amount`);
  const cents = Number(m[2]) * 100 + Number((m[3] ?? '').padEnd(2, '0') || 0);
  if (cents > MAX) throw new RangeError('amount too large');
  return m[1] ? -cents : cents;
}

/** "29.00" — the NUMERIC(14,2) string form used in SQL. */
export function toDecimalString(c: Cents): string {
  assertCents(c);
  const sign = c < 0 ? '-' : '';
  const a = Math.abs(c);
  return `${sign}${Math.trunc(a / 100)}.${String(a % 100).padStart(2, '0')}`;
}

/** Parses a NUMERIC string coming back from Postgres. */
export function fromDecimalString(s: string | null | undefined): Cents {
  if (s == null) return 0;
  return parseMoney(s);
}

const SYMBOLS: Record<string, string> = { EUR: '€', USD: '$', GBP: '£' };

export function formatMoney(c: Cents, currency = 'EUR'): string {
  const sym = SYMBOLS[currency];
  const body = toDecimalString(Math.abs(c));
  const [int, dec] = body.split('.');
  const grouped = int!.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const text = sym ? `${sym}${grouped}.${dec}` : `${grouped}.${dec} ${currency}`;
  return c < 0 ? `-${text}` : text;
}

/** Multiplies an amount by a rate with banker's (half-even) rounding to whole cents. */
export function applyRate(amount: Cents, rate: number): Cents {
  assertCents(amount);
  // Work in 1e-6 cent units to avoid binary drift on typical rates like 0.1 or 0.075.
  const scaled = Math.round(amount * rate * 1e6);
  const whole = Math.trunc(scaled / 1e6);
  const rem = Math.abs(scaled - whole * 1e6);
  if (rem < 5e5) return whole;
  if (rem > 5e5) return whole + Math.sign(scaled);
  return whole % 2 === 0 ? whole : whole + Math.sign(scaled);
}

export function sum(values: Cents[]): Cents {
  return values.reduce((a, b) => a + b, 0);
}
