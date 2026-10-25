// Provider-facing routes: NOT in OpenAPI, no bearer auth.
//  - POST /webhooks/chargily|stripe  signed server-to-server callbacks (RAW body is verified)
//  - GET  /return/{id}               where the gateway sends the customer back; redirects into the app
import { Hono } from "hono";
import { env } from "../../config/env";
import { appRedirectUrl, type Outcome } from "../../lib/payments/core";
import { getProvider } from "../../lib/payments/registry";
import { confirmOnReturn, handleWebhookEvent } from "../../lib/payments/service";
import { supabaseAdmin } from "../../lib/supabase";

const app = new Hono();

function webhook(providerId: "chargily" | "stripe") {
  return async (c: any) => {
    const provider = getProvider(providerId);
    // The signature covers the exact bytes: read the text before any JSON parsing.
    const raw = await c.req.text();
    if (!provider.verifyWebhook?.(raw, c.req.raw.headers)) return c.json({ error: "Invalid signature" }, 401);
    const event = provider.parseEvent?.(raw);
    if (!event) return c.json({ error: "Unreadable event" }, 400);
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(raw);
    } catch {}
    await handleWebhookEvent(providerId, event, payload);
    return c.json({ received: true }, 200);
  };
}

app.post("/webhooks/chargily", webhook("chargily"));
app.post("/webhooks/stripe", webhook("stripe"));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const COPY: Record<Outcome, { en: string; fr: string; ar: string }> = {
  success: { en: "Return to Blink", fr: "Retourner dans Blink", ar: "العودة إلى Blink" },
  failure: { en: "Return to Blink", fr: "Retourner dans Blink", ar: "العودة إلى Blink" },
};

app.get("/return/:id", async (c) => {
  const id = c.req.param("id");
  if (!UUID.test(id)) return c.text("Not found", 404);
  const outcome: Outcome = c.req.query("outcome") === "success" ? "success" : "failure";

  // SATIM has no webhook: its order is confirmed here, server to server.
  const { data: payment } = await supabaseAdmin.from("payments").select("*").eq("id", id).maybeSingle();
  if (payment?.provider === "satim") await confirmOnReturn(payment).catch((e) => console.error("[payments] satim return failed", e));

  const target = appRedirectUrl(env.APP_RETURN_URL, id, outcome);
  const label = COPY[outcome];
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Blink</title>
<meta http-equiv="refresh" content="0;url=${target}"></head><body style="font-family:system-ui,sans-serif;text-align:center;padding:48px 16px">
<p><a href="${target}" style="font-size:18px">${label.en}</a></p><p dir="ltr">${label.fr}</p><p dir="rtl">${label.ar}</p></body></html>`;
  return new Response(html, { status: 302, headers: { Location: target, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
});

export default app;
