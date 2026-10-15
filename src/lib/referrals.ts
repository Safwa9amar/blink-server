import { supabaseAdmin } from "./supabase";
import { createNotification } from "./notifications";

const DAY_MS = 86_400_000;
export const REFERRAL_REWARD_AMOUNT = 500; // 500 DZD
export const REFERRAL_DISCOUNT_AMOUNT = 500; // 500 DZD
export const REFERRAL_MIN_ORDER = 1000; // 1000 DZD minimum order for welcome coupon

function obscurePhone(phone?: string | null): string {
  if (!phone) return "+213 ••• •••";
  const cleaned = phone.trim();
  if (cleaned.length < 8) return cleaned;
  const start = cleaned.slice(0, 7);
  const end = cleaned.slice(-2);
  return `${start} ••• ${end}`;
}

// Where an invite link sends a friend. blink.com isn't ours: default to the Play
// listing, passing the code as the install referrer. REFERRAL_INVITE_BASE_URL
// (e.g. a landing page) overrides it; the code is appended as `?code=`.
const PLAY_LISTING = "https://play.google.com/store/apps/details?id=com.astro0666.blink";

export function referralInviteUrl(code: string, base = process.env.REFERRAL_INVITE_BASE_URL): string {
  const c = encodeURIComponent(code);
  if (base?.trim()) {
    const b = base.trim().replace(/\/+$/, "");
    return `${b}${b.includes("?") ? "&" : "?"}code=${c}`;
  }
  return `${PLAY_LISTING}&referrer=${encodeURIComponent(`referral_code=${code}`)}`;
}

export function formatReferralCodeFromCustomerId(customerId: string): string {
  const num = customerId.replace(/[^0-9]/g, "");
  return num ? `BLINK-${num}` : customerId;
}

/**
 * Resolve a referral code string to the owning referrer user row.
 * Handles formats: "BLINK-100009", "BK-CU-100009", or "100009".
 */
export async function resolveReferrerByCode(code: string) {
  const clean = code.trim().toUpperCase();
  const num = clean.replace(/[^0-9]/g, "");

  // Search by exact customer_id or partial match
  const candidateCustomerIds = [clean, `BK-CU-${num}`].filter(Boolean);

  const { data: profiles } = await supabaseAdmin
    .from("customer_profiles")
    .select("user_id, customer_id")
    .in("customer_id", candidateCustomerIds);

  const profile = profiles?.[0];
  if (!profile) return null;

  const { data: user } = await supabaseAdmin
    .from("users")
    .select("id, first_name, last_name, phone_number")
    .eq("id", profile.user_id)
    .maybeSingle();

  if (!user) return null;

  return {
    user,
    customerId: profile.customer_id,
    referralCode: formatReferralCodeFromCustomerId(profile.customer_id),
  };
}

/**
 * Fetch full dashboard data for a customer's Share & Earn surface.
 */
