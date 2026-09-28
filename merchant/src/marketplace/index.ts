import type { AppConfig } from '../config.js';
import { GenericWebhookAdapter } from './generic.js';
import { ManualAdapter } from './manual.js';
import type { MarketplaceAdapter } from './types.js';

/** Webhooks are enabled only when a signing secret is configured. */
export function createAdapter(cfg: AppConfig): MarketplaceAdapter {
  const m = cfg.marketplace;
  if (m.webhookSecret) return new GenericWebhookAdapter({ name: m.name, secret: m.webhookSecret, apiBase: m.apiBase, apiKey: m.apiKey });
  return new ManualAdapter(m.name);
}
