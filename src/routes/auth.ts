import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase";
import { auth, requireRole, type AuthEnv } from "../middleware/auth";
import {
  sendOtpSchema,
  verifyOtpSchema,
  selectRoleSchema,
  updateProfileSchema,
  setupPinSchema,
  verifyPinSchema,
} from "../validators/auth";
import { hashPin, verifyPin } from "../lib/pin";

const app = new Hono<AuthEnv>();

// ─── Send OTP ────────────────────────────────────────────────────────
app.post("/otp/send", async (c) => {
  const body = sendOtpSchema.parse(await c.req.json());

  const { error } = await supabaseAdmin.auth.signInWithOtp({
    phone: body.phone_number,
  });

  if (error) {
    return c.json({ error: error.message }, 400);
  }

  return c.json({ message: "OTP sent successfully" });
});

// ─── Verify OTP ──────────────────────────────────────────────────────
app.post("/otp/verify", async (c) => {
  const body = verifyOtpSchema.parse(await c.req.json());

  const { data, error } = await supabaseAdmin.auth.verifyOtp({
    phone: body.phone_number,
    token: body.otp,
    type: "sms",
  });

  if (error || !data.session) {
    return c.json({ error: error?.message ?? "Verification failed" }, 400);
  }

  // Check if user profile exists
  const { data: existingUser } = await supabaseAdmin
    .from("users")
    .select("*")
    .eq("id", data.user!.id)
    .single();

  const isNewUser = !existingUser;

  if (isNewUser) {
    // Create user profile stub
    await supabaseAdmin.from("users").insert({
      id: data.user!.id,
      phone_number: body.phone_number,
      role: "customer", // default, changed in role selection
    });
  }

  return c.json({
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
    is_new_user: isNewUser,
    user: existingUser ?? { id: data.user!.id, phone_number: body.phone_number },
  });
});

// ─── Refresh Token ───────────────────────────────────────────────────
app.post("/refresh", async (c) => {
  const { refresh_token } = await c.req.json();

  if (!refresh_token) {
    return c.json({ error: "refresh_token is required" }, 400);
  }

  const { data, error } = await supabaseAdmin.auth.refreshSession({
    refresh_token,
  });

  if (error || !data.session) {
    return c.json({ error: error?.message ?? "Could not refresh session" }, 401);
  }

  return c.json({
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
  });
});

// ─── Select Role (post-registration) ────────────────────────────────
app.post("/role", auth, async (c) => {
  const body = selectRoleSchema.parse(await c.req.json());
  const userId = c.get("userId");

  const { error } = await supabaseAdmin
    .from("users")
    .update({ role: body.role })
    .eq("id", userId);

  if (error) {
    return c.json({ error: error.message }, 400);
  }

  // Create role-specific profile
  if (body.role === "rider") {
    const riderId = `BK-${Math.floor(1000 + Math.random() * 9000)}`;
    await supabaseAdmin.from("rider_profiles").insert({
      user_id: userId,
      rider_id: riderId,
    });
  } else if (body.role === "agent") {
    await supabaseAdmin.from("agent_shops").insert({
      user_id: userId,
      shop_name: "",
      open_time: "08:00",
      close_time: "20:00",
      status: "closed",
      latitude: 0,
      longitude: 0,
      rating: 0,
    });
  }

  return c.json({ message: "Role updated", role: body.role });
});

// ─── Update Profile ──────────────────────────────────────────────────
app.patch("/profile", auth, async (c) => {
  const body = updateProfileSchema.parse(await c.req.json());
  const userId = c.get("userId");

  const { data, error } = await supabaseAdmin
    .from("users")
    .update(body)
    .eq("id", userId)
    .select()
    .single();

  if (error) {
    return c.json({ error: error.message }, 400);
  }

  return c.json({ user: data });
});

// ─── Get Profile ─────────────────────────────────────────────────────
app.get("/profile", auth, async (c) => {
  const user = c.get("user");

  // Attach role-specific data
  let roleData: Record<string, unknown> = {};

  if (user.role === "rider") {
    const { data } = await supabaseAdmin
      .from("rider_profiles")
      .select("*")
      .eq("user_id", user.id)
      .single();
    roleData = { rider_profile: data };

    const { data: vehicle } = await supabaseAdmin
      .from("vehicles")
      .select("*")
      .eq("user_id", user.id)
      .single();
    roleData.vehicle = vehicle;
  } else if (user.role === "agent") {
    const { data } = await supabaseAdmin
      .from("agent_shops")
      .select("*")
      .eq("user_id", user.id)
      .single();
    roleData = { shop: data };
  }

  return c.json({ user, ...roleData });
});

// ─── Setup PIN ───────────────────────────────────────────────────────
app.post("/pin/setup", auth, async (c) => {
  const body = setupPinSchema.parse(await c.req.json());
  const userId = c.get("userId");

  const pinHash = await hashPin(body.pin);

  const { error } = await supabaseAdmin
    .from("users")
    .update({ pin_hash: pinHash })
    .eq("id", userId);

  if (error) {
    return c.json({ error: error.message }, 400);
  }

  return c.json({ message: "PIN set successfully" });
});

// ─── Verify PIN ──────────────────────────────────────────────────────
app.post("/pin/verify", auth, async (c) => {
  const body = verifyPinSchema.parse(await c.req.json());
  const user = c.get("user");

  if (!user.pin_hash) {
    return c.json({ error: "PIN not set up" }, 400);
  }

  const valid = await verifyPin(body.pin, user.pin_hash);
  if (!valid) {
    return c.json({ error: "Invalid PIN" }, 401);
  }

  return c.json({ valid: true });
});

export default app;
