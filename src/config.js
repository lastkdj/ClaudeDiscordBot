// Loads and validates server-config.json.
import { readFileSync } from 'node:fs';
import { isPermission } from './permissions.js';

export const CHANNEL_TYPES = { text: 0, voice: 2, category: 4, announcement: 5, stage: 13, forum: 15 };
export const CHANNEL_TYPE_NAMES = Object.fromEntries(Object.entries(CHANNEL_TYPES).map(([k, v]) => [v, k]));
export const VOICE_LIKE = new Set(['voice', 'stage']);
export const ARCHIVE_MINUTES = [60, 1440, 4320, 10080];
export const VERIFICATION_LEVELS = { NONE: 0, LOW: 1, MEDIUM: 2, HIGH: 3, VERY_HIGH: 4 };
export const CONTENT_FILTERS = { DISABLED: 0, MEMBERS_WITHOUT_ROLES: 1, ALL_MEMBERS: 2 };
export const NOTIFICATION_LEVELS = { ALL_MESSAGES: 0, ONLY_MENTIONS: 1 };

// Discord lowercases text-like channel names and replaces spaces with dashes.
export function normalizeChannelName(name, type) {
  if (type === 'category' || VOICE_LIKE.has(type)) return name.trim();
  return name.trim().toLowerCase().replace(/\s+/g, '-');
}

export function loadConfig(path) {
  const config = JSON.parse(readFileSync(path, 'utf8'));
  const errors = validateConfig(config);
  if (errors.length) throw new Error(`Invalid config ${path}:\n  - ${errors.join('\n  - ')}`);
  return config;
}

export function validateConfig(config) {
  const errors = [];
  const checkPerms = (where, list, allowAdmin) => {
    if (list === undefined) return;
    if (!Array.isArray(list)) return errors.push(`${where}: permissions must be an array`);
    for (const p of list) {
      if (!isPermission(p)) errors.push(`${where}: unknown permission "${p}"`);
      if (p === 'ADMINISTRATOR' && !allowAdmin) {
        errors.push(`${where}: ADMINISTRATOR is not allowed unless "allowAdministrator": true is set explicitly`);
      }
    }
  };

  if (!/^\d{15,}$/.test(String(config.guildId ?? ''))) errors.push('guildId must be a Discord snowflake string');

  const roleNames = new Set();
  for (const [i, r] of (config.roles ?? []).entries()) {
    const where = `roles[${i}] "${r.name}"`;
    if (!r.name || typeof r.name !== 'string') errors.push(`roles[${i}]: name is required`);
    if (r.name === '@everyone') errors.push(`${where}: configure @everyone under "everyone", not "roles"`);
    if (roleNames.has(r.name)) errors.push(`${where}: duplicate role name`);
    roleNames.add(r.name);
    if (r.color != null && !/^#[0-9a-f]{6}$/i.test(r.color)) errors.push(`${where}: color must be "#rrggbb" or null`);
    checkPerms(where, r.permissions, r.allowAdministrator === true);
    if (r.managed && ['permissions', 'color', 'hoist', 'mentionable'].some((k) => r[k] !== undefined)) {
      errors.push(`${where}: a "managed" (bot) role only sets its position; remove the other fields`);
    }
  }
  if (config.everyone) checkPerms('everyone', config.everyone.permissions, false);

  const checkOverwrites = (where, list) => {
    if (list === undefined) return;
    if (!Array.isArray(list)) return errors.push(`${where}: overwrites must be an array`);
    for (const [i, o] of list.entries()) {
      const w = `${where} overwrites[${i}]`;
      if (!!o.role === !!o.member) errors.push(`${w}: set exactly one of "role" or "member"`);
      if (o.member && !/^\d{15,}$/.test(o.member)) errors.push(`${w}: member must be a user ID`);
      checkPerms(`${w} allow`, o.allow ?? [], false);
      checkPerms(`${w} deny`, o.deny ?? [], false);
    }
  };

  const checkChannels = (where, channels) => {
    const seen = new Set();
    for (const [i, c] of (channels ?? []).entries()) {
      const w = `${where} channels[${i}] "${c.name}"`;
      if (!c.name) errors.push(`${w}: name is required`);
      const type = c.type ?? 'text';
      if (!Object.hasOwn(CHANNEL_TYPES, type) || type === 'category') errors.push(`${w}: invalid type "${type}"`);
      const key = `${type}:${normalizeChannelName(c.name ?? '', type)}`;
      if (seen.has(key)) errors.push(`${w}: duplicate channel name in the same category`);
      seen.add(key);
      if (c.slowmode != null && !(Number.isInteger(c.slowmode) && c.slowmode >= 0 && c.slowmode <= 21600)) {
        errors.push(`${w}: slowmode must be 0-21600 seconds`);
      }
      if (c.userLimit != null && !(Number.isInteger(c.userLimit) && c.userLimit >= 0 && c.userLimit <= 99)) {
        errors.push(`${w}: userLimit must be 0-99`);
      }
      if (c.defaultAutoArchive != null && !ARCHIVE_MINUTES.includes(c.defaultAutoArchive)) {
        errors.push(`${w}: defaultAutoArchive must be one of ${ARCHIVE_MINUTES.join(', ')} minutes`);
      }
      if ((c.tags !== undefined || c.requireTag !== undefined) && type !== 'forum') errors.push(`${w}: tags/requireTag are only valid on forum channels`);
      if (c.requireTag && !(c.tags ?? []).some((t) => !t?.moderated)) {
        errors.push(`${w}: requireTag needs at least one tag that isn't moderated (Discord rule)`);
      }
      if (c.tags !== undefined) {
        if (!Array.isArray(c.tags) || c.tags.length > 20) errors.push(`${w}: tags must be an array of at most 20`);
        const tagNames = new Set();
        for (const t of c.tags ?? []) {
          if (!t?.name || t.name.length > 20) errors.push(`${w}: each tag needs a name of 1-20 characters`);
          if (tagNames.has(t?.name)) errors.push(`${w}: duplicate tag "${t?.name}"`);
          tagNames.add(t?.name);
        }
      }
      checkOverwrites(w, c.overwrites);
      allChannelNames.add(normalizeChannelName(c.name ?? '', type));
    }
  };
  const allChannelNames = new Set();

  const catNames = new Set();
  for (const [i, cat] of (config.categories ?? []).entries()) {
    const w = `categories[${i}] "${cat.name}"`;
    if (!cat.name) errors.push(`categories[${i}]: name is required`);
    if (catNames.has(cat.name)) errors.push(`${w}: duplicate category name`);
    catNames.add(cat.name);
    checkOverwrites(w, cat.overwrites);
    checkChannels(w, cat.channels);
  }
  checkChannels('(uncategorized)', config.channels);

  const g = config.guild;
  if (g !== undefined) {
    const enumCheck = (key, table) => {
      if (g[key] !== undefined && !Object.hasOwn(table, g[key])) errors.push(`guild.${key} must be one of ${Object.keys(table).join(', ')}`);
    };
    enumCheck('verificationLevel', VERIFICATION_LEVELS);
    enumCheck('explicitContentFilter', CONTENT_FILTERS);
    enumCheck('defaultNotifications', NOTIFICATION_LEVELS);
    if (g.community !== undefined && typeof g.community !== 'boolean') errors.push('guild.community must be true or false');
    for (const key of ['rulesChannel', 'publicUpdatesChannel', 'systemChannel']) {
      if (g[key] != null && !allChannelNames.has(g[key])) errors.push(`guild.${key}: channel "${g[key]}" is not in the config`);
    }
  }
  return errors;
}
