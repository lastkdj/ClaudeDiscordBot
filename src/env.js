// Loads .env (if present) into process.env without overriding variables that
// are already set, e.g. by the cloud environment settings.
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

export function loadEnv(path = resolve(process.cwd(), '.env')) {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    if (process.env[key] === undefined || process.env[key] === '') process.env[key] = value;
  }
}

export function requireToken() {
  loadEnv();
  const token = process.env.DISCORD_TOKEN?.trim();
  if (!token) {
    throw new Error(
      'DISCORD_TOKEN is not set. Add it to the environment settings (or to a local .env file, which is gitignored).'
    );
  }
  return token;
}
