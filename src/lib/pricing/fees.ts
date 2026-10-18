// Fee helpers shared by the quote endpoints and the order / Blink Cash flows,
// so a quote and the charge it predicts always come from the same code.
import { supabaseAdmin } from "../supabase";
import { normalizeWilaya, wilayaAt } from "../geo/wilaya";
import { getPrice, type PricingContext } from "./index";

const isStoreOrder = (type: string) => type !== "courier" && type !== "ride";

/**
 * Pricing context for a new order.
 *  - store orders (`merchant` / `shopper`): service = type, wilaya = the store's
 *    (normalized `stores.wilaya`, else the store's coords, else `lat`/`lng` =
 *    the destination), merchant = `stores.owner_id`;
 *  - `courier` / `ride`: wilaya = `wilayaAt(lat, lng)` — pass the PICKUP coords.
 */
export async function orderPricingContext(input: {
  type: string;
  storeId?: string | null;
  lat?: number | null;
  lng?: number | null;
}): Promise<PricingContext> {
  const ctx: PricingContext = { service: input.type };
  let wilaya: string | null = null;

  if (isStoreOrder(input.type) && input.storeId) {
    const { data: store } = await supabaseAdmin
      .from("stores")
      .select("owner_id, wilaya, latitude, longitude")
      .eq("id", input.storeId)
      .maybeSingle();
    if (store) {
      ctx.merchantId = store.owner_id ?? null;
      wilaya = normalizeWilaya(store.wilaya);
      if (!wilaya && store.latitude != null && store.longitude != null) {
        wilaya = wilayaAt(Number(store.latitude), Number(store.longitude));
      }
    }
  }
  if (!wilaya && input.lat != null && input.lng != null) wilaya = wilayaAt(input.lat, input.lng);
  ctx.wilaya = wilaya;
  return ctx;
}

/**
 * The customer service fee (DZD) for a new order: 0 for courier / ride or when
 * another order of the same checkout already carries it, else the configured
 * `service_fee` for the context. `overrideId` = the deal that set it (or null).
 */
export async function quoteServiceFee(
  ctx: PricingContext,
  opts: { type: string; checkoutAlreadyCharged: boolean }
): Promise<{ amount: number; overrideId: string | null }> {
  if (!isStoreOrder(opts.type) || opts.checkoutAlreadyCharged) return { amount: 0, overrideId: null };
  const { value, overrideId } = await getPrice("service_fee", { ...ctx, service: ctx.service ?? opts.type });
  return { amount: value.amount, overrideId };
}

/** The rider's wilaya code from `users.wilaya_code` / free-text `users.wilaya`. */
export async function userWilaya(userId: string): Promise<string | null> {
  const { data } = await supabaseAdmin.from("users").select("wilaya, wilaya_code").eq("id", userId).maybeSingle();
  return normalizeWilaya(data?.wilaya_code) ?? normalizeWilaya(data?.wilaya);
}

/**
 * Blink Cash fee for a deposit / withdrawal by `riderId`. `fees` rounds exactly
 * as before (`Math.round(amount * rate)`); `total` = amount + fees for a deposit,
 * amount − fees for a withdrawal. `fee_rate` is the rate to snapshot on the row.
 */
export async function quoteBlinkCashFee(input: {
  type: "deposit" | "withdrawal";
  amount: number;
  riderId: string;
}): Promise<{ fees: number; total: number; fee_rate: number; overrideId: string | null }> {
  const wilaya = await userWilaya(input.riderId);
  const { value, overrideId } = await getPrice("blink_cash_fee_rate", { service: input.type, wilaya });
  const fees = Math.round(input.amount * value.rate);
  const total = input.type === "deposit" ? input.amount + fees : input.amount - fees;
  return { fees, total, fee_rate: value.rate, overrideId };
}

/** Has another order of this checkout already been charged the service fee? */
export async function checkoutAlreadyCharged(customerId: string, checkoutId: string | null | undefined): Promise<boolean> {
  if (!checkoutId) return false;
  const { data } = await supabaseAdmin
    .from("orders")
    .select("id")
    .eq("customer_id", customerId)
    .eq("checkout_id", checkoutId)
    .gt("service_fee", 0)
    .limit(1);
  return (data?.length ?? 0) > 0;
}
