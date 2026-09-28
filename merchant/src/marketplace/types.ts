// Marketplace adapter contract (ARCHITECTURE §25). Only adapters know the
// marketplace's field names, URLs and auth; the core sees normalized events.
import type { Cents } from '../core/money.js';

export interface ExternalOrder {
  externalOrderId: string;
  listingId: string | null;
  buyer: string | null;
  price: Cents;
  /** Actual commission if the marketplace reports it. */
  commission: Cents | null;
  currency: string;
  quantity: number;
  deadlineAt: Date | null;
  /** Buyer-provided fields (character, realm, ...), keyed by requirement key where possible. */
  fields: Record<string, string>;
  /** Free-text note from the buyer (may carry a TM-Q quote code). */
  note: string | null;
  paid: boolean;
  status: 'OPEN' | 'COMPLETED' | 'CANCELLED' | 'REFUNDED' | 'DISPUTED';
  updatedAt: Date;
}

export type MarketplaceEventType =
  | 'ORDER_CREATED'
  | 'PAYMENT_CONFIRMED'
  | 'CUSTOMER_MESSAGE'
  | 'ORDER_UPDATED'
  | 'ORDER_CANCELLED'
  | 'REFUND'
  | 'DISPUTE_OPENED'
  | 'DISPUTE_RESOLVED'
  | 'ORDER_COMPLETED';

export interface MarketplaceEvent {
  type: MarketplaceEventType;
  /** Stable id for idempotency; adapters hash the payload when the marketplace has none. */
  eventId: string;
  occurredAt: Date;
  externalOrderId: string;
  order?: ExternalOrder;
  message?: string;
  refund?: { amount: Cents; reference: string; reason: string; full: boolean };
  dispute?: { reason: string; outcome?: 'BUYER' | 'SELLER' };
  rating?: number | null;
}

export interface MarketplaceAdapter {
  readonly name: string;
  readonly capabilities: { webhooks: boolean; pullOrders: boolean; markDelivered: boolean; sendMessage: boolean; commissionInPayload: boolean };
  verifyWebhook(headers: Record<string, string | string[] | undefined>, rawBody: Buffer, now?: Date): boolean;
  normalize(body: unknown): MarketplaceEvent[];
  fetchOrder(externalOrderId: string): Promise<ExternalOrder>;
  listOrdersSince?(since: Date): Promise<ExternalOrder[]>;
  markDelivered?(externalOrderId: string, note: string, idempotencyKey: string): Promise<void>;
  sendCustomerMessage?(externalOrderId: string, text: string): Promise<void>;
}
