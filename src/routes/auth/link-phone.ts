import { isAuthOutage } from "../../lib/auth-outage";
import { PHONE_OWNER_MISMATCH } from "../../lib/roles";
import { supabaseAdmin } from "../../lib/supabase";
import { auth } from "../../middleware/auth";
import { bearer, createRoute, ErrorSchema, errorResponses, json, router } from "../../openapi";
import { linkPhoneSchema, MessageResponse } from "../../validators/auth";
import { e164 } from "./shared";

const app = router();

// ─── Verify the number on a Google/Apple account ─────────────────────
// An account made with Google/Apple can carry a phone number on its profile
// that was never verified, so a phone OTP login opens an empty phone-only
// login instead (POST /auth/otp/verify answers `link_provider`). Linking takes
// both proofs: this request is signed in as the account, and `phone_token` is
// the session that OTP returned. The number then moves onto the account's
// login, so the next OTP opens the account directly.
const route = createRoute({
  method: "post",
  path: "/phone/link",
  operationId: "linkPhone",
  tags: ["auth"],
  security: bearer,
  middleware: [auth] as const,
  request: { body: { ...json(linkPhoneSchema), required: true } },
  responses: {
    200: json(MessageResponse),
    400: errorResponses[400],
    401: errorResponses[401],
    403: json(ErrorSchema, "The number is saved on a different account (code: phone_owner_mismatch)"),
    409: json(ErrorSchema, "The phone session belongs to a real account, not an empty OTP login"),
    503: json(ErrorSchema, "Supabase unreachable — safe to retry"),
  },
});

app.openapi(route, async (c) => {
  const owner = c.get("user");
  const { phone_token } = c.req.valid("json");
  const unavailable = () =>
    c.json({ error: "Service temporarily unavailable, please retry" }, 503);

  let phoneAuth = await supabaseAdmin.auth.getUser(phone_token);
  if (isAuthOutage(phoneAuth.error)) phoneAuth = await supabaseAdmin.auth.getUser(phone_token);
  if (isAuthOutage(phoneAuth.error)) return unavailable();
  const phoneUser = phoneAuth.data.user;
  if (phoneAuth.error || !phoneUser?.phone) {
    return c.json({ error: "Phone verification expired — log in with your number again" }, 400);
  }

  if (owner.phone_number !== e164(phoneUser.phone)) {
    return c.json({ error: "This number is saved on a different account", code: PHONE_OWNER_MISMATCH }, 403);
  }
  // Already this account's login (a retry after success).
  if (phoneUser.id === owner.id) return c.json({ message: "Phone number linked" }, 200);

  // The phone session must be the empty login the OTP created — never remove
  // a real account.
  const { data: phoneRow, error: rowError } = await supabaseAdmin
    .from("users")
    .select("id")
    .eq("id", phoneUser.id)
    .maybeSingle();
  if (rowError) return unavailable();
  if (phoneRow || phoneUser.email) {
    return c.json({ error: "This number already has its own account" }, 409);
  }

  // auth.users allows one login per phone: free the number, then attach it.
  const { error: deleteError } = await supabaseAdmin.auth.admin.deleteUser(phoneUser.id);
  if (deleteError) {
    console.error("[auth/phone/link] removing the phone-only login failed:", deleteError.message);
    return unavailable();
  }
  const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(owner.id, {
    phone: phoneUser.phone,
    phone_confirm: true,
  });
  if (updateError) {
    console.error("[auth/phone/link] attaching the phone failed:", updateError.message);
    return unavailable();
  }

  return c.json({ message: "Phone number linked" }, 200);
});

export default app;
