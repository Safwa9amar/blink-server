// Coupon issuing + pricing, shared by the promotions/coupons routes and
// POST /orders (which applies `coupon_code` server-side).
import type { DiscountType } from "../db";
import { supabaseAdmin } from "./supabase";

const DAY_MS = 86_400_000;

/** Promos-tab category → CouponCard art key. */
const COUPON_TYPE: Record<string, string> = {
  FOOD: "food",
  SUPERMARKET: "market",
  MARKET: "market",
  COSMETICS: "cosmetics",
  PARCELS: "parcels",
  RIDES: "rides",
  "Food & Drinks": "food",
  Grocery: "market",
  Beauty: "cosmetics",
};

export function discountLabel(c: { discountType: DiscountType; discountValue: number }) {
  const v = Number(c.discountValue);
  if (c.discountType === "free_delivery") return "Free delivery";
  if (c.discountType === "percent") return `${v}% OFF`;
  return `${Number.isInteger(v) ? v : v.toFixed(2)} DZD`;
}

type CouponDbRow = Record<string, any>;

/** PostgREST coupon row → API shape (adds `status` + `discount_label`). */
export function presentCoupon(row: CouponDbRow) {
  const status = row.revoked_at
    ? "revoked"
    : row.used_at
      ? "used"
      : row.expires_at && new Date(row.expires_at).getTime() < Date.now()
        ? "expired"
        : "active";
  return {
    ...row,
    status: status as "active" | "used" | "expired" | "revoked",
    discount_label: discountLabel({
      discountType: row.discount_type,
      discountValue: row.discount_value,
    }),
  };
}

/** Promotions that can currently be used (active + inside the date window). */
export function isLive(p: Record<string, any>) {
  const now = Date.now();
  if (p.archived_at) return false;
  if (!p.is_active) return false;
  if (p.starts_at && new Date(p.starts_at).getTime() > now) return false;
  if (p.ends_at && new Date(p.ends_at).getTime() < now) return false;
  return true;
}

export type PromotionAvailability =
  | "archived"
  | "paused"
  | "scheduled"
  | "ended"
  | "sold_out"
  | "budget_spent"
  | "live";

export type PromotionUsage = { issued: number; discount_given: number };

/**
 * Computed availability, first match wins: archived → paused → scheduled →
 * ended → sold_out (max_coupons reached) → budget_spent → live. `usage` is
 * all-time (promotion_usage / promotion_stats).
 */
export function promotionAvailability(
  p: Record<string, any>,
  usage: PromotionUsage,
  now: number | Date = Date.now()
): PromotionAvailability {
  const t = typeof now === "number" ? now : now.getTime();
  if (p.archived_at) return "archived";
  if (!p.is_active) return "paused";
  if (p.starts_at && new Date(p.starts_at).getTime() > t) return "scheduled";
  if (p.ends_at && new Date(p.ends_at).getTime() < t) return "ended";
  if (p.max_coupons != null && usage.issued >= Number(p.max_coupons)) return "sold_out";
  if (p.discount_budget != null && Number(usage.discount_given) >= Number(p.discount_budget)) return "budget_spent";
  return "live";
}

export type PromotionUnavailableCode = "not_live" | "sold_out" | "budget_spent";

/** Thrown by issueCoupon when the promotion can't issue any more coupons. */
export class PromotionUnavailableError extends Error {
  constructor(public readonly code: PromotionUnavailableCode) {
    super(
      code === "sold_out"
        ? "This promotion is sold out"
        : code === "budget_spent"
          ? "This promotion's budget is spent"
          : "This promotion is not available"
    );
    this.name = "PromotionUnavailableError";
  }
}

/**
 * Issue (or return the existing) coupon for `userId` from a promotion row.
 * Idempotent thanks to UNIQUE (user_id, promotion_id): an existing coupon is
 * returned even if the promotion has since sold out. Otherwise throws
 * PromotionUnavailableError when the promotion isn't live.
 */
