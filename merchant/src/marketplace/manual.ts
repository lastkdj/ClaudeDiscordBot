// Used until the marketplace's API is connected (Q8): staff import orders with
// /order import and record completion by hand. No webhooks, no outbound calls.
import { DomainError } from '../core/types.js';
import type { ExternalOrder, MarketplaceAdapter, MarketplaceEvent } from './types.js';

export class ManualAdapter implements MarketplaceAdapter {
  readonly capabilities = { webhooks: false, pullOrders: false, markDelivered: false, sendMessage: false, commissionInPayload: false };
  constructor(readonly name: string) {}
  verifyWebhook(): boolean {
    return false;
  }
  normalize(): MarketplaceEvent[] {
    return [];
  }
  async fetchOrder(_id: string): Promise<ExternalOrder> {
    throw new DomainError('NOT_SUPPORTED', 'this marketplace is not connected yet; import orders manually');
  }
}
