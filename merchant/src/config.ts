// Runtime configuration from the environment (or a gitignored .env).
// Secrets are read here and nowhere else; logs redact them (see logger.ts).
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

function loadDotEnv(): void {
  for (const path of [resolve(process.cwd(), '.env'), resolve(process.cwd(), '..', '.env')]) {
    if (!existsSync(path)) continue;
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
}

const bool = z.enum(['true', 'false', '1', '0', '']).optional().transform((v) => v === 'true' || v === '1');

const Schema = z.object({
  MERCHANT_DISCORD_TOKEN: z.string().optional(),
  MERCHANT_APPLICATION_ID: z.string().default('1554254355644026910'),
  DISCORD_GUILD_ID: z.string().regex(/^\d{15,}$/).optional(),
  OWNER_DISCORD_ID: z.string().regex(/^\d{15,}$/).optional(),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_SSL: bool,
  /** PEM text or a file path; Supabase publishes its root certificate in Database settings. */
  DATABASE_SSL_CA: z.string().optional(),
  PAYOUT_ENC_KEY: z.string().optional(),
  MARKETPLACE_NAME: z.string().default('marketplace'),
  MARKETPLACE_WEBHOOK_SECRET: z.string().optional(),
  MARKETPLACE_API_BASE: z.string().url().optional(),
  MARKETPLACE_API_KEY: z.string().optional(),
  PORT: z.coerce.number().int().default(8080),
  LOG_LEVEL: z.string().default('info'),
  RUN_BOT: bool,
  RUN_API: bool,
  RUN_WORKER: bool,
});

export interface AppConfig {
  discordToken: string | null;
  applicationId: string;
  guildId: string | null;
  ownerDiscordId: string | null;
  databaseUrl: string;
  databaseSsl: boolean;
  databaseCa: string | null;
  payoutKey: Buffer | null;
  marketplace: { name: string; webhookSecret: string | null; apiBase: string | null; apiKey: string | null };
  port: number;
  logLevel: string;
  run: { bot: boolean; api: boolean; worker: boolean };
  /** Every secret value, for log redaction. */
  secrets: string[];
}

export function loadConfig({ requireDiscord = true }: { requireDiscord?: boolean } = {}): AppConfig {
  loadDotEnv();
  const env = Schema.parse(process.env);
  if (requireDiscord && (!env.MERCHANT_DISCORD_TOKEN || !env.DISCORD_GUILD_ID)) {
    throw new Error('MERCHANT_DISCORD_TOKEN and DISCORD_GUILD_ID must be set (environment settings or a gitignored .env).');
  }
  let payoutKey: Buffer | null = null;
  if (env.PAYOUT_ENC_KEY) {
    payoutKey = /^[0-9a-f]{64}$/i.test(env.PAYOUT_ENC_KEY) ? Buffer.from(env.PAYOUT_ENC_KEY, 'hex') : Buffer.from(env.PAYOUT_ENC_KEY, 'base64');
    if (payoutKey.length !== 32) throw new Error('PAYOUT_ENC_KEY must be 32 bytes (64 hex chars or base64)');
  }
  const anyRun = env.RUN_BOT || env.RUN_API || env.RUN_WORKER;
  return {
    discordToken: env.MERCHANT_DISCORD_TOKEN ?? null,
    applicationId: env.MERCHANT_APPLICATION_ID,
    guildId: env.DISCORD_GUILD_ID ?? null,
    ownerDiscordId: env.OWNER_DISCORD_ID ?? null,
    databaseUrl: env.DATABASE_URL,
    databaseSsl: env.DATABASE_SSL || !!env.DATABASE_SSL_CA,
    databaseCa: env.DATABASE_SSL_CA ? readCa(env.DATABASE_SSL_CA) : null,
    payoutKey,
    marketplace: {
      name: env.MARKETPLACE_NAME,
      webhookSecret: env.MARKETPLACE_WEBHOOK_SECRET ?? null,
      apiBase: env.MARKETPLACE_API_BASE ?? null,
      apiKey: env.MARKETPLACE_API_KEY ?? null,
    },
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    // By default one process runs all three (§24); set RUN_* to split them.
    run: anyRun ? { bot: env.RUN_BOT, api: env.RUN_API, worker: env.RUN_WORKER } : { bot: true, api: true, worker: true },
    secrets: [env.MERCHANT_DISCORD_TOKEN, env.PAYOUT_ENC_KEY, env.MARKETPLACE_WEBHOOK_SECRET, env.MARKETPLACE_API_KEY, passwordOf(env.DATABASE_URL)].filter(
      (s): s is string => !!s && s.length >= 6,
    ),
  };
}

function passwordOf(url: string): string | undefined {
  try {
    return decodeURIComponent(new URL(url).password) || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Accepts the certificate as a file path or as PEM text in any shape a settings
 * screen allows: multi-line, one line with spaces, "\n" escapes, or quoted.
 */
export function readCa(value: string): string {
  const v = value.trim().replace(/^(['"])(.*)\1$/s, '$2');
  if (!v.includes('BEGIN CERTIFICATE')) return readFileSync(v, 'utf8');
  const blocks = [...v.matchAll(/-----BEGIN CERTIFICATE-----(.*?)-----END CERTIFICATE-----/gs)];
  if (!blocks.length) throw new Error('DATABASE_SSL_CA: could not find the certificate between the BEGIN/END lines');
  return blocks
    .map((m) => {
      const body = m[1]!.replace(/\\n|\s/g, '');
      return `-----BEGIN CERTIFICATE-----\n${body.match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`;
    })
    .join('');
}
