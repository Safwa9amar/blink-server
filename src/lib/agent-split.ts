// Pure fee-split maths for agent Blink Cash operations (see agent-finance.ts).

export interface FeeRates {
  /** Blink's share of each rider fee. */
  platform: number;
  /** Withholding tax on the agent's share of each fee. */
  tax: number;
}

export const round2 = (n: number) => Math.round(n * 100) / 100;

/** Split a rider fee into Blink's platform share, tax withheld and the agent's net. */
export function splitFee(fees: number, rates: FeeRates) {
  const platform = round2(fees * rates.platform);
  const tax = round2((fees - platform) * rates.tax);
  return { platform, tax, net: round2(fees - platform - tax) };
}

/** A transaction's own snapshot rates (platform_share_rate / tax_rate), else `fallback`. */
export function ratesOf(t: Record<string, any>, fallback: FeeRates): FeeRates {
  return {
    platform: t.platform_share_rate == null ? fallback.platform : Number(t.platform_share_rate),
    tax: t.tax_rate == null ? fallback.tax : Number(t.tax_rate),
  };
}
