import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan } from '../src/plan.js';
import { fetchLiveState } from '../src/state.js';
import { validateConfig } from '../src/config.js';
import { createClient } from '../src/client.js';
import { createFakeDiscord, GUILD_ID } from './fake-discord.js';

const config = () => ({
  guildId: GUILD_ID,
  roles: [
    { name: 'Admin', color: '#e74c3c', hoist: true, mentionable: false, permissions: ['KICK_MEMBERS', 'BAN_MEMBERS', 'MANAGE_MESSAGES'] },
    { name: 'Mod', color: '#3498db', hoist: true, mentionable: true, permissions: ['KICK_MEMBERS', 'MANAGE_MESSAGES', 'MODERATE_MEMBERS'] },
    { name: 'Member', color: '#2ecc71', permissions: ['VIEW_CHANNEL', 'SEND_MESSAGES'] },
  ],
  categories: [
    {
      name: 'Info',
      overwrites: [{ role: '@everyone', allow: ['VIEW_CHANNEL'], deny: ['SEND_MESSAGES'] }],
      channels: [
        { name: 'rules', topic: 'Read me first' },
        { name: 'welcome' },
      ],
    },
    {
      name: 'Community',
      overwrites: [],
      channels: [
        { name: 'general', topic: 'Chat about anything', slowmode: 5 },
        { name: 'Lounge', type: 'voice', userLimit: 10 },
      ],
    },
    {
      name: 'Staff',
      overwrites: [
        { role: '@everyone', deny: ['VIEW_CHANNEL'] },
        { role: 'Mod', allow: ['VIEW_CHANNEL'] },
      ],
      channels: [{ name: 'mod-chat' }],
    },
  ],
});

async function plan(client, cfg) {
  return buildPlan(cfg, await fetchLiveState(client, GUILD_ID));
}

async function apply(client, p, flags = new Set()) {
  const live = await fetchLiveState(client, GUILD_ID);
  const ctx = { client, guildId: GUILD_ID, botTop: live.botTop, botRoleIds: live.botMember.roles, reason: 'test', roleIds: new Map(p.seed.roleIds), ids: new Map(p.seed.ids) };
  for (const op of p.ops) {
    if (op.gate && !flags.has(op.gate)) continue;
    await op.run(ctx);
  }
}

test('dry run plans creates, a move, and gated deletes without calling write endpoints', async () => {
  const client = createFakeDiscord();
  const p = await plan(client, config());
  assert.ok(client.calls.every((c) => c.method === 'GET'));
  const labels = p.ops.map((o) => `${o.action} ${o.label}`);
  assert.ok(labels.includes('create role "Admin"'));
  assert.ok(labels.includes('create category "Staff"'));
  assert.ok(labels.some((l) => l.startsWith('update text channel "general"')), 'existing #general is moved, not recreated');
  const deletes = p.ops.filter((o) => o.action === 'delete');
  assert.deepEqual(deletes.map((o) => o.label).sort(), ['category "Text Channels"', 'category "Voice Channels"', 'voice channel "General" in "Voice Channels"']);
  assert.ok(deletes.every((o) => o.gate === 'prune'));
});

test('apply converges: a second plan has only gated ops left, and prune clears them', async () => {
  const client = createFakeDiscord();
  await apply(client, await plan(client, config()));
  const second = await plan(client, config());
  assert.deepEqual(second.ops.filter((o) => !o.gate).map((o) => o.label), []);
  assert.equal(second.ops.filter((o) => o.gate).length, 3);

  await apply(client, second, new Set(['prune']));
  const third = await plan(client, config());
  assert.deepEqual(third.ops, []);

  const s = client.state;
  const roles = s.roles.filter((r) => ['Admin', 'Mod', 'Member'].includes(r.name)).sort((a, b) => b.position - a.position);
  assert.deepEqual(roles.map((r) => r.name), ['Admin', 'Mod', 'Member']);
  const staff = s.channels.find((c) => c.name === 'Staff');
  const modChat = s.channels.find((c) => c.name === 'mod-chat');
  assert.equal(modChat.parent_id, staff.id);
  assert.equal(modChat.permission_overwrites.length, 2, 'mod-chat inherits Staff overwrites');
  const general = s.channels.find((c) => c.name === 'general');
  assert.equal(general.rate_limit_per_user, 5);
  assert.equal(general.parent_id, s.channels.find((c) => c.name === 'Community').id);
});

