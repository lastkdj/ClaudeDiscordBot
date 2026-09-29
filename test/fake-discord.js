// In-memory stand-in for the subset of the Discord REST API the tools use.
import { toBits } from '../src/permissions.js';

export const GUILD_ID = '100000000000000000';
export const BOT_ID = '200000000000000000';

export const INVITE_A = toBits([
  'KICK_MEMBERS', 'BAN_MEMBERS', 'MANAGE_CHANNELS', 'MANAGE_GUILD', 'VIEW_CHANNEL', 'SEND_MESSAGES',
  'MANAGE_MESSAGES', 'MANAGE_ROLES', 'MANAGE_WEBHOOKS', 'MODERATE_MEMBERS', 'READ_MESSAGE_HISTORY',
  'ADD_REACTIONS', 'ATTACH_FILES', 'EMBED_LINKS', 'CONNECT', 'SPEAK',
]);

export function createFakeDiscord() {
  let nextId = 300000000000000000n;
  const newId = () => String(nextId++);
  const state = {
    guild: { features: [], verification_level: 0, explicit_content_filter: 0, default_message_notifications: 0, system_channel_id: '120000000000000002', rules_channel_id: null, public_updates_channel_id: null },
    roles: [
      { id: GUILD_ID, name: '@everyone', color: 0, hoist: false, mentionable: false, managed: false, position: 0, permissions: toBits(['VIEW_CHANNEL', 'SEND_MESSAGES', 'READ_MESSAGE_HISTORY', 'CONNECT', 'SPEAK']).toString() },
      { id: '110000000000000000', name: 'Server Manager', color: 0, hoist: false, mentionable: false, managed: true, position: 1, permissions: INVITE_A.toString() },
    ],
    channels: [
      { id: '120000000000000001', type: 4, name: 'Text Channels', position: 0, parent_id: null, permission_overwrites: [] },
      { id: '120000000000000002', type: 0, name: 'general', position: 0, parent_id: '120000000000000001', topic: null, nsfw: false, rate_limit_per_user: 0, permission_overwrites: [] },
      { id: '120000000000000003', type: 4, name: 'Voice Channels', position: 1, parent_id: null, permission_overwrites: [] },
      { id: '120000000000000004', type: 2, name: 'General', position: 0, parent_id: '120000000000000003', user_limit: 0, bitrate: 64000, nsfw: false, rate_limit_per_user: 0, permission_overwrites: [] },
    ],
  };
  const calls = [];
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const role = (id) => state.roles.find((r) => r.id === id);
  const channel = (id) => state.channels.find((c) => c.id === id);
  const notFound = () => { const e = new Error('404 Unknown'); e.status = 404; throw e; };

  function handle(method, path, body) {
    calls.push({ method, path, body });
    let m;
    if (method === 'GET' && path === `/guilds/${GUILD_ID}`) {
      return { id: GUILD_ID, name: 'Test Guild', owner_id: '1', approximate_member_count: 3, ...clone(state.guild), roles: clone(state.roles) };
    }
    if (method === 'PATCH' && path === `/guilds/${GUILD_ID}`) {
      const community = state.guild.features.includes('COMMUNITY') || (body.features ?? []).includes('COMMUNITY');
      if ((body.features ?? []).includes('COMMUNITY') && !state.botAdmin) throw new Error('fake discord: COMMUNITY needs Administrator');
      if (('rules_channel_id' in body || 'public_updates_channel_id' in body) && !community) {
        throw new Error('fake discord: rules/public updates channels need COMMUNITY');
      }
      Object.assign(state.guild, body);
      return clone(state.guild);
    }
    if (method === 'GET' && path === `/guilds/${GUILD_ID}/channels`) return clone(state.channels);
    if (method === 'GET' && path === `/guilds/${GUILD_ID}/roles`) return clone(state.roles);
    if (method === 'GET' && path === '/users/@me') return { id: BOT_ID, username: 'Server Manager' };
    if (method === 'GET' && path === `/guilds/${GUILD_ID}/members/${BOT_ID}`) return { roles: ['110000000000000000'] };
    if (method === 'POST' && path === `/guilds/${GUILD_ID}/roles`) {
      for (const r of state.roles) if (r.position >= 1) r.position++;
      const r = { id: newId(), managed: false, position: 1, color: 0, hoist: false, mentionable: false, permissions: '0', ...body };
      state.roles.push(r);
      return clone(r);
    }
    if (method === 'PATCH' && path === `/guilds/${GUILD_ID}/roles`) {
      for (const { id, position } of body) role(id).position = position;
      return clone(state.roles);
    }
    if ((m = path.match(/^\/guilds\/\d+\/roles\/(\d+)$/))) {
      const r = role(m[1]) ?? notFound();
      if (method === 'PATCH') { Object.assign(r, body); return clone(r); }
      if (method === 'DELETE') { state.roles.splice(state.roles.indexOf(r), 1); return null; }
    }
    if (method === 'POST' && path === `/guilds/${GUILD_ID}/channels`) {
      const siblings = state.channels.filter((c) => (c.parent_id ?? null) === (body.parent_id ?? null));
      const c = {
        id: newId(), parent_id: null, topic: null, nsfw: false, rate_limit_per_user: 0,
        position: siblings.length, ...body,
        permission_overwrites: body.permission_overwrites ?? (body.parent_id ? clone(channel(body.parent_id).permission_overwrites) : []),
      };
      if (c.type === 2) { c.user_limit ??= 0; c.bitrate ??= 64000; }
      if (c.type === 5 && !state.guild.features.includes('COMMUNITY')) throw new Error('fake discord: announcement channels need COMMUNITY');
      if (c.type === 15) {
        c.flags ??= 0;
        c.available_tags = (c.available_tags ?? []).map((t) => ({ id: newId(), emoji_id: null, emoji_name: null, ...t }));
      }
      state.channels.push(c);
      return clone(c);
    }
    if (method === 'PATCH' && path === `/guilds/${GUILD_ID}/channels`) {
      for (const { id, position } of body) channel(id).position = position;
      return null;
    }
    if ((m = path.match(/^\/channels\/(\d+)$/))) {
      const c = channel(m[1]) ?? notFound();
      if (method === 'PATCH') {
        if (body.available_tags) body.available_tags = body.available_tags.map((t) => ({ emoji_id: null, emoji_name: null, ...t, id: t.id ?? newId() }));
        Object.assign(c, body);
        return clone(c);
      }
      if (method === 'DELETE') { state.channels.splice(state.channels.indexOf(c), 1); return clone(c); }
    }
    throw new Error(`fake discord: unhandled ${method} ${path}`);
  }

  const client = {
    calls,
    state,
    request: async (method, path, opts = {}) => handle(method, path, opts.body === undefined ? undefined : clone(opts.body)),
    get: (p) => client.request('GET', p),
    post: (p, body) => client.request('POST', p, { body }),
    patch: (p, body) => client.request('PATCH', p, { body }),
    put: (p, body) => client.request('PUT', p, { body }),
    delete: (p) => client.request('DELETE', p),
    redact: (s) => s,
  };
  return client;
}
