import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, ErrorSchema, errorResponses, json, router } from "../../openapi";
import { merchantUploadSchema, MerchantUploadResponse } from "../../validators/merchant";

const BUCKET = "merchant";
const MAX_BYTES = 8 * 1024 * 1024; // 8MB decoded cap

const EXT_BY_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
};

const app = router();

// ─── Merchant: upload a store/product photo or a verification document ─
// Same service-role flow as /auth/avatar; returns the public URL to store on
// the store / product / documents row.
const route = createRoute({
  method: "post",
  path: "/uploads",
  operationId: "uploadMerchantFile",
  tags: ["merchant"],
  security: bearer,
  request: { body: { ...json(merchantUploadSchema), required: true } },
  responses: {
    200: json(MerchantUploadResponse),
    400: errorResponses[400],
    401: errorResponses[401],
    403: errorResponses[403],
    413: json(ErrorSchema, "File too large"),
  },
});

app.openapi(route, async (c) => {
  const userId = c.get("userId");
  const body = c.req.valid("json");

  const ext = EXT_BY_TYPE[body.content_type];
  if (!ext) return c.json({ error: "Unsupported file type" }, 400);

  const bytes = Buffer.from(body.base64, "base64");
  if (bytes.length === 0) return c.json({ error: "Empty file" }, 400);
  if (bytes.length > MAX_BYTES) return c.json({ error: "File too large (max 8MB)" }, 413);

  const folder = body.kind === "document" ? "documents" : "images";
  const path = `${userId}/${folder}/${Date.now()}-${Math.round(Math.random() * 1e6)}.${ext}`;

  const { error } = await supabaseAdmin.storage
    .from(BUCKET)
    .upload(path, bytes, { contentType: body.content_type, upsert: false });
  if (error) return c.json({ error: error.message }, 400);

  const {
    data: { publicUrl },
  } = supabaseAdmin.storage.from(BUCKET).getPublicUrl(path);
  return c.json({ url: publicUrl }, 200);
});

export default app;
