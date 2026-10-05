import { supabaseAdmin } from "../../lib/supabase";
import { createRoute, errorResponses, json, router } from "../../openapi";
import { MessageResponse, sendOtpSchema } from "../../validators/auth";

const app = router();

// ─── Send OTP ────────────────────────────────────────────────────────
const route = createRoute({
  method: "post",
  path: "/otp/send",
  operationId: "sendOtp",
  tags: ["auth"],
  request: { body: { ...json(sendOtpSchema), required: true } },
  responses: { 200: json(MessageResponse), 400: errorResponses[400] },
});

app.openapi(route, async (c) => {
  const body = c.req.valid("json");

  const { error } = await supabaseAdmin.auth.signInWithOtp({
    phone: body.phone_number,
  });

  if (error) {
    return c.json({ error: error.message }, 400);
  }

  return c.json({ message: "OTP sent successfully" }, 200);
});

export default app;
