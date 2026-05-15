import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase";
import { auth, type AuthEnv } from "../middleware/auth";
import { z } from "zod";

const app = new Hono<AuthEnv>();

app.use("/*", auth);

// ─── List notifications ──────────────────────────────────────────────
app.get("/", async (c) => {
  const user = c.get("user");
  const page = Number(c.req.query("page") ?? 1);
  const limit = Number(c.req.query("limit") ?? 20);
  const offset = (page - 1) * limit;

  const { data, error, count } = await supabaseAdmin
    .from("notifications")
    .select("*", { count: "exact" })
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    return c.json({ error: error.message }, 400);
  }

  return c.json({
    notifications: data,
    unread_count: data?.filter((n) => n.is_unread).length ?? 0,
    pagination: { page, limit, total: count ?? 0 },
  });
});

// ─── Get single notification ─────────────────────────────────────────
app.get("/:id", async (c) => {
  const user = c.get("user");
  const notifId = c.req.param("id");

  const { data, error } = await supabaseAdmin
    .from("notifications")
    .select("*")
    .eq("id", notifId)
    .eq("user_id", user.id)
    .single();

  if (error || !data) {
    return c.json({ error: "Notification not found" }, 404);
  }

  return c.json({ notification: data });
});

// ─── Mark as read ────────────────────────────────────────────────────
app.patch("/:id/read", async (c) => {
  const user = c.get("user");
  const notifId = c.req.param("id");

  const { data, error } = await supabaseAdmin
    .from("notifications")
    .update({ is_unread: false })
    .eq("id", notifId)
    .eq("user_id", user.id)
    .select()
    .single();

  if (error || !data) {
    return c.json({ error: "Notification not found" }, 404);
  }

  return c.json({ notification: data });
});

// ─── Mark all as read ────────────────────────────────────────────────
app.patch("/read-all", async (c) => {
  const user = c.get("user");

  const { error } = await supabaseAdmin
    .from("notifications")
    .update({ is_unread: false })
    .eq("user_id", user.id)
    .eq("is_unread", true);

  if (error) {
    return c.json({ error: error.message }, 400);
  }

  return c.json({ message: "All notifications marked as read" });
});

export default app;
