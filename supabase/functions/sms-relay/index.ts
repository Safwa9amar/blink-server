// blink-server → SMS Gate relay (staff notification texts; the same Android
// phone that sends OTPs through send-sms).
//
// The SMS Gate credentials live once, as Edge Function secrets shared with
// send-sms, so the API hosts (Render primary + spare) don't each need a copy.
// blink-server calls this with its Supabase secret key on the `apikey` header,
// checked against the project's own keys, so only our backend can send. Deploy
// with verify_jwt = false: sb_secret_ keys aren't JWTs.
//
//   GET                    → { configured }  are the SMS Gate secrets set?
//   POST { phones, text }  → { queued }      one text to 1–50 E.164 numbers
//
// Secrets (same as send-sms): SMS_GATE_USERNAME / SMS_GATE_PASSWORD, optional
// SMS_GATE_SIM_NUMBER and SMS_GATE_URL.

const gateUrl = (Deno.env.get("SMS_GATE_URL") || "https://api.sms-gate.app/3rdparty/v1").replace(/\/$/, "");
const gateUser = Deno.env.get("SMS_GATE_USERNAME") ?? "";
const gatePass = Deno.env.get("SMS_GATE_PASSWORD") ?? "";
const simNumber = Number(Deno.env.get("SMS_GATE_SIM_NUMBER")) || undefined;

/** blink-server sends at most 50 numbers per request (notification-sms BATCH). */
const MAX_PHONES = 50;
/** sms-text SMS_MAX_CHARS. */
const MAX_TEXT = 480;
const E164 = /^\+\d{9,15}$/;

/** The project's secret keys: the new sb_secret_ ones (by name) and the legacy service_role key. */
function secretKeys(): string[] {
  const keys: string[] = [];
  try {
    keys.push(...Object.values(JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}") as Record<string, string>));
  } catch {
    // Unset or malformed: only the legacy key below.
  }
  keys.push(Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");
  return keys.filter(Boolean);
}

const keys = secretKeys();
const encoder = new TextEncoder();

/** Constant-time compare, so the key can't be guessed byte by byte. */
function same(a: string, b: string): boolean {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

const fail = (error: string, status: number) => Response.json({ error }, { status });

Deno.serve(async (req) => {
  const key = req.headers.get("apikey") ?? "";
  if (!key || !keys.some((k) => same(k, key))) return fail("Unauthorized", 401);

  const configured = Boolean(gateUser && gatePass);
  if (req.method === "GET") return Response.json({ configured });
  if (req.method !== "POST") return fail("Method not allowed", 405);
  if (!configured) return fail("SMS Gate is not configured", 503);

  let body: { phones?: unknown; text?: unknown };
  try {
    body = await req.json();
  } catch {
    return fail("Invalid JSON", 400);
  }
  const { phones, text } = body;
  if (
    !Array.isArray(phones) ||
    phones.length === 0 ||
    phones.length > MAX_PHONES ||
    !phones.every((p) => typeof p === "string" && E164.test(p))
  ) {
    return fail(`phones must be 1–${MAX_PHONES} E.164 numbers`, 400);
  }
  if (typeof text !== "string" || !text.trim() || text.length > MAX_TEXT) {
    return fail(`text must be 1–${MAX_TEXT} characters`, 400);
  }

  try {
    const res = await fetch(`${gateUrl}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(`${gateUser}:${gatePass}`)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ textMessage: { text }, phoneNumbers: phones, simNumber }),
      // blink-server gives up after 15 s; answer first so the error is ours.
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 200);
      console.error(`[sms-relay] SMS Gate ${res.status}: ${detail}`);
      return fail(`SMS Gate ${res.status}: ${detail}`, 502);
    }
  } catch (err) {
    console.error("[sms-relay] SMS Gate unreachable:", err);
    return fail("SMS Gate unreachable", 502);
  }

  return Response.json({ queued: phones.length });
});
