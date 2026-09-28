#!/usr/bin/env node
// Read-only permission audit of the live server against the security rules in
// docs/ARCHITECTURE.md §2, §3, §6 and §26. Exits 1 if any check fails.
//   node scripts/audit.js
import { parseArgs, setup, run } from '../src/cli.js';
import { fetchLiveState } from '../src/state.js';
import { buildPlan } from '../src/plan.js';
import { fromBits, toBits } from '../src/permissions.js';

const MERCHANT_FORBIDDEN = ['ADMINISTRATOR', 'MANAGE_CHANNELS', 'MANAGE_GUILD', 'BAN_MEMBERS', 'KICK_MEMBERS', 'MANAGE_WEBHOOKS'];
const PUBLIC_CATEGORIES = ['📌 START HERE'];

run(async () => {
  const { values } = parseArgs(process.argv.slice(2));
  const { client, config, guildId } = setup({ configPath: values.config });
  const live = await fetchLiveState(client, guildId);
  const results = [];
  const check = (ok, text) => results.push({ ok, text });
  const role = (name) => live.roles.find((r) => r.name === name);

  for (const r of live.roles) {
    check(!fromBits(r.permissions).includes('ADMINISTRATOR'), `role "${r.name}" has no Administrator`);
  }
  const merchant = role('TheMerchant');
  check(!!merchant, 'TheMerchant role exists');
  if (merchant) {
    const bad = fromBits(merchant.permissions).filter((p) => MERCHANT_FORBIDDEN.includes(p));
    check(!bad.length, `TheMerchant lacks ${MERCHANT_FORBIDDEN.join(', ')}${bad.length ? ` (has ${bad.join(', ')})` : ''}`);
    for (const name of ['Executive', 'Manager', 'Staff']) {
      const r = role(name);
      if (r) check(r.position > merchant.position, `"${name}" sits above TheMerchant, so the bot cannot hand it out`);
    }
  }
  const claude = role('ClaudeBot');
  if (claude) check(claude.position === Math.max(...live.roles.map((r) => r.position)), 'ClaudeBot is the highest role');

  for (const name of ['Provider', ...live.roles.filter((r) => / Provider$/.test(r.name)).map((r) => r.name)]) {
    const r = role(name);
    if (r) check(!r.hoist && !r.color, `"${name}" is not hoisted and has no color (provider privacy, Q2)`);
  }

  const everyoneId = guildId;
  for (const cat of live.channels.filter((c) => c.type === 4)) {
    if (PUBLIC_CATEGORIES.includes(cat.name) || !(config.categories ?? []).some((c) => c.name === cat.name)) continue;
    const kids = live.channels.filter((c) => c.parent_id === cat.id);
    for (const ch of [cat, ...kids]) {
      const ow = (ch.permission_overwrites ?? []).find((o) => o.id === everyoneId);
      const hidden = ow && (BigInt(ow.deny) & toBits(['VIEW_CHANNEL'])) !== 0n;
      check(hidden, `${ch.type === 4 ? 'category' : '#'}${ch.name} is hidden from @everyone`);
    }
  }

  const desks = live.channels.find((c) => c.name === 'provider-desks');
  if (desks) {
    const threadMgrs = (desks.permission_overwrites ?? []).filter((o) => (BigInt(o.allow) & toBits(['MANAGE_THREADS'])) !== 0n)
      .map((o) => live.roles.find((r) => r.id === o.id)?.name ?? o.id);
    check(threadMgrs.every((n) => ['TheMerchant', 'Executive'].includes(n)), `only TheMerchant/Executive manage threads in #provider-desks (${threadMgrs.join(', ') || 'none'})`);
  }
  for (const rooms of live.channels.filter((c) => c.name.endsWith('-order-rooms'))) {
    for (const o of rooms.permission_overwrites ?? []) {
      const name = live.roles.find((r) => r.id === o.id)?.name ?? o.id;
      if (!/ Provider$/.test(name)) continue;
      const allow = BigInt(o.allow);
      const deny = BigInt(o.deny);
      const ok = (allow & toBits(['SEND_MESSAGES', 'MANAGE_THREADS', 'CREATE_PUBLIC_THREADS', 'CREATE_PRIVATE_THREADS'])) === 0n
        && (deny & toBits(['SEND_MESSAGES'])) !== 0n;
      check(ok, `#${rooms.name}: "${name}" can only write inside threads they were added to`);
    }
  }

  const plan = buildPlan(config, live);
  const pending = plan.ops.filter((o) => !o.gate);
  check(!pending.length, `server matches server-config.json (${pending.length} ungated change(s) pending)`);
  check(!plan.manual.length, `no manual steps outstanding${plan.manual.length ? ` (${plan.manual.length})` : ''}`);

  for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.text}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed.`);
  if (failed) process.exitCode = 1;
});
