import { Hono } from "hono";
import { z } from "zod";
import { supabaseAdmin } from "../../lib/supabase";
import { auth, type AuthEnv } from "../../middleware/auth";

const AVATARS_BUCKET = "avatars";
const MAX_BYTES = 6 * 1024 * 1024; // 6MB decoded cap

const EXT_BY_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

const uploadAvatarSchema = z.object({
  image_base64: z.string().min(1),
  content_type: z.enum(["image/jpeg", "image/jpg", "image/png", "image/webp"]),
});

const app = new Hono<AuthEnv>();

// ─── Upload avatar to Supabase Storage ───────────────────────────────
// Uploads via the service role (the storage service rejects direct client
// session tokens in some setups, so the server does the write). Returns the
// public URL; the client persists it to users.profile_picture via supabase.
app.post("/avatar", auth, async (c) => {
  const userId = c.get("userId");
  const body = uploadAvatarSchema.parse(await c.req.json());

  const bytes = Buffer.from(body.image_base64, "base64");
  if (bytes.length === 0) return c.json({ error: "Empty image payload" }, 400);
  if (bytes.length > MAX_BYTES)
    return c.json({ error: "Image too large (max 6MB)" }, 413);

  const ext = EXT_BY_TYPE[body.content_type] ?? "jpg";
  const path = `${userId}/avatar-${Date.now()}.${ext}`;

  const { error: uploadError } = await supabaseAdmin.storage
    .from(AVATARS_BUCKET)
    .upload(path, bytes, { contentType: body.content_type, upsert: true });

  if (uploadError) {
    return c.json({ error: uploadError.message }, 400);
  }

  const {
    data: { publicUrl },
  } = supabaseAdmin.storage.from(AVATARS_BUCKET).getPublicUrl(path);

  return c.json({ url: publicUrl });
});

export default app;