export async function issueCoupon(userId: string, p: Record<string, any>) {
  const { data: existing } = await supabaseAdmin
    .from("customer_coupons")
    .select("*")
    .eq("user_id", userId)
    .eq("promotion_id", p.id)
    .maybeSingle();
  if (existing) return { coupon: existing, created: false };

  const byDays = Date.now() + (p.valid_days ?? 30) * DAY_MS;
  const endsAt = p.ends_at ? new Date(p.ends_at).getTime() : Infinity;
  // Atomic cap check + insert (locks the promotion row).
  const { data, error } = await supabaseAdmin.rpc("issue_promotion_coupon", {
    p_user: userId,
    p_promotion: p.id,
    p_code: p.code ?? String(p.id).slice(0, 8).toUpperCase(),
    p_type: COUPON_TYPE[p.category] ?? "others",
    p_expires_at: new Date(Math.min(byDays, endsAt)).toISOString(),
  });
  if (error) {
    if (error.message === "sold_out" || error.message === "budget_spent" || error.message === "not_live") {
      throw new PromotionUnavailableError(error.message);
    }
    throw new Error(error.message);
  }
  const coupon = Array.isArray(data) ? data[0] : data;
  if (!coupon) throw new Error("Coupon was not issued");
  return { coupon, created: true };
}

export type CouponPricingError = "not_found" | "used" | "expired" | "min_order";

/**
 * Resolve a customer's coupon by code and price it against an order. Returns
 * the discount the server will apply, or why it can't be used.
 */
export async function priceCoupon(
  userId: string,
  code: string,
  subtotal: number,
  deliveryFee: number
): Promise<{ ok: true; coupon: CouponDbRow; discount: number } | { ok: false; reason: CouponPricingError }> {
  const { data: rows } = await supabaseAdmin
    .from("customer_coupons")
    .select("*")
    .eq("user_id", userId)
    .ilike("code", code.trim())
    .is("used_at", null)
    .is("revoked_at", null)
    .order("created_at", { ascending: false })
    .limit(1);
  const coupon = rows?.[0];
  if (!coupon) return { ok: false, reason: "not_found" };
  if (presentCoupon(coupon).status === "expired") return { ok: false, reason: "expired" };
  if (subtotal < Number(coupon.min_order)) return { ok: false, reason: "min_order" };

  const value = Number(coupon.discount_value);
  let discount =
    coupon.discount_type === "free_delivery"
      ? deliveryFee
      : coupon.discount_type === "percent"
        ? (subtotal * value) / 100
        : value;
  if (coupon.max_discount != null) discount = Math.min(discount, Number(coupon.max_discount));
  discount = Math.round(Math.min(discount, subtotal + deliveryFee) * 100) / 100;
  return { ok: true, coupon, discount };
}


/**
 * Mark a coupon used, only if it still isn't: of two requests racing on one
 * coupon, one wins and the other gets false. Done BEFORE the order is
 * inserted (the order doesn't exist yet: `order_id` is set by linkCoupon).
 */
export async function claimCoupon(couponId: string, nowIso = new Date().toISOString()) {
  const { data, error } = await supabaseAdmin
    .from("customer_coupons")
    .update({ used_at: nowIso })
    .eq("id", couponId)
    .is("used_at", null)
    .is("revoked_at", null)
    .select("id")
    .maybeSingle();
  if (error) throw new Error(error.message);
  return !!data;
}

/** Record which order used a coupon claimed with claimCoupon (best effort: the order keeps coupon_id). */
export async function linkCoupon(couponId: string, orderId: string) {
  const { error } = await supabaseAdmin.from("customer_coupons").update({ order_id: orderId }).eq("id", couponId);
  if (error) console.error("[coupons] linking coupon failed", couponId, error.message);
}

/**
 * Hand a coupon back to its customer: usable again. `orderId`: only if that
 * order is the one using it (null = a claim whose order was never created),
 * so a coupon already reused on another order is left alone. Best effort.
 */
export async function releaseCoupon(couponId: string, orderId: string | null) {
  try {
    let q = supabaseAdmin.from("customer_coupons").update({ used_at: null, order_id: null }).eq("id", couponId);
    q = orderId ? q.eq("order_id", orderId) : q.is("order_id", null);
    const { error } = await q;
    if (error) throw new Error(error.message);
  } catch (e) {
    console.error("[coupons] releasing coupon failed", couponId, (e as Error).message);
  }
}
