import { matchesDeclaredType } from "../../lib/file-signature";
import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, ErrorSchema, errorResponses, json, router } from "../../openapi";
import { riderUploadSchema, RiderUploadResponse } from "../../validators/riders";
import { RIDER_DOCS_BUCKET } from "./verification-shared";

const MAX_BYTES = 8 * 1024 * 1024; // 8MB decoded cap (= bucket file_size_limit)

const EXT_BY_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
};

const app = router();

// ─── Rider: upload a verification document (licence / national ID) ──
// Private bucket: returns the object path, which the app then saves with
// PATCH /riders/documents. Nobody gets a public URL.
const route = createRoute({
  method: "post",
  path: "/uploads",
  operationId: "uploadRiderFile",
  tags: ["riders"],
  security: bearer,
  request: { body: { ...json(riderUploadSchema), required: true } },
  responses: {
    200: json(RiderUploadResponse),
    400: errorResponses[400],
    401: errorResponses[401],
    403: errorResponses[403],
    413: json(ErrorSchema, "File too large"),
    503: json(ErrorSchema, "Storage unavailable"),
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

  if (!matchesDeclaredType(bytes, body.content_type)) {
    return c.json({ error: "File content doesn't match its type" }, 400);
  }

  // Shape must satisfy isOwnDocumentPath (src/lib/rider-verification.ts).
  const path = `${userId}/${body.document}/${Date.now()}-${Math.round(Math.random() * 1e6)}.${ext}`;
  const { error } = await supabaseAdmin.storage
    .from(RIDER_DOCS_BUCKET)
    .upload(path, bytes, { contentType: body.content_type, upsert: false });
  if (error) {
    // 4xx from storage = client mistake; anything else (5xx / network) is transient.
    const status = Number((error as { status?: number }).status);
    if (status >= 400 && status < 500) return c.json({ error: error.message }, 400);
    return c.json({ error: "Storage unavailable, please retry" }, 503);
  }
  return c.json({ path }, 200);
});

export default app;
