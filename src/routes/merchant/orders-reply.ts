import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, errorResponses, IdParam, json, router } from "../../openapi";
import { MerchantOrderResponse, reviewReplySchema } from "../../validators/merchant";
import { ownedStore } from "./shared";

const app = router();

// ─── Merchant: reply to a customer's rating/review ───────────────────
const route = createRoute({
  method: "post",
  path: "/orders/{id}/review-reply",
  operationId: "replyToOrderReview",
  tags: ["merchant"],
  security: bearer,
  request: { params: IdParam, body: { ...json(reviewReplySchema), required: true } },
  responses: {
    200: json(MerchantOrderResponse),
    400: errorResponses[400],
    401: errorResponses[401],
    403: errorResponses[403],
    404: errorResponses[404],
  },
});

app.openapi(route, async (c) => {
  const user = c.get("user");
  const { id } = c.req.valid("param");
  const { reply } = c.req.valid("json");

  const { data: order } = await supabaseAdmin
    .from("orders")
    .select("id, store_id, store_rating")
    .eq("id", id)
    .maybeSingle();
  if (!order?.store_id || !(await ownedStore(user.id, order.store_id))) {
    return c.json({ error: "Order not found" }, 404);
  }
  if (!order.store_rating) return c.json({ error: "This order has no review" }, 400);

  const { data, error } = await supabaseAdmin
    .from("orders")
    .update({ store_review_reply: reply, store_review_replied_at: new Date().toISOString() })
    .eq("id", id)
    .select()
    .single();
  if (error || !data) return c.json({ error: error?.message ?? "Order not found" }, 400);
  return c.json({ order: data }, 200);
});

export default app;