test('@everyone permission changes are gated', async () => {
  const client = createFakeDiscord();
  const cfg = { guildId: GUILD_ID, everyone: { permissions: ['VIEW_CHANNEL'] }, ignore: { channels: ['general', 'General', 'Text Channels', 'Voice Channels'] } };
  const p = await plan(client, cfg);
  assert.equal(p.ops.length, 1);
  assert.equal(p.ops[0].gate, 'allow-everyone');
});

test('permissions the bot lacks are not granted and produce a warning', async () => {
  const client = createFakeDiscord();
  const cfg = { guildId: GUILD_ID, roles: [{ name: 'Events', permissions: ['MANAGE_EVENTS', 'SEND_MESSAGES'] }] };
  const p = await plan(client, cfg);
  const create = p.ops.find((o) => o.label === 'role "Events"');
  assert.match(create.details.join(), /SEND_MESSAGES/);
  assert.doesNotMatch(create.details.join(), /MANAGE_EVENTS/);
  assert.ok(p.warnings.some((w) => w.includes('MANAGE_EVENTS')));
});

test('config validation rejects ADMINISTRATOR unless explicitly allowed', () => {
  const bad = { guildId: GUILD_ID, roles: [{ name: 'Boss', permissions: ['ADMINISTRATOR'] }] };
  assert.ok(validateConfig(bad).some((e) => e.includes('ADMINISTRATOR')));
  bad.roles[0].allowAdministrator = true;
  assert.deepEqual(validateConfig(bad), []);
  assert.ok(validateConfig({ guildId: GUILD_ID, roles: [{ name: 'x', permissions: ['NOPE'] }] }).length);
});

test('client waits out 429s, retries, and never leaks the token', async () => {
  const token = 'secret-token-value';
  let n = 0;
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push(init.headers.Authorization);
    n++;
    if (n === 1) return new Response(JSON.stringify({ retry_after: 0.05, global: false }), { status: 429, headers: { 'content-type': 'application/json' } });
    if (n === 2) return new Response(JSON.stringify({ ok: true }), { status: 200 });
    return new Response(JSON.stringify({ message: `bad ${token}`, code: 50013 }), { status: 403 });
  };
  const logs = [];
  const log = { warn: (m) => logs.push(m), error: (m) => logs.push(m) };
  const client = createClient({ token, log, fetchImpl });
  assert.deepEqual(await client.get('/users/@me'), { ok: true });
  assert.equal(n, 2);
  assert.equal(seen[0], `Bot ${token}`);
  await assert.rejects(client.get('/users/@me'), (err) => err.status === 403 && !err.message.includes(token));
  assert.ok(logs.every((l) => !l.includes(token)));
});

const merchantLike = () => ({
  guildId: GUILD_ID,
  guild: {
    community: true, verificationLevel: 'LOW', explicitContentFilter: 'ALL_MEMBERS',
    rulesChannel: 'rules', publicUpdatesChannel: 'alerts', systemChannel: null,
  },
  categories: [
    { name: 'Start', channels: [{ name: 'rules' }, { name: 'announcements', type: 'announcement' }] },
    {
      name: 'Ops',
      channels: [
        { name: 'orders', type: 'forum', requireTag: true, defaultAutoArchive: 1440, tags: [{ name: 'Bidding', moderated: true }, { name: 'Done' }] },
        { name: 'alerts' },
      ],
    },
  ],
  ignore: { channels: ['general', 'General', 'Text Channels', 'Voice Channels'] },
});

test('community: announcement channels wait as text, then convert once the owner enables Community', async () => {
  const client = createFakeDiscord();
  const p1 = await plan(client, merchantLike());
  assert.ok(p1.manual.some((m) => m.includes('Enable Community')));
  const settings = p1.ops.find((o) => o.kind === 'guild');
  assert.ok(settings.details.some((d) => d.startsWith('verificationLevel')));
  assert.ok(!settings.details.some((d) => d.startsWith('rulesChannel')), 'rules channel waits for Community');
  await apply(client, p1);
  const ann = client.state.channels.find((c) => c.name === 'announcements');
  assert.equal(ann.type, 0);
  assert.equal(client.state.guild.system_channel_id, null);
  assert.equal(client.state.guild.explicit_content_filter, 2);

  const again = await plan(client, merchantLike());
  assert.deepEqual(again.ops.filter((o) => !o.gate), [], 'converged before Community');

  client.state.guild.features.push('COMMUNITY');
  const p2 = await plan(client, merchantLike());
  const conv = p2.ops.find((o) => o.label.includes('announcements'));
  assert.deepEqual(conv.details, ['type: text -> announcement']);
  assert.equal(p2.manual.length, 0);
  await apply(client, p2);
  assert.equal(ann.id, client.state.channels.find((c) => c.name === 'announcements' && c.type === 5).id);
  const rules = client.state.channels.find((c) => c.name === 'rules');
  assert.equal(client.state.guild.rules_channel_id, rules.id);
  assert.deepEqual((await plan(client, merchantLike())).ops.filter((o) => !o.gate), []);
});

