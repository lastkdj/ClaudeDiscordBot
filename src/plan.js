// Compares server-config.json with the live guild and produces an ordered list
// of operations. Nothing here talks to Discord directly: each op carries a
// run(ctx) closure that the sync script executes only with --apply.
//
// Matching rules
//   roles:      by "id" if given, else by exact name
//   categories: by "id" if given, else by name (case-insensitive fallback)
//   channels:   by "id" if given, else by (normalized name, type), preferring
//               the configured category; a unique match elsewhere is a move
//
// Unspecified attributes (topic, slowmode, color, ...) are left untouched.
// Overwrites: a channel without "overwrites" inherits its category's
// configured overwrites; if neither is configured they are left untouched.
//
// Gated ops (skipped on --apply unless the matching flag is passed):
//   prune          -> deleting anything that is not in the config
//   allow-everyone -> changing @everyone's server-wide permissions
//
// Community: bots cannot turn on the COMMUNITY feature (Discord requires
// Administrator for that), so a config with "guild.community": true lists it
// as a manual step for the owner. Until it is on, announcement channels are
// created as text channels and converted on the next sync after it is enabled.

import { ALL_KNOWN, toBits, fromBits, describeDiff } from './permissions.js';
import {
  CHANNEL_TYPES, CHANNEL_TYPE_NAMES, VOICE_LIKE, normalizeChannelName,
  VERIFICATION_LEVELS, CONTENT_FILTERS, NOTIFICATION_LEVELS,
} from './config.js';

const colorInt = (hex) => (hex ? parseInt(hex.slice(1), 16) : 0);
const colorHex = (n) => (n ? `#${n.toString(16).padStart(6, '0')}` : null);
const byPosition = (a, b) => a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const sortClass = (type) => (type === 2 || type === 13 ? 'voice' : 'text');
const TEXT_LIKE = new Set(['text', 'announcement', 'forum']);
const FORUM_REQUIRE_TAG = 1 << 4;
const tagKey = (t) => `${t.name}|${!!t.moderated}|${t.emoji_name ?? t.emoji ?? ''}`;