export async function getReferralOverview(userId: string) {
  // 1. Get user's customer profile
  const { data: customerProfile } = await supabaseAdmin
    .from("customer_profiles")
    .select("customer_id")
    .eq("user_id", userId)
    .maybeSingle();

  // Never fall back to a made-up id: it could be another customer's code.
  if (!customerProfile?.customer_id) throw new Error("Customer profile not found.");
  const referralCode = formatReferralCodeFromCustomerId(customerProfile.customer_id);
  const inviteUrl = referralInviteUrl(referralCode);

  // 2. Fetch referrals where user is the referrer
  const { data: rows } = await supabaseAdmin
    .from("referrals")
    .select("*")
    .eq("referrer_id", userId)
    .order("created_at", { ascending: false });

  const referralRows = rows ?? [];
  const completed = referralRows.filter((r) => r.status === "completed");
  const pending = referralRows.filter((r) => r.status === "pending");

  const totalEarned = completed.reduce((sum, r) => sum + Number(r.reward_amount ?? 500), 0);

  // 3. Check if current user was invited by someone
  const { data: appliedRow } = await supabaseAdmin
    .from("referrals")
    .select("referral_code, discount_amount, created_at")
    .eq("referred_id", userId)
    .maybeSingle();

  const formattedReferrals = referralRows.map((r) => {
    const createdDate = new Date(r.created_at);
    const diffDays = Math.floor((Date.now() - createdDate.getTime()) / DAY_MS);
    const dateLabel =
      diffDays === 0
        ? "Today"
        : diffDays === 1
          ? "Yesterday"
          : `${diffDays} days ago`;

    return {
      id: r.id,
      friend_name: r.friend_name || "Blink Friend",
      friend_phone: r.friend_phone || "+213 ••• •••",
      status: r.status as "completed" | "pending" | "cancelled",
      reward: Number(r.reward_amount ?? 500),
      date: dateLabel,
      service: r.service_type || "delivery",
      claimed: r.status === "completed",
    };
  });

  return {
    referral_code: referralCode,
    invite_url: inviteUrl,
    reward_amount: REFERRAL_REWARD_AMOUNT,
    currency: "DZD",
    stats: {
      total_earned: totalEarned,
      successful_referrals: completed.length,
      pending_invites: pending.length,
      available_balance: totalEarned,
    },
    referrals: formattedReferrals,
    applied_referral: appliedRow
      ? {
          code: appliedRow.referral_code,
          discount_amount: Number(appliedRow.discount_amount ?? REFERRAL_DISCOUNT_AMOUNT),
          applied_at: appliedRow.created_at,
        }
      : null,
  };
}

/**
 * Apply a friend's referral code.
 * Issues a 500 DZD discount coupon to the new user and records the pending referral.
 */
