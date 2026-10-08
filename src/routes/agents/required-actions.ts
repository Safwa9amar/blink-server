// Agent activation checklist — derived from the agent's real data so the app's
// Required Actions screen (and the profile badge) can't drift from it.
import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import { AgentRequiredActionsResponse } from "../../validators/agents";
import { primaryShop } from "./shared";

const app = router();

type Row = Record<string, any>;
type Status = "done" | "missing_info" | "in_progress" | "rejected";

function commercialRegister(docs: Row) {
  const sides = { front: docs.commercial_register_front, back: docs.commercial_register_back };
  const missing = Object.entries(sides)
    .filter(([, d]) => !d?.url)
    .map(([side]) => side);
  const rejected = Object.values(sides).find((d) => d?.status === "rejected");
  let status: Status = "done";
  if (rejected) status = "rejected";
  else if (missing.length) status = "missing_info";
  else if (Object.values(sides).some((d) => d?.status !== "verified")) status = "in_progress";
  return { key: "commercial_register" as const, status, missing, reason: rejected?.reason ?? null };
}

app.openapi(
  createRoute({
    method: "get",
    path: "/required-actions",
    operationId: "getAgentRequiredActions",
    tags: ["agents"],
    security: bearer,
    responses: {
      200: json(AgentRequiredActionsResponse),
      401: errorResponses[401],
      403: errorResponses[403],
    },
  }),
  async (c) => {
    // users.wilaya / bank_rib (00012) aren't in the generated UserRow type.
    const user = c.get("user") as Row;
    const [{ data: profile }, shop] = await Promise.all([
      supabaseAdmin.from("agent_profiles").select("documents").eq("user_id", user.id).maybeSingle(),
      primaryShop(user.id),
    ]);
    const docs: Row = profile?.documents ?? {};

    const missingTax = ["nif", "nis"].filter((k) => !String(docs[k] ?? "").trim());
    const missingPersonal = [
      ["first_name", user.first_name],
      ["phone_number", user.phone_number],
      ["wilaya", user.wilaya],
      ["bank_rib", user.bank_rib],
    ]
      .filter(([, v]) => !String(v ?? "").trim())
      .map(([k]) => k as string);
    const missingShop = [
      ["shop_name", shop?.shop_name],
      ["location", shop && (shop.latitude || shop.longitude) ? "set" : ""],
    ]
      .filter(([, v]) => !String(v ?? "").trim())
      .map(([k]) => k as string);
    const shopStatus: Status = missingShop.length
      ? "missing_info"
      : shop?.review_status === "rejected"
        ? "rejected"
        : shop?.review_status === "under_review"
          ? "in_progress"
          : "done";

    const actions = [
      commercialRegister(docs),
      {
        key: "tax_ids" as const,
        status: (missingTax.length ? "missing_info" : "done") as Status,
        missing: missingTax,
        reason: null,
      },
      {
        key: "personal_info" as const,
        status: (missingPersonal.length ? "missing_info" : "done") as Status,
        missing: missingPersonal,
        reason: null,
      },
      { key: "shop_setup" as const, status: shopStatus, missing: missingShop, reason: null },
      {
        key: "blink_cash_pin" as const,
        status: (user.pin_hash ? "done" : "missing_info") as Status,
        missing: user.pin_hash ? [] : ["pin"],
        reason: null,
      },
    ];

    return c.json(
      {
        actions,
        completed: actions.filter((a) => a.status === "done").length,
        total: actions.length,
      },
      200
    );
  }
);

export default app;