test('forum tags are created, keep their ids across edits, and require-tag is set', async () => {
  const client = createFakeDiscord();
  await apply(client, await plan(client, merchantLike()));
  const forum = client.state.channels.find((c) => c.name === 'orders');
  assert.equal(forum.type, 15);
  assert.equal(forum.flags & 16, 16);
  assert.equal(forum.default_auto_archive_duration, 1440);
  const bidId = forum.available_tags.find((t) => t.name === 'Bidding').id;

  const cfg = merchantLike();
  cfg.categories[1].channels[0].tags = [{ name: 'Bidding', moderated: true }, { name: 'Problem' }];
  const p = await plan(client, cfg);
  const upd = p.ops.find((o) => o.label.includes('"orders"'));
  assert.deepEqual(upd.details, ['tags: +Problem -Done']);
  await apply(client, p);
  assert.equal(forum.available_tags.find((t) => t.name === 'Bidding').id, bidId);
  assert.deepEqual((await plan(client, cfg)).ops.filter((o) => !o.gate), []);
});

test('config validation checks guild settings and forum-only options', () => {
  const cfg = merchantLike();
  assert.deepEqual(validateConfig(cfg), []);
  cfg.guild.rulesChannel = 'nope';
  cfg.guild.verificationLevel = 'EXTREME';
  cfg.categories[0].channels[0].tags = [{ name: 'x' }];
  cfg.categories[1].channels[0].tags = [{ name: 'Only', moderated: true }];
  const errs = validateConfig(cfg);
  assert.equal(errs.length, 4, errs.join('\n'));
  assert.ok(errs.some((e) => e.includes("isn't moderated")));
});

test('managed bot roles can be placed in the hierarchy without being edited', async () => {
  const client = createFakeDiscord();
  client.state.roles.push({ id: '110000000000000009', name: 'OpsBot', color: 0, hoist: false, mentionable: false, managed: true, position: 1, permissions: '0' });
  client.state.roles.find((r) => r.name === 'Server Manager').position = 2;
  const cfg = { guildId: GUILD_ID, roles: [{ name: 'Boss' }, { name: 'OpsBot', managed: true }, { name: 'Member' }], ignore: { channels: ['general', 'General', 'Text Channels', 'Voice Channels'] } };
  const p = await plan(client, cfg);
  assert.ok(!p.warnings.some((w) => w.includes('OpsBot')));
  assert.ok(!p.ops.some((o) => o.action === 'update' && o.label.includes('OpsBot')));
  await apply(client, p);
  const order = client.state.roles.filter((r) => ['Boss', 'OpsBot', 'Member'].includes(r.name)).sort((a, b) => b.position - a.position).map((r) => r.name);
  assert.deepEqual(order, ['Boss', 'OpsBot', 'Member']);
  assert.deepEqual((await plan(client, cfg)).ops.filter((o) => !o.gate), []);
});

test('an Administrator bot enables Community itself, then converts announcements', async () => {
  const client = createFakeDiscord();
  client.state.botAdmin = true;
  const bot = client.state.roles.find((r) => r.name === 'Server Manager');
  bot.permissions = (BigInt(bot.permissions) | (1n << 3n)).toString();
  const p1 = await plan(client, merchantLike());
  assert.equal(p1.manual.length, 0);
  assert.ok(p1.ops.find((o) => o.kind === 'guild').details.includes('enable Community'));
  await apply(client, p1);
  assert.ok(client.state.guild.features.includes('COMMUNITY'));
  assert.equal(client.state.guild.rules_channel_id, client.state.channels.find((c) => c.name === 'rules').id);
  const p2 = await plan(client, merchantLike());
  assert.deepEqual(p2.ops.filter((o) => !o.gate).map((o) => o.details).flat(), ['type: text -> announcement']);
  await apply(client, p2);
  assert.deepEqual((await plan(client, merchantLike())).ops.filter((o) => !o.gate), []);
});
