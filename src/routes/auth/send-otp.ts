import { createAuthClient } from "../../lib/supabase";
import { createRoute, errorResponses, json, router } from "../../openapi";
import { MessageResponse, sendOtpSchema } from "../../validators/auth";

const app = router();

// ─── Send OTP ────────────────────────────────────────────────────────
// Supabase generates the code and hands it to the Send SMS hook
// (POST /hooks/send-sms), which texts it through SMS Gate.
const route = createRoute({
  method: "post",
  path: "/otp/send",
  operationId: "sendOtp",
  tags: ["auth"],
  request: { body: { ...json(sendOtpSchema), required: true } },
  responses: {
    200: json(MessageResponse),
    400: errorResponses[400],
    429: errorResponses[429],
  },
});

app.openapi(route, async (c) => {
  const body = c.req.valid("json");

  const { error } = await createAuthClient().auth.signInWithOtp({
    phone: body.phone_number,
  });

  if (error) {
    // Supabase throttles per number (sms max_frequency) and per project.
    if (error.status === 429) {
      return c.json({ error: error.message }, 429);
    }
    return c.json({ error: error.message }, 400);
  }

  return c.json({ message: "OTP sent successfully" }, 200);
});

export default app;