export async function applyFriendReferral(referredUserId: string, code: string) {
  const cleanCode = code.trim().toUpperCase();

  // 1. Verify user hasn't already applied a code
  const { data: existing } = await supabaseAdmin
    .from("referrals")
    .select("id")
    .eq("referred_id", referredUserId)
    .maybeSingle();

  if (existing) {
    throw new Error("You have already applied a referral code.");
  }

  // 2. Resolve referrer
  const resolved = await resolveReferrerByCode(cleanCode);
  if (!resolved) {
    throw new Error("Invalid referral code. Please check and try again.");
  }

  if (resolved.user.id === referredUserId) {
    throw new Error("You cannot use your own referral code.");
  }

  // The welcome coupon is for a first order: customers who already finished one can't apply a code.
  const { count: finished } = await supabaseAdmin
    .from("orders")
    .select("id", { count: "exact", head: true })
    .eq("customer_id", referredUserId)
    .eq("status", "delivered");
  if ((finished ?? 0) > 0) {
    throw new Error("Referral codes are for new customers only.");
  }

  // 3. Get referred user details
  const { data: referredUser } = await supabaseAdmin
    .from("users")
    .select("first_name, last_name, phone_number")
    .eq("id", referredUserId)
    .single();

  const friendName = [referredUser?.first_name, referredUser?.last_name]
    .filter(Boolean)
    .join(" ") || "Blink Friend";
  const friendPhone = obscurePhone(referredUser?.phone_number);

  // 4. Claim the referral first: `referred_id` is unique, so of two concurrent
  //    applies only one gets here, and only that one issues a coupon.
  const { data: referral, error: refErr } = await supabaseAdmin
    .from("referrals")
    .insert({
      referrer_id: resolved.user.id,
      referred_id: referredUserId,
      referral_code: cleanCode,
      status: "pending",
      reward_amount: REFERRAL_REWARD_AMOUNT,
      discount_amount: REFERRAL_DISCOUNT_AMOUNT,
      friend_name: friendName,
      friend_phone: friendPhone,
      service_type: "delivery",
    })
    .select()
    .single();

  if (refErr) {
    if (refErr.code === "23505") throw new Error("You have already applied a referral code.");
    throw new Error(refErr.message);
  }

  // 5. Issue the 500 DZD welcome coupon to the referred user and link it.
  const couponCode = `REF-${cleanCode.slice(-6)}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  const { data: coupon, error: couponErr } = await supabaseAdmin
    .from("customer_coupons")
    .insert({
      user_id: referredUserId,
      code: couponCode,
      type: "others",
      title: "Welcome Referral Discount",
      description: "500 DZD off on your first Blink order or ride",
      discount_type: "fixed",
      discount_value: REFERRAL_DISCOUNT_AMOUNT,
      min_order: REFERRAL_MIN_ORDER,
      source: "referral",
      expires_at: new Date(Date.now() + 30 * DAY_MS).toISOString(),
    })
    .select()
    .single();

  if (couponErr) {
    console.error("[referrals] Failed to create coupon", couponErr.message);
  } else if (coupon) {
    await supabaseAdmin.from("referrals").update({ coupon_id: coupon.id }).eq("id", referral.id);
  }

  // 6. Notify the referrer that a friend joined with their code
  await createNotification({
    userId: resolved.user.id,
    role: "customer",
    type: "promo",
    title: "Friend joined using your invite!",
    description: `${friendName} joined Blink with your code. You will earn 500 DZD when they complete their first order!`,
    contentFr: {
      title: "Un ami s'est inscrit avec votre code !",
      description: `${friendName} a rejoint Blink. Vous gagnerez 500 DZD dès sa première commande terminée !`,
    },
    contentAr: {
      title: "انضم صديق باستخدام دعوتك!",
      description: `انضم ${friendName} إلى Blink. ستربح 500 دج فور إتمامه لطلبه الأول!`,
    },
  }).catch(() => null);

  return {
    referral,
    discount_amount: REFERRAL_DISCOUNT_AMOUNT,
    coupon_code: couponCode,
  };
}

/**
 * Triggered on first order/ride completion of a customer.
 * Credits the referrer and closes the pending referral.
 */
export async function completeReferralIfEligible(referredUserId: string, orderId?: string) {
  const { data: pendingRef } = await supabaseAdmin
    .from("referrals")
    .select("*")
    .eq("referred_id", referredUserId)
    .eq("status", "pending")
    .maybeSingle();

  if (!pendingRef) return;

  const now = new Date().toISOString();

  // 1. Mark referral as completed — only if still pending, so two concurrent
  //    "delivered" updates can't both pay the referrer.
  const { data: closed } = await supabaseAdmin
    .from("referrals")
    .update({
      status: "completed",
      completed_at: now,
      order_id: orderId ?? null,
    })
    .eq("id", pendingRef.id)
    .eq("status", "pending")
    .select("id");
  if (!closed?.length) return;

  // 2. Issue 500 DZD reward coupon to referrer
  const rewardCode = `REWARD-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  await supabaseAdmin.from("customer_coupons").insert({
    user_id: pendingRef.referrer_id,
    code: rewardCode,
    type: "others",
    title: "Referral Reward",
    description: "500 DZD referral reward for inviting a friend",
    discount_type: "fixed",
    discount_value: REFERRAL_REWARD_AMOUNT,
    min_order: 500,
    source: "referral",
    expires_at: new Date(Date.now() + 60 * DAY_MS).toISOString(),
  });

  // 3. Notify referrer about the earned reward
  await createNotification({
    userId: pendingRef.referrer_id,
    role: "customer",
    type: "promo",
    title: "Referral reward earned! 🎉",
    description: `Your friend ${pendingRef.friend_name || ""} completed their first order. 500 DZD has been credited to your rewards!`,
    contentFr: {
      title: "Récompense de parrainage gagnée ! 🎉",
      description: `Votre ami ${pendingRef.friend_name || ""} a terminé sa première commande. 500 DZD ont été crédités sur vos récompenses !`,
    },
    contentAr: {
      title: "تم كسب مكافأة الإحالة! 🎉",
      description: `أتم صديقك ${pendingRef.friend_name || ""} طلبه الأول. تم إضافة 500 دج إلى مكافآتك!`,
    },
  }).catch(() => null);
}
