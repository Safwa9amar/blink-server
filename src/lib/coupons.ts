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
  const status = row.used_at
    ? "used"
    : row.expires_at && new Date(row.expires_at).getTime() < Date.now()
      ? "expired"
      : "active";
  return {
    ...row,
    status: status as "active" | "used" | "expired",
    discount_label: discountLabel({
      discountType: row.discount_type,
      discountValue: row.discount_value,
    }),
  };
}

/** Promotions that can currently be used (active + inside the date window). */
export function isLive(p: Record<string, any>) {
  const now = Date.now();
  if (!p.is_active) return false;
  if (p.starts_at && new Date(p.starts_at).getTime() > now) return false;
  if (p.ends_at && new Date(p.ends_at).getTime() < now) return false;
  return true;
}

/**
 * Issue (or return the existing) coupon for `userId` from a promotion row.
 * Idempotent thanks to UNIQUE (user_id, promotion_id).
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
  const { data, error } = await supabaseAdmin
    .from("customer_coupons")
    .insert({
      user_id: userId,
      promotion_id: p.id,
      code: p.code ?? String(p.id).slice(0, 8).toUpperCase(),
      type: COUPON_TYPE[p.category] ?? "others",
      title: p.title,
      description: p.subtitle ?? "",
      discount_type: p.discount_type,
      discount_value: p.discount_value,
      min_order: p.min_order,
      max_discount: p.max_discount,
      image_url: p.image_url || null,
      expires_at: new Date(Math.min(byDays, endsAt)).toISOString(),
    })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return { coupon: data, created: true };
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

