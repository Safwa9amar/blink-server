// Staff Blink Cash settings (the single blink_cash_settings row) and deposit
// offers. Tagged admin-* so orval skips it; every write is audited.
import { recordFinanceAudit } from "../../lib/finance-audit";
import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import {
  BlinkCashSettingsResponse,
  CreateOfferBody,
  OfferIdParam,
  OfferResponse,
  OffersQuery,
  OffersResponse,
  offerRuleIssues,
  settingsRuleIssues,
  UpdateBlinkCashSettingsBody,
  UpdateOfferBody,
  type BlinkCashSettingsInput,
} from "../../validators/blink-cash-admin";
import { PAGE_SIZE, staff } from "./admin-shared";
import { invalidateBlinkCashSettings } from "../../lib/blink-cash-settings";

const app = router();

const TAG = ["admin-blink-cash"];

async function readSettings() {
  const { data, error } = await supabaseAdmin.from("blink_cash_settings").select("*").eq("id", true).maybeSingle();
  if (error) throw new Error(`[blink-cash-admin] settings read failed: ${error.message}`);
  return (data ?? null) as Record<string, unknown> | null;
}

// ─── Settings ────────────────────────────────────────────────────────
app.openapi(
  createRoute({
    method: "get",
    path: "/admin/settings",
    operationId: "getBlinkCashSettingsAdmin",
    tags: TAG,
    security: bearer,
    middleware: [staff] as const,
    responses: { 200: json(BlinkCashSettingsResponse), 401: errorResponses[401], 403: errorResponses[403], 404: errorResponses[404] },
  }),
  async (c) => {
    const settings = await readSettings();
    if (!settings) return c.json({ error: "Settings not found" }, 404);
    return c.json({ settings }, 200);
  }
);

app.openapi(
  createRoute({
    method: "put",
    path: "/admin/settings",
    operationId: "updateBlinkCashSettingsAdmin",
    tags: TAG,
    security: bearer,
    middleware: [staff] as const,
    request: { body: { ...json(UpdateBlinkCashSettingsBody), required: true } },
    responses: {
      200: json(BlinkCashSettingsResponse),
      400: errorResponses[400],
      401: errorResponses[401],
      403: errorResponses[403],
    },
  }),
  async (c) => {
    const actor = c.get("user");
    const patch = c.req.valid("json");
    const before = await readSettings();

    // Rules that span several columns run on the merged result.
    const issues = settingsRuleIssues({ ...(before as Partial<BlinkCashSettingsInput> | null), ...patch });
    if (issues.length) return c.json({ error: issues.join("; "), code: "invalid_settings" }, 400);

    const { data, error } = await supabaseAdmin
      .from("blink_cash_settings")
      .upsert({ id: true, ...patch, updated_by: actor.id, updated_at: new Date().toISOString() }, { onConflict: "id" })
      .select("*")
      .single();
    if (error || !data) throw new Error(`[blink-cash-admin] settings write failed: ${error?.message}`);
    // This instance reads the new values at once; the other one within its 30 s cache.
    invalidateBlinkCashSettings();

    const changed = Object.keys(patch);
    await recordFinanceAudit({
      actorId: actor.id,
      action: "settings.update",
      targetType: "settings",
      targetId: "blink_cash_settings",
      details: {
        changed,
        before: Object.fromEntries(changed.map((k) => [k, before?.[k] ?? null])),
        after: Object.fromEntries(changed.map((k) => [k, (patch as Record<string, unknown>)[k]])),
      },
    });
    return c.json({ settings: data as Record<string, unknown> }, 200);
  }
);

// ─── Offers ──────────────────────────────────────────────────────────
app.openapi(
  createRoute({
    method: "get",
    path: "/admin/offers",
    operationId: "listBlinkCashOffersAdmin",
    tags: TAG,
    security: bearer,
    middleware: [staff] as const,
    request: { query: OffersQuery },
    responses: { 200: json(OffersResponse), 401: errorResponses[401], 403: errorResponses[403] },
  }),
  async (c) => {
    const { active, page } = c.req.valid("query");
    let q = supabaseAdmin.from("blink_cash_offers").select("*", { count: "exact" });
    if (active) q = q.eq("active", active === "true");
    const { data, count, error } = await q
      .order("created_at", { ascending: false })
      .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);
    if (error) throw new Error(`[blink-cash-admin] offers read failed: ${error.message}`);
    return c.json({ offers: (data ?? []) as Record<string, unknown>[], total: count ?? 0 }, 200);
  }
);

app.openapi(
  createRoute({
    method: "post",
    path: "/admin/offers",
    operationId: "createBlinkCashOfferAdmin",
    tags: TAG,
    security: bearer,
    middleware: [staff] as const,
    request: { body: { ...json(CreateOfferBody), required: true } },
    responses: { 201: json(OfferResponse), 400: errorResponses[400], 401: errorResponses[401], 403: errorResponses[403] },
  }),
  async (c) => {
    const actor = c.get("user");
    const body = c.req.valid("json");
    const issues = offerRuleIssues(body);
    if (issues.length) return c.json({ error: issues.join("; "), code: "invalid_offer" }, 400);

    const { data, error } = await supabaseAdmin
      .from("blink_cash_offers")
      .insert({ ...body, created_by: actor.id })
      .select("*")
      .single();
    if (error || !data) throw new Error(`[blink-cash-admin] offer create failed: ${error?.message}`);

    await recordFinanceAudit({
      actorId: actor.id,
      action: "offer.create",
      targetType: "offer",
      targetId: data.id,
      details: { offer: body },
    });
    return c.json({ offer: data as Record<string, unknown> }, 201);
  }
);

app.openapi(
  createRoute({
    method: "patch",
    path: "/admin/offers/{id}",
    operationId: "updateBlinkCashOfferAdmin",
    tags: TAG,
    security: bearer,
    middleware: [staff] as const,
    request: { params: OfferIdParam, body: { ...json(UpdateOfferBody), required: true } },
    responses: {
      200: json(OfferResponse),
      400: errorResponses[400],
      401: errorResponses[401],
      403: errorResponses[403],
      404: errorResponses[404],
    },
  }),
  async (c) => {
    const actor = c.get("user");
    const { id } = c.req.valid("param");
    const patch = c.req.valid("json");

    const { data: current, error: readError } = await supabaseAdmin.from("blink_cash_offers").select("*").eq("id", id).maybeSingle();
    if (readError) throw new Error(`[blink-cash-admin] offer read failed: ${readError.message}`);
    if (!current) return c.json({ error: "Offer not found" }, 404);

    const issues = offerRuleIssues({ ...current, ...patch });
    if (issues.length) return c.json({ error: issues.join("; "), code: "invalid_offer" }, 400);

    const { data, error } = await supabaseAdmin
      .from("blink_cash_offers")
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("id", id)
      .select("*")
      .single();
    if (error || !data) throw new Error(`[blink-cash-admin] offer update failed: ${error?.message}`);

    const changed = Object.keys(patch);
    await recordFinanceAudit({
      actorId: actor.id,
      // Archiving is `active: false`.
      action: patch.active === false && current.active ? "offer.archive" : "offer.update",
      targetType: "offer",
      targetId: id,
      details: {
        changed,
        before: Object.fromEntries(changed.map((k) => [k, current[k] ?? null])),
        after: patch,
      },
    });
    return c.json({ offer: data as Record<string, unknown> }, 200);
  }
);

export default app;
