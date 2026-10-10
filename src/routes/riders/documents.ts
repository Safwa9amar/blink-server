import { applyUploads, isOwnDocumentPath, type RiderDocumentKey } from "../../lib/rider-verification";
import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import { RiderDocumentsResponse, updateRiderDocumentsSchema } from "../../validators/riders";
import { documentObjectExists, documentsView, loadRiderVerification } from "./verification-shared";

const app = router();

// ─── GET /riders/documents — status, staff notes, signed previews ────
app.openapi(
  createRoute({
    method: "get",
    path: "/documents",
    operationId: "getRiderDocuments",
    tags: ["riders"],
    security: bearer,
    responses: {
      200: json(RiderDocumentsResponse),
      401: errorResponses[401],
      403: errorResponses[403],
      404: errorResponses[404],
    },
  }),
  async (c) => {
    const user = c.get("user");
    const current = await loadRiderVerification(user.id);
    if (!current) return c.json({ error: "Rider profile not found" }, 404);
    return c.json(await documentsView(current), 200);
  }
);

// ─── PATCH /riders/documents — attach uploaded files ─────────────────
// Each new path goes (back) to `pending`; with all four present and none
// rejected the rider moves to `pending` review (src/lib/rider-verification.ts).
// Paths must be this rider's own upload for that slot AND exist in the bucket.
app.openapi(
  createRoute({
    method: "patch",
    path: "/documents",
    operationId: "updateRiderDocuments",
    tags: ["riders"],
    security: bearer,
    request: { body: { ...json(updateRiderDocumentsSchema), required: true } },
    responses: {
      200: json(RiderDocumentsResponse),
      400: errorResponses[400],
      401: errorResponses[401],
      403: errorResponses[403],
      404: errorResponses[404],
    },
  }),
  async (c) => {
    const user = c.get("user");
    const body = c.req.valid("json");
    for (const [key, path] of Object.entries(body)) {
      if (path && !isOwnDocumentPath(user.id, key as RiderDocumentKey, path)) {
        return c.json({ error: `Invalid file for ${key}` }, 400);
      }
    }
    const current = await loadRiderVerification(user.id);
    if (!current) return c.json({ error: "Rider profile not found" }, 404);

    for (const [key, path] of Object.entries(body)) {
      if (path && current.documents[key as RiderDocumentKey]?.path !== path && !(await documentObjectExists(path))) {
        return c.json({ error: `File for ${key} was not uploaded` }, 400);
      }
    }

    const next = applyUploads(current, body, new Date().toISOString());
    if (next !== current) {
      const { error } = await supabaseAdmin
        .from("rider_profiles")
        .update({ documents: next.documents, verification_status: next.verification_status })
        .eq("user_id", user.id);
      if (error) return c.json({ error: error.message }, 400);
    }
    return c.json(await documentsView(next), 200);
  }
);

export default app;
