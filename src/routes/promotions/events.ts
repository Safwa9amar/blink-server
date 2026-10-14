import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import { TrackPromotionEventsResponse, trackPromotionEventsSchema } from "../../validators/promotions";

const app = router();

// ─── Track promotion views / taps (Reach, CTR) ───────────────────────
const route = createRoute({
  method: "post",
  path: "/events",
  operationId: "trackPromotionEvents",
  tags: ["promotions"],
  security: bearer,
  request: { body: { ...json(trackPromotionEventsSchema), required: true } },
  responses: {
    200: json(TrackPromotionEventsResponse),
    400: errorResponses[400],
  },
});

app.openapi(route, async (c) => {
  const user = c.get("user");
  const { events } = c.req.valid("json");

  // Drop events for promotions that don't exist (deleted, bad ids).
  const ids = [...new Set(events.map((e) => e.promotion_id))];
  const { data: known, error: lookupErr } = await supabaseAdmin.from("promotions").select("id").in("id", ids);
  if (lookupErr) return c.json({ error: lookupErr.message }, 400);

  const exists = new Set((known ?? []).map((r) => r.id));
  const rows = events
    .filter((e) => exists.has(e.promotion_id))
    .map((e) => ({ promotion_id: e.promotion_id, event: e.event, user_id: user.id }));
  if (rows.length === 0) return c.json({ accepted: 0 }, 200);

  const { error } = await supabaseAdmin.from("promotion_events").insert(rows);
  if (error) return c.json({ error: error.message }, 400);

  return c.json({ accepted: rows.length }, 200);
});

export default app;
