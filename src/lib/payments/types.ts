// The contract every payment-gateway adapter implements (chargily.ts, stripe.ts,
// satim.ts); the service (service.ts) only talks to this interface.
import type { MethodId, PaymentStatusValue, ProviderId } from "./core";

export type Locale = "ar" | "fr" | "en";

export interface CheckoutInput {
  paymentId: string;
  /** What the card is charged, in `currency` major units (already rounded for the provider). */
  amount: number;
  currency: string;
  method: MethodId;
  locale: Locale;
  description: string;
  successUrl: string;
  failureUrl: string;
  /** Server-to-server callback URL; null when PUBLIC_API_URL is unset. */
  webhookUrl: string | null;
  /** The longest the checkout may stay open (the adapter may shorten it). */
  ttlMinutes: number;
}

export interface CheckoutResult {
  providerRef: string;
  checkoutUrl: string;
  livemode: boolean;
  /** When the provider will close the checkout, if shorter than asked. */
  expiresAt?: Date;
}

export interface ProviderStatus {
  /** null = still in flight. */
  status: PaymentStatusValue | null;
  /** What the provider says was charged (major units) — compared to payments.amount before fulfilling. */
  amount: number | null;
  currency: string | null;
  /** Provider-side id worth keeping as the reference (order id, payment intent …). */
  reference: string | null;
  failureReason?: string | null;
}

export interface ParsedEvent {
  eventId: string;
  type: string;
  /** The checkout / session / order the event is about (payments.provider_ref). */
  providerRef: string | null;
  /** What the event announces; the service still re-fetches the provider status before paying out. */
  hint: PaymentStatusValue | null;
}

export interface PaymentProvider {
  id: ProviderId;
  methods: readonly MethodId[];
  /** The smallest amount, in DZD, the provider can charge; unset = no known floor. */
  minAmount?: number;
  /** The currency the provider charges (ISO, upper case); DZD when unset. */
  chargeCurrency?(): string;
  /** DZD for one unit of chargeCurrency (Blink's fixed rate); null when it charges DZD. */
  dzdRate?(): number | null;
  isConfigured(): boolean;
  /** True for a sandbox / test-key account. */
  testMode(): boolean;
  createCheckout(input: CheckoutInput): Promise<CheckoutResult>;
  fetchStatus(providerRef: string): Promise<ProviderStatus>;
  /** Closes the checkout at the provider (providers that can). */
  cancel?(providerRef: string): Promise<void>;
  /** Webhook authenticity from the raw body + headers (providers with webhooks). */
  verifyWebhook?(rawBody: string, headers: { get(name: string): string | undefined | null }): boolean;
  parseEvent?(rawBody: string): ParsedEvent | null;
}

export class ProviderError extends Error {
  constructor(message: string, readonly provider: ProviderId) {
    super(message);
  }
}
