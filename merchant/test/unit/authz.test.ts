// Table-driven authorization tests generated from ARCHITECTURE §3.
// Rows: action. Columns: EXECUTIVE, MANAGER (own game), MANAGER (other game),
// STAFF (own game), STAFF (other game), PROVIDER (own record), PROVIDER (other), CUSTOMER.
import { describe, expect, it } from 'vitest';
import { type Action, ACTIONS, can, decide } from '../../src/core/authz.js';
import type { Actor } from '../../src/core/types.js';

type Col = 'EXEC' | 'MGR' | 'MGR_X' | 'STAFF' | 'STAFF_X' | 'PROV' | 'PROV_X' | 'CUST';
const COLS: Col[] = ['EXEC', 'MGR', 'MGR_X', 'STAFF', 'STAFF_X', 'PROV', 'PROV_X', 'CUST'];

const actor = (col: Col): Actor => {
  const base = { kind: 'USER' as const, userId: 'u', status: 'ACTIVE' as const, staffGameIds: [] as string[], managerGameIds: [] as string[], providerId: null as string | null };
  switch (col) {
    case 'EXEC': return { ...base, orgRole: 'EXECUTIVE' };
    case 'MGR': return { ...base, orgRole: 'MANAGER', managerGameIds: ['wow'], approvalLimit: 50000 };
    case 'MGR_X': return { ...base, orgRole: 'MANAGER', managerGameIds: ['albion'] };
    case 'STAFF': return { ...base, orgRole: 'STAFF', staffGameIds: ['wow'] };
    case 'STAFF_X': return { ...base, orgRole: 'STAFF', staffGameIds: ['albion'] };
    case 'PROV': return { ...base, orgRole: 'PROVIDER', providerId: 'p1' };
    case 'PROV_X': return { ...base, orgRole: 'PROVIDER', providerId: 'p2' };
    case 'CUST': return { ...base, orgRole: 'CUSTOMER' };
  }
};

// Resource: a WoW order worth €60, MEDIUM risk, assigned to provider p1.
const RES = { gameId: 'wow', providerId: 'p1', valueCents: 6000, riskTier: 'MEDIUM' as const };

//                             EXEC MGR MGR_X STAFF STAFF_X PROV PROV_X CUST
const MATRIX: Record<Action, string> = {
  'order.view':               '1    1   0     1     0       1    0      0',
  'order.viewFinancials':     '1    1   0     1     0       0    0      0',
  'order.viewBids':           '1    1   0     1     0       0    0      0',
  'order.import':             '1    1   0     1     0       0    0      0',
  'order.classify':           '1    1   0     1     0       0    0      0',
  'order.note':               '1    1   0     1     0       0    0      0',
  'order.assign':             '1    1   0     1     0       0    0      0',
  'order.override':           '1    1   0     1     0       0    0      0',
  'order.approveHighValue':   '1    1   0     0     0       0    0      0',
  'order.editPrice':          '1    1   0     0     0       0    0      0',
  'order.cancel':             '1    1   0     0     0       0    0      0',
  'order.refund':             '1    1   0     0     0       0    0      0',
  'order.requestCancel':      '1    1   0     1     0       0    0      0',
  'order.work':               '1    1   0     1     0       1    0      0',
  'order.markFailed':         '1    1   0     1     0       0    0      0',
  'order.recordCompletion':   '1    1   0     1     0       0    0      0',
  'order.reopenBidding':      '1    1   0     1     0       0    0      0',
  'bid.submit':               '0    0   0     0     0       1    0      0',
  'provider.review':          '1    1   0     0     0       0    0      0',
  'provider.changeLevel':     '1    0   0     0     0       0    0      0',
  'provider.suspend':         '1    1   0     0     0       0    0      0',
  'provider.viewBalance':     '1    0   0     0     0       1    0      0',
  'provider.viewStats':       '1    1   0     0     0       1    0      0',
  'provider.revealPayoutDetails': '1 0  0     0     0       0    0      0',
  'payout.request':           '0    0   0     0     0       1    0      0',
  'payout.approve':           '1    0   0     0     0       0    0      0',
  'ledger.adjust':            '1    0   0     0     0       0    0      0',
  'report.executive':         '1    0   0     0     0       0    0      0',
  'audit.view':               '1    0   0     0     0       0    0      0',
  'dashboard.game':           '1    1   0     0     0       0    0      0',
  'ticket.open':              '1    0   0     0     0       1    1      1',
  'ticket.handle':            '1    1   0     1     0       0    0      0',
  'quote.request':            '1    0   0     0     0       1    1      1',
  'quote.send':               '1    1   0     1     0       0    0      0',
  'settings.manage':          '1    0   0     0     0       0    0      0',
  'staff.manage':             '1    0   0     0     0       0    0      0',
  'catalog.manage':           '1    0   0     0     0       0    0      0',
};

describe('authorization matrix (§3)', () => {
  it('covers every action', () => {
    expect(Object.keys(MATRIX).sort()).toEqual([...ACTIONS].sort());
  });
  for (const action of ACTIONS) {
    const row = MATRIX[action].split(/\s+/).map((x) => x === '1');
    for (const [i, col] of COLS.entries()) {
      it(`${action} × ${col} → ${row[i] ? 'allow' : 'deny'}`, () => {
        expect(can(actor(col), action, RES), decide(actor(col), action, RES).reason).toBe(row[i]);
      });
    }
  }
});

describe('thresholds, overrides and account status', () => {
  it('staff cannot assign high-value or HIGH-risk orders', () => {
    expect(can(actor('STAFF'), 'order.assign', { ...RES, valueCents: 20000 })).toBe(false);
    expect(can(actor('STAFF'), 'order.assign', { ...RES, riskTier: 'HIGH' })).toBe(false);
    expect(can(actor('MGR'), 'order.assign', { ...RES, valueCents: 20000 })).toBe(true);
  });
  it('managers approve only within their limit', () => {
    expect(can(actor('MGR'), 'order.approveHighValue', { ...RES, valueCents: 60000 })).toBe(false);
  });
  it('explicit overrides elevate, per game', () => {
    const s = { ...actor('STAFF'), overrides: ['order.refund@wow'] } as Actor;
    expect(can(s, 'order.refund', RES)).toBe(true);
    expect(can(s, 'order.refund', { ...RES, gameId: 'albion' })).toBe(false);
  });
  it('suspended users can do nothing', () => {
    expect(can({ ...actor('EXEC'), status: 'SUSPENDED' } as Actor, 'order.view', RES)).toBe(false);
  });
  it('a provider can never read another provider\'s anything', () => {
    for (const a of ['provider.viewBalance', 'provider.viewStats', 'order.view', 'order.work', 'payout.request', 'bid.submit'] as Action[]) {
      expect(can(actor('PROV_X'), a, RES)).toBe(false);
    }
  });
});
