// Component custom_ids carry only a verb and opaque ids (§24). The server
// reloads state from the database on every click and never trusts client data.
export const VERBS = [
  // panels
  'welcome.customer', 'welcome.provider', 'rules.accept', 'apply.start', 'apply.games', 'apply.cats', 'apply.submit', 'apply.cancel',
  'panel.availability', 'panel.balance', 'panel.stats', 'panel.caps', 'panel.payoutDetails', 'panel.payout', 'panel.moreCaps',
  'ticket.open', 'ticket.close', 'quote.open', 'quote.game', 'quote.cat', 'quote.service', 'quote.send', 'quote.close',
  // applications
  'app.approve', 'app.reject',
  // bidding (provider desk)
  'bid.open', 'bid.decline', 'bid.withdraw', 'assign.confirm', 'assign.decline',
  // order post (staff)
  'order.close', 'order.assignRec', 'order.pick', 'order.reopen', 'order.cancel', 'order.paid', 'order.delivered', 'order.failed',
  'order.complete', 'order.escalate', 'order.forward', 'order.refresh', 'order.import',
  // order room
  'room.start', 'room.deliver', 'room.issue',
  // finance
  'payout.approve', 'payout.paid', 'payout.reject',
] as const;
export type Verb = (typeof VERBS)[number];

const SEP = '|';

export function cid(verb: Verb, ...args: (string | number)[]): string {
  const s = ['tm', verb, ...args.map(String)].join(SEP);
  if (s.length > 100) throw new Error(`custom_id too long: ${verb}`);
  return s;
}

/** Modal ids reuse the scheme with a "m:" verb prefix. */
export function mid(verb: Verb, ...args: (string | number)[]): string {
  return cid(verb, ...args).replace(/^tm\|/, 'tm|m:');
}

export function parseCid(id: string): { verb: Verb; modal: boolean; args: string[] } | null {
  const parts = id.split(SEP);
  if (parts[0] !== 'tm' || parts.length < 2) return null;
  const modal = parts[1]!.startsWith('m:');
  const verb = (modal ? parts[1]!.slice(2) : parts[1]) as Verb;
  if (!VERBS.includes(verb)) return null;
  return { verb, modal, args: parts.slice(2) };
}
