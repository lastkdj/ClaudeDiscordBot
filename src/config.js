// Loads and validates server-config.json.
import { readFileSync } from 'node:fs';
import { isPermission } from './permissions.js';

export const CHANNEL_TYPES = { text: 0, voice: 2, category: 4, announcement: 5, stage: 13, forum: 15 };
export const CHANNEL_TYPE_NAMES = Object.fromEntries(Object.entries(CHANNEL_TYPES).map(([k, v]) => [v, k]));
export const VOICE_LIKE = new Set(['voice', 'stage']);

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
      checkOverwrites(w, c.overwrites);
    }
  };

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
  return errors;
}
