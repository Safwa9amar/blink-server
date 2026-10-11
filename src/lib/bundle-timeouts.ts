// Multi-store checkout: a store that never answers its order must not hold
// back the whole checkout. After BUNDLE_STORE_TIMEOUT_MS the order goes to a
// Blink shopper, exactly like a `too_busy` rejection. This is driven by
// POST /cron/bundle-timeouts every minute.
import { SHOPPER_HANDOVER_PATCH, shopperHandoverCopy } from "../routes/merchant/orders-shared";
import { orderRef } from "../routes/merchant/shared";
import { BUNDLE_STORE_TIMEOUT_MS, isStoreTimedOut } from "./bundle";
import { createNotification } from "./notifications";
import { pushNewOffer } from "./offer-push";
import { supabaseAdmin } from "./supabase";

export async function processBundleTimeouts(now = Date.now()) {
  const cutoff = new Date(now - BUNDLE_STORE_TIMEOUT_MS).toISOString();
  const { data, error } = await supabaseAdmin
    .from("orders")
    .select("id, customer_id, store_name, checkout_id, merchant_status, status, created_at, store:stores(owner_id)")
    .not("checkout_id", "is", null)
    .eq("merchant_status", "pending")
    // A canceled order keeps merchant_status `pending`. Only live orders are handed over.
    .eq("status", "processing")
    .lt("created_at", cutoff)
    .limit(200);
  if (error) return { checked: 0, converted: 0, error: error.message };

  const due = (data ?? []).filter((o) => isStoreTimedOut(o, now));
  let converted = 0;
  for (const o of due) {
    // Conditional on `pending`: if the merchant answered in the meantime, the merchant wins.
    const { data: moved } = await supabaseAdmin
      .from("orders")
      .update(SHOPPER_HANDOVER_PATCH)
      .eq("id", o.id)
      .eq("merchant_status", "pending")
      .eq("status", "processing")
      .select("id")
      .maybeSingle();
    if (!moved) continue;
    converted++;
    // The shopper order is in the pool now (a no-op until its checkout is offerable).
    await pushNewOffer(o.id);

    const ref = orderRef(o.id);
    const store: string = o.store_name ?? "";
    const copy = shopperHandoverCopy(store, ref);
    await createNotification({
      userId: o.customer_id,
      type: "order",
      ...copy.en,
      contentFr: copy.fr,
      contentAr: copy.ar,
    }).catch(() => null);

    const ownerId = (o.store as { owner_id?: string | null } | null)?.owner_id;
    if (ownerId) {
      await createNotification({
        userId: ownerId,
        type: "order",
        title: "Order handed to a Blink shopper",
        description: `You didn't answer order ${ref} within 10 minutes — a Blink rider will buy the items at ${store}.`,
        contentFr: {
          title: "Commande confiée à un livreur Blink",
          description: `Vous n'avez pas répondu à la commande ${ref} en 10 minutes — un livreur Blink achètera les articles chez ${store}.`,
        },
        contentAr: {
          title: "تم تحويل الطلب إلى مندوب Blink",
          description: `لم تردّ على الطلب ${ref} خلال 10 دقائق — سيشتري مندوب Blink المنتجات من ${store}.`,
        },
        href: "/(merchant)/orders",
      }).catch(() => null);
    }
  }
  return { checked: due.length, converted };
}