export function buildPlan(config, live) {
  const guildId = config.guildId;
  const ops = [];
  const warnings = [];
  const manual = [];
  const hasCommunity = (live.guild.features ?? []).includes('COMMUNITY');
  if (config.guild?.community && !hasCommunity) {
    manual.push('Enable Community (Server Settings -> Enable Community). Bots need Administrator for this, so the owner does it. ' +
      `When the wizard asks, pick #${config.guild.rulesChannel ?? 'rules'} as the rules channel and ` +
      `#${config.guild.publicUpdatesChannel ?? 'a staff-only channel'} for community updates, then run the plan again.`);
  }
  const ignore = { roles: new Set(config.ignore?.roles ?? []), channels: new Set(config.ignore?.channels ?? []) };

  const roleById = new Map(live.roles.map((r) => [r.id, r]));
  const liveRoles = live.roles.filter((r) => r.id !== guildId);
  const roleIds = new Map(); // config role name -> live id (seed for runtime)
  const ids = new Map(); // config category/channel object -> live id (seed for runtime)
  const claimedRoles = new Set();
  const claimedChannels = new Set();

  // Keep bits the bot does not hold at their current value: Discord rejects
  // granting or revoking permissions the bot itself lacks.
  const grantable = (desired, current, where) => {
    desired |= current & ~ALL_KNOWN;
    if (live.isAdmin) return desired;
    const lacking = (desired ^ current) & ~live.botPerms;
    if (lacking) {
      warnings.push(`${where}: bot lacks ${fromBits(lacking).join(', ')} so it cannot change those bits; leaving them as they are`);
    }
    return (desired & live.botPerms) | (current & ~live.botPerms);
  };

  // ---------------------------------------------------------------- roles
  const createdRoles = [];
  for (const cr of config.roles ?? []) {
    let lr;
    if (cr.id) {
      lr = roleById.get(cr.id);
      if (!lr) warnings.push(`role "${cr.name}": id ${cr.id} not found, matching by name`);
    }
    if (!lr) {
      const matches = liveRoles.filter((r) => r.name === cr.name && !claimedRoles.has(r.id)).sort((a, b) => b.position - a.position);
      if (matches.length > 1) warnings.push(`role "${cr.name}": ${matches.length} live roles share this name; using the highest`);
      lr = matches[0];
    }

    if (lr) {
      claimedRoles.add(lr.id);
      roleIds.set(cr.name, lr.id);
      if (lr.managed) {
        // "managed": true entries only pin the bot role's place in the hierarchy.
        if (!cr.managed) warnings.push(`role "${cr.name}" is managed by an integration/bot and cannot be edited; skipping`);
        continue;
      }
      const changes = {};
      const details = [];
      if (lr.name !== cr.name) { changes.name = cr.name; details.push(`name: "${lr.name}" -> "${cr.name}"`); }
      if (cr.color !== undefined && lr.color !== colorInt(cr.color)) {
        changes.color = colorInt(cr.color);
        details.push(`color: ${colorHex(lr.color) ?? 'none'} -> ${cr.color ?? 'none'}`);
      }
      for (const f of ['hoist', 'mentionable']) {
        if (cr[f] !== undefined && lr[f] !== cr[f]) { changes[f] = cr[f]; details.push(`${f}: ${lr[f]} -> ${cr[f]}`); }
      }
      if (cr.permissions) {
        const cur = BigInt(lr.permissions);
        const want = grantable(toBits(cr.permissions), cur, `role "${cr.name}"`);
        if (want !== cur) { changes.permissions = want.toString(); details.push(`permissions: ${describeDiff(cur, want)}`); }
      }
      if (!details.length) continue;
      if (lr.position >= live.botTop) {
        warnings.push(`role "${cr.name}" is at or above the bot's highest role, so it cannot be edited (wanted: ${details.join('; ')}). Move the bot's role higher.`);
        continue;
      }
      ops.push({
        action: 'update', kind: 'role', label: `role "${cr.name}"`, details,
        run: (ctx) => ctx.client.patch(`/guilds/${guildId}/roles/${lr.id}`, changes, { reason: ctx.reason }),
      });
    } else if (cr.managed) {
      warnings.push(`role "${cr.name}" is marked managed but is not in the server (invite its bot first); ignoring it`);
    } else {
      const perms = grantable(toBits(cr.permissions ?? []), 0n, `role "${cr.name}"`);
      const body = { name: cr.name, permissions: perms.toString(), color: colorInt(cr.color), hoist: !!cr.hoist, mentionable: !!cr.mentionable };
      createdRoles.push(cr.name);
      ops.push({
        action: 'create', kind: 'role', label: `role "${cr.name}"`,
        details: [
          `color ${cr.color ?? 'none'}, hoist ${body.hoist}, mentionable ${body.mentionable}`,
          `permissions: ${fromBits(perms).join(', ') || '(none)'}`,
        ],
        run: async (ctx) => {
          const r = await ctx.client.post(`/guilds/${guildId}/roles`, body, { reason: ctx.reason });
          ctx.roleIds.set(cr.name, r.id);
          return r;
        },
      });
    }
  }

  // ------------------------------------------------------------ @everyone
  if (config.everyone?.permissions) {
    const everyone = roleById.get(guildId);
    const cur = BigInt(everyone.permissions);
    const want = grantable(toBits(config.everyone.permissions), cur, '@everyone');
    if (want !== cur) {
      ops.push({
        action: 'update', kind: 'role', label: 'role "@everyone"', gate: 'allow-everyone',
        details: [`permissions: ${describeDiff(cur, want)}`],
        run: (ctx) => ctx.client.patch(`/guilds/${guildId}/roles/${guildId}`, { permissions: want.toString() }, { reason: ctx.reason }),
      });
    }
  }

  // ----------------------------------------------------------- role order
  {
    // Predict: new roles are inserted just above @everyone, latest lowest.
    const predicted = [
      ...liveRoles.slice().sort((a, b) => b.position - a.position).map((r) => ({ id: r.id, position: r.position })),
      ...createdRoles.slice().reverse().map((name) => ({ id: `new:${name}`, position: 0 })),
    ];
    const planRoleIds = new Map([...roleIds, ...createdRoles.map((n) => [n, `new:${n}`])]);
    const botTop = live.botTop;
    const managedOk = new Set((config.roles ?? []).filter((r) => r.managed).map((r) => r.name));
    const canMove = (id) => id.startsWith('new:') || (roleById.get(id).position < botTop && (!roleById.get(id).managed || managedOk.has(roleById.get(id).name)));
    const current = predicted.map((r) => r.id).filter((id) => [...planRoleIds.values()].includes(id) && canMove(id));
    const desired = (config.roles ?? []).map((r) => planRoleIds.get(r.name)).filter((id) => id && current.includes(id));
    if (current.join() !== desired.join()) {
      const names = (config.roles ?? []).filter((r) => desired.includes(planRoleIds.get(r.name))).map((r) => r.name);
      ops.push({
        action: 'reorder', kind: 'role', label: 'role hierarchy',
        details: [`top -> bottom: ${names.join(' > ')}`],
        run: (ctx) => reorderRoles(ctx, config),
      });
    }
  }

  // ------------------------------------------------------------- channels
  const liveCats = live.channels.filter((c) => c.type === 4);
  const liveChans = live.channels.filter((c) => c.type !== 4);
  const liveById = new Map(live.channels.map((c) => [c.id, c]));

  const owKeyForRole = (name) => {
    if (name === '@everyone') return `role:${guildId}`;
    if (roleIds.has(name)) return `role:${roleIds.get(name)}`;
    if (createdRoles.includes(name)) return `newrole:${name}`;
    const liveRole = liveRoles.find((r) => r.name === name);
    return liveRole ? `role:${liveRole.id}` : null;
  };
  const owLabel = (key) => {
    const [kind, ref] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
    if (kind === 'newrole') return `@${ref} (new)`;
    if (kind === 'member') return `member ${ref}`;
    return ref === guildId ? '@everyone' : `@${roleById.get(ref)?.name ?? ref}`;
  };
  const desiredOverwrites = (list, where) => {
    if (list === undefined) return undefined;
    const out = new Map();
    for (const o of list) {
      const key = o.member ? `member:${o.member}` : owKeyForRole(o.role);
      if (!key) { warnings.push(`${where}: overwrite for unknown role "${o.role}" ignored (add it to "roles")`); continue; }
      out.set(key, { allow: toBits(o.allow ?? []), deny: toBits(o.deny ?? []) });
    }
    return out;
  };
  const liveOverwrites = (ch) => new Map((ch?.permission_overwrites ?? []).map((o) => [
    `${o.type === 1 ? 'member' : 'role'}:${o.id}`, { allow: BigInt(o.allow), deny: BigInt(o.deny) },
  ]));
  // Returns { final, details } where final has un-grantable bits pinned to live values.
  const diffOverwrites = (desired, liveCh, where) => {
    const cur = liveOverwrites(liveCh);
    const final = new Map();
    const details = [];
    for (const [key, want] of desired) {
      const c = cur.get(key) ?? { allow: 0n, deny: 0n };
      const allow = grantable(want.allow, c.allow, `${where} ${owLabel(key)} allow`);
      const deny = grantable(want.deny, c.deny, `${where} ${owLabel(key)} deny`);
      final.set(key, { allow, deny });
      if (!cur.has(key)) {
        details.push(`overwrite ${owLabel(key)}: allow [${fromBits(allow).join(', ')}] deny [${fromBits(deny).join(', ')}]`);
      } else if (allow !== c.allow || deny !== c.deny) {
        const parts = [];
        if (allow !== c.allow) parts.push(`allow ${describeDiff(c.allow, allow)}`);
        if (deny !== c.deny) parts.push(`deny ${describeDiff(c.deny, deny)}`);
        details.push(`overwrite ${owLabel(key)}: ${parts.join('; ')}`);
      }
    }
    for (const key of cur.keys()) if (!desired.has(key)) details.push(`overwrite ${owLabel(key)}: remove`);
    return { final, details };
  };
  const resolveOverwrites = (ctx, final) => [...final].map(([key, { allow, deny }]) => {
    const i = key.indexOf(':');
    const kind = key.slice(0, i);
    const ref = key.slice(i + 1);
    const id = kind === 'newrole' ? ctx.roleIds.get(ref) : ref;
    if (!id) throw new Error(`role "${ref}" was not created, cannot set its overwrite`);
    return { id, type: kind === 'member' ? 1 : 0, allow: allow.toString(), deny: deny.toString() };
  });

  const createdCats = [];
  const channelOps = [];
  for (const cat of config.categories ?? []) {
    let lc = cat.id ? liveCats.find((c) => c.id === cat.id) : undefined;
    if (cat.id && !lc) warnings.push(`category "${cat.name}": id ${cat.id} not found, matching by name`);
    lc ??= liveCats.find((c) => !claimedChannels.has(c.id) && c.name === cat.name)
      ?? liveCats.find((c) => !claimedChannels.has(c.id) && c.name.toLowerCase() === cat.name.toLowerCase());
    const where = `category "${cat.name}"`;
    const wantOw = desiredOverwrites(cat.overwrites, where);

    if (lc) {
      claimedChannels.add(lc.id);
      ids.set(cat, lc.id);
      const body = {};
      const details = [];
      if (lc.name !== cat.name) { body.name = cat.name; details.push(`name: "${lc.name}" -> "${cat.name}"`); }
      if (wantOw) {
        const d = diffOverwrites(wantOw, lc, where);
        if (d.details.length) { details.push(...d.details); body.__ow = d.final; }
      }
      if (details.length) {
        ops.push({
          action: 'update', kind: 'category', label: where, details,
          run: (ctx) => ctx.client.patch(`/channels/${lc.id}`, patchBody(ctx, body), { reason: ctx.reason }),
        });
      }
    } else {
      createdCats.push(cat);
      const final = wantOw ? diffOverwrites(wantOw, null, where).final : null;
      ops.push({
        action: 'create', kind: 'category', label: where,
        details: final ? [...final].map(([k, v]) => `overwrite ${owLabel(k)}: allow [${fromBits(v.allow).join(', ')}] deny [${fromBits(v.deny).join(', ')}]`) : [],
        run: async (ctx) => {
          const body = { name: cat.name, type: 4 };
          if (final) body.permission_overwrites = resolveOverwrites(ctx, final);
          const c = await ctx.client.post(`/guilds/${guildId}/channels`, body, { reason: ctx.reason });
          ctx.ids.set(cat, c.id);
          return c;
        },
      });
    }

    for (const ch of cat.channels ?? []) planChannel(ch, cat, cat.overwrites);
  }
  for (const ch of config.channels ?? []) planChannel(ch, null, undefined);
  ops.push(...channelOps);
  planGuildSettings();

  function findConfigChannel(name) {
    const all = [...(config.categories ?? []).flatMap((c) => c.channels ?? []), ...(config.channels ?? [])];
    return all.find((c) => normalizeChannelName(c.name, c.type ?? 'text') === name);
  }

  function planGuildSettings() {
    const g = config.guild;
    if (!g) return;
    const lg = live.guild;
    const body = {};
    const details = [];
    const setEnum = (key, apiKey, table) => {
      if (g[key] === undefined) return;
      const want = table[g[key]];
      if (lg[apiKey] !== want) {
        body[apiKey] = want;
        const from = Object.keys(table).find((k) => table[k] === lg[apiKey]) ?? lg[apiKey];
        details.push(`${key}: ${from} -> ${g[key]}`);
      }
    };
    setEnum('verificationLevel', 'verification_level', VERIFICATION_LEVELS);
    setEnum('explicitContentFilter', 'explicit_content_filter', CONTENT_FILTERS);
    setEnum('defaultNotifications', 'default_message_notifications', NOTIFICATION_LEVELS);
    const refs = [['systemChannel', 'system_channel_id']];
    // Rules and community-updates channels only exist on Community servers.
    if (hasCommunity) refs.push(['rulesChannel', 'rules_channel_id'], ['publicUpdatesChannel', 'public_updates_channel_id']);
    const refObjs = {};
    for (const [key, apiKey] of refs) {
      if (g[key] === undefined) continue;
      const obj = g[key] === null ? null : findConfigChannel(g[key]);
      const curId = lg[apiKey] ?? null;
      const knownId = obj ? ids.get(obj) : null;
      if (obj === null ? curId !== null : knownId !== curId) {
        refObjs[apiKey] = obj;
        const curName = curId ? `#${liveById.get(curId)?.name ?? curId}` : 'none';
        details.push(`${key}: ${curName} -> ${obj ? `#${g[key]}` : 'none'}`);
      }
    }
    if (!details.length) return;
    ops.push({
      action: 'update', kind: 'guild', label: 'server settings', details,
      run: (ctx) => {
        const out = { ...body };
        for (const [apiKey, obj] of Object.entries(refObjs)) {
          out[apiKey] = obj ? ctx.ids.get(obj) : null;
          if (obj && !out[apiKey]) throw new Error(`channel "${obj.name}" does not exist`);
        }
        return ctx.client.patch(`/guilds/${guildId}`, out, { reason: ctx.reason });
      },
    });
  }

  function planChannel(ch, cat, inheritedOverwrites) {
    const typeName = ch.type ?? 'text';
    // Announcement channels need Community; until then they exist as text.
    const deferType = typeName === 'announcement' && !hasCommunity;
    const type = deferType ? CHANNEL_TYPES.text : CHANNEL_TYPES[typeName];
    const name = normalizeChannelName(ch.name, typeName);
    const where = `${typeName} channel "${name}"${cat ? ` in "${cat.name}"` : ''}`;
    if (name !== ch.name) warnings.push(`${where}: Discord stores this name as "${name}"; consider using that in the config`);
    if (ch.topic !== undefined && !TEXT_LIKE.has(typeName)) warnings.push(`${where}: topic is ignored for ${typeName} channels`);
    const parentId = cat ? ids.get(cat) ?? null : null; // null for new categories too
    const parentIsNew = cat && !ids.has(cat);

    let lc = ch.id ? liveChans.find((c) => c.id === ch.id) : undefined;
    if (ch.id && !lc) warnings.push(`${where}: id ${ch.id} not found, matching by name`);
    if (!lc) {
      // text <-> announcement is a type change Discord allows in place.
      const sameFamily = (t) => t === type || (hasCommunity && [0, 5].includes(t) && [0, 5].includes(type));
      const cands = liveChans.filter((c) => !claimedChannels.has(c.id) && sameFamily(c.type) && c.name === name)
        .sort((a, b) => (a.type === type ? 0 : 1) - (b.type === type ? 0 : 1));
      lc = cands.find((c) => !parentIsNew && (c.parent_id ?? null) === parentId) ?? (cands.length === 1 ? cands[0] : undefined);
    }

    const wantOwList = ch.overwrites !== undefined ? ch.overwrites : inheritedOverwrites;
    const wantOw = desiredOverwrites(wantOwList, where);

    const fields = {};
    if (TEXT_LIKE.has(typeName) && ch.topic !== undefined) fields.topic = ch.topic || null;
    if (ch.nsfw !== undefined) fields.nsfw = ch.nsfw;
    if (ch.slowmode !== undefined) fields.rate_limit_per_user = ch.slowmode;
    if (VOICE_LIKE.has(typeName) && ch.userLimit !== undefined) fields.user_limit = ch.userLimit;
    if (VOICE_LIKE.has(typeName) && ch.bitrate !== undefined) fields.bitrate = ch.bitrate;
    if (ch.defaultAutoArchive !== undefined) fields.default_auto_archive_duration = ch.defaultAutoArchive;
    if (deferType && !lc) warnings.push(`${where}: created as a text channel until Community is enabled, then converted`);

    if (lc) {
      claimedChannels.add(lc.id);
      ids.set(ch, lc.id);
      const body = {};
      const details = [];
      if (lc.name !== name) { body.name = name; details.push(`name: "${lc.name}" -> "${name}"`); }
      if (parentIsNew || (lc.parent_id ?? null) !== parentId) {
        body.__parent = cat;
        const from = lc.parent_id ? `"${liveById.get(lc.parent_id)?.name}"` : '(no category)';
        details.push(`move: ${from} -> ${cat ? `"${cat.name}"` : '(no category)'}`);
      }
      if (lc.type !== type) {
        body.type = type;
        details.push(`type: ${CHANNEL_TYPE_NAMES[lc.type]} -> ${CHANNEL_TYPE_NAMES[type]}`);
      }
      for (const [k, v] of Object.entries(fields)) {
        const cur = k === 'topic' ? lc.topic || null : lc[k] ?? (k === 'nsfw' ? false : k === 'default_auto_archive_duration' ? null : 0);
        if (cur !== v) { body[k] = v; details.push(`${k}: ${JSON.stringify(cur)} -> ${JSON.stringify(v)}`); }
      }
      if (typeName === 'forum') diffForum(ch, lc, body, details);
      if (wantOw) {
        const d = diffOverwrites(wantOw, lc, where);
        if (d.details.length) { details.push(...d.details); body.__ow = d.final; }
      }
      if (details.length) {
        channelOps.push({
          action: 'update', kind: 'channel', label: where, details,
          run: (ctx) => ctx.client.patch(`/channels/${lc.id}`, patchBody(ctx, body), { reason: ctx.reason }),
        });
      }
    } else {
      const final = wantOw ? diffOverwrites(wantOw, null, where).final : null;
      if (typeName === 'forum') {
        if (ch.tags) fields.available_tags = ch.tags.map(toApiTag);
        if (ch.requireTag) fields.flags = FORUM_REQUIRE_TAG;
      }
      const details = Object.entries(fields).map(([k, v]) =>
        k === 'available_tags' ? `tags: ${v.map((t) => t.name).join(', ')}` : k === 'flags' ? 'require tag: true' : `${k}: ${JSON.stringify(v)}`);
      if (final) {
        details.push(...[...final].map(([k, v]) => `overwrite ${owLabel(k)}: allow [${fromBits(v.allow).join(', ')}] deny [${fromBits(v.deny).join(', ')}]`));
      } else if (cat) {
        details.push('permissions synced with category');
      }
      channelOps.push({
        action: 'create', kind: 'channel', label: where, details,
        run: async (ctx) => {
          const body = { name, type, ...fields };
          if (cat) body.parent_id = ctx.ids.get(cat);
          if (cat && !body.parent_id) throw new Error(`category "${cat.name}" does not exist`);
          if (final) body.permission_overwrites = resolveOverwrites(ctx, final);
          const c = await ctx.client.post(`/guilds/${guildId}/channels`, body, { reason: ctx.reason });
          ctx.ids.set(ch, c.id);
          return c;
        },
      });
    }
  }

  function diffForum(ch, lc, body, details) {
    if (ch.tags !== undefined) {
      const liveTags = lc.available_tags ?? [];
      const want = ch.tags.map((t) => {
        const existing = liveTags.find((l) => l.name === t.name);
        return { ...(existing ? { id: existing.id } : {}), ...toApiTag(t) };
      });
      if (want.map(tagKey).join() !== liveTags.map(tagKey).join()) {
        body.available_tags = want;
        const added = want.filter((t) => !t.id).map((t) => t.name);
        const removed = liveTags.filter((l) => !want.some((t) => t.id === l.id)).map((l) => l.name);
        details.push(`tags: ${[...added.map((n) => `+${n}`), ...removed.map((n) => `-${n}`)].join(' ') || 'reorder/edit'}`);
      }
    }
    if (ch.requireTag !== undefined) {
      const cur = !!((lc.flags ?? 0) & FORUM_REQUIRE_TAG);
      if (cur !== ch.requireTag) {
        body.flags = ((lc.flags ?? 0) & ~FORUM_REQUIRE_TAG) | (ch.requireTag ? FORUM_REQUIRE_TAG : 0);
        details.push(`require tag: ${cur} -> ${ch.requireTag}`);
      }
    }
  }

  function patchBody(ctx, body) {
    const out = { ...body };
    if ('__parent' in out) {
      out.parent_id = out.__parent ? ctx.ids.get(out.__parent) : null;
      if (out.__parent && !out.parent_id) throw new Error(`category "${out.__parent.name}" does not exist`);
      delete out.__parent;
    }
    if (out.__ow) { out.permission_overwrites = resolveOverwrites(ctx, out.__ow); delete out.__ow; }
    return out;
  }

  // -------------------------------------------------------- channel order
  {
    const simIds = new Map(ids);
    for (const cat of createdCats) simIds.set(cat, `new:cat:${cat.name}`);
    const simulated = live.channels.map((c) => ({ id: c.id, type: c.type, position: c.position, parent_id: c.parent_id ?? null }));
    let next = 1e6;
    const place = (ch, cat) => {
      const parent = cat ? simIds.get(cat) : null;
      const existing = simIds.get(ch);
      if (existing) {
        const s = simulated.find((x) => x.id === existing);
        if (s.parent_id !== parent) { s.parent_id = parent; s.position = next++; }
      } else {
        const id = `new:ch:${cat?.name ?? ''}:${ch.name}`;
        simIds.set(ch, id);
        simulated.push({ id, type: CHANNEL_TYPES[ch.type ?? 'text'], position: next++, parent_id: parent });
      }
    };
    for (const cat of createdCats) simulated.push({ id: simIds.get(cat), type: 4, position: next++, parent_id: null });
    for (const cat of config.categories ?? []) for (const ch of cat.channels ?? []) place(ch, cat);
    for (const ch of config.channels ?? []) place(ch, null);

    const changes = computeChannelPositions(simulated, config, simIds);
    if (changes.length) {
      ops.push({
        action: 'reorder', kind: 'channel', label: 'channel/category order',
        details: describeChannelOrder(config),
        run: async (ctx) => {
          const fresh = await ctx.client.get(`/guilds/${guildId}/channels`);
          const updates = computeChannelPositions(fresh, config, ctx.ids);
          if (!updates.length) return 'already in order';
          return ctx.client.patch(`/guilds/${guildId}/channels`, updates, { reason: ctx.reason });
        },
      });
    }
  }

  // ------------------------------------------------------------ deletions
  for (const c of liveChans) {
    if (claimedChannels.has(c.id)) continue;
    if (ignore.channels.has(c.name)) continue;
    const parent = c.parent_id ? ` in "${liveById.get(c.parent_id)?.name}"` : '';
    ops.push({
      action: 'delete', kind: 'channel', gate: 'prune', label: `${CHANNEL_TYPE_NAMES[c.type] ?? `type-${c.type}`} channel "${c.name}"${parent}`,
      details: ['not in config — deleting it also deletes all of its messages'],
      run: (ctx) => ctx.client.delete(`/channels/${c.id}`, { reason: ctx.reason }),
    });
  }
  for (const c of liveCats) {
    if (claimedChannels.has(c.id) || ignore.channels.has(c.name)) continue;
    ops.push({
      action: 'delete', kind: 'category', gate: 'prune', label: `category "${c.name}"`, details: ['not in config'],
      run: (ctx) => ctx.client.delete(`/channels/${c.id}`, { reason: ctx.reason }),
    });
  }
  for (const r of liveRoles) {
    if (claimedRoles.has(r.id) || r.managed || ignore.roles.has(r.name)) continue;
    if (r.position >= live.botTop) {
      warnings.push(`role "${r.name}" is not in config but is at or above the bot's role; it will not be touched`);
      continue;
    }
    ops.push({
      action: 'delete', kind: 'role', gate: 'prune', label: `role "${r.name}"`, details: ['not in config — members lose this role'],
      run: (ctx) => ctx.client.delete(`/guilds/${guildId}/roles/${r.id}`, { reason: ctx.reason }),
    });
  }

  return { ops, warnings, manual, seed: { roleIds, ids } };
}

async function reorderRoles(ctx, config) {
  const roles = await ctx.client.get(`/guilds/${ctx.guildId}/roles`);
  const byId = new Map(roles.map((r) => [r.id, r]));
  // Creating roles shifts the bot's own role up, so recompute its position.
  const botTop = ctx.botRoleIds?.length ? Math.max(0, ...ctx.botRoleIds.map((id) => byId.get(id)?.position ?? 0)) : ctx.botTop;
  const managedOk = new Set((config.roles ?? []).filter((r) => r.managed).map((r) => r.name));
  const wanted = (config.roles ?? []).map((r) => ctx.roleIds.get(r.name))
    .filter((id) => id && byId.has(id) && (!byId.get(id).managed || managedOk.has(byId.get(id).name)) && byId.get(id).position < botTop);
  const current = roles.filter((r) => wanted.includes(r.id)).sort((a, b) => b.position - a.position || (a.id < b.id ? -1 : 1));
  if (current.map((r) => r.id).join() === wanted.join()) return 'already in order';
  const positions = current.map((r) => r.position);
  return ctx.client.patch(`/guilds/${ctx.guildId}/roles`, wanted.map((id, i) => ({ id, position: positions[i] })), { reason: ctx.reason });
}

// Returns [{id, position}] for every group (categories; each parent's text
// and voice channels) whose current order differs from the config order.
// Unmanaged items keep their relative order after the managed ones.
export function computeChannelPositions(channels, config, idMap) {
  const updates = [];
  const sorted = (list) => list.slice().sort(byPosition).map((c) => c.id);
  const fix = (current, desiredManaged) => {
    const present = desiredManaged.filter((id) => current.includes(id));
    const desired = [...present, ...current.filter((id) => !present.includes(id))];
    if (desired.join() !== current.join()) desired.forEach((id, position) => updates.push({ id, position }));
  };

  fix(sorted(channels.filter((c) => c.type === 4)), (config.categories ?? []).map((c) => idMap.get(c)).filter(Boolean));
  const parents = [
    [null, config.channels ?? []],
    ...(config.categories ?? []).map((cat) => [idMap.get(cat), cat.channels ?? []]),
  ];
  for (const [parentId, list] of parents) {
    if (parentId === undefined) continue;
    for (const cls of ['text', 'voice']) {
      const current = sorted(channels.filter((c) => c.type !== 4 && (c.parent_id ?? null) === parentId && sortClass(c.type) === cls));
      const managed = list.filter((ch) => sortClass(CHANNEL_TYPES[ch.type ?? 'text']) === cls).map((ch) => idMap.get(ch)).filter(Boolean);
      fix(current, managed);
    }
  }
  return updates;
}

function describeChannelOrder(config) {
  const names = (list) => list.map((c) => normalizeChannelName(c.name, c.type ?? 'text')).join(', ');
  const lines = [];
  if (config.channels?.length) lines.push(`(no category): ${names(config.channels)}`);
  lines.push(`categories: ${(config.categories ?? []).map((c) => c.name).join(', ')}`);
  for (const cat of config.categories ?? []) lines.push(`${cat.name}: ${names(cat.channels ?? []) || '(empty)'}`);
  return lines;
}

const SYMBOL = { create: '+', update: '~', delete: '-', reorder: '↕' };
const GATE_FLAG = { prune: '--prune', 'allow-everyone': '--allow-everyone' };

function toApiTag(t) {
  const out = { name: t.name, moderated: !!t.moderated };
  if (t.emoji) out.emoji_name = t.emoji;
  return out;
}

export function formatPlan({ ops, warnings, manual = [] }) {
  const lines = [];
  if (!ops.length) lines.push('No changes: the server matches the config.');
  for (const op of ops) {
    const gate = op.gate ? `   [needs ${GATE_FLAG[op.gate]} + your confirmation]` : '';
    lines.push(`${SYMBOL[op.action]} ${op.action.toUpperCase()} ${op.label}${gate}`);
    for (const d of op.details ?? []) lines.push(`      ${d}`);
  }
  if (manual.length) {
    lines.push('', 'Manual steps for the owner:');
    for (const m of manual) lines.push(`  → ${m}`);
  }
  if (warnings.length) {
    lines.push('', 'Warnings:');
    for (const w of warnings) lines.push(`  ! ${w}`);
  }
  const count = (a) => ops.filter((o) => o.action === a).length;
  lines.push('', `Summary: ${count('create')} create, ${count('update')} update, ${count('reorder')} reorder, ${count('delete')} delete` +
    ` (${ops.filter((o) => o.gate).length} gated)`);
  return lines.join('\n');
}
