import { z } from "@hono/zod-openapi";
import { applyUploads, isOwnDocumentPath, type RiderDocumentKey } from "../../lib/rider-verification";
import { bearer, createRoute, ErrorSchema, errorResponses, json, router } from "../../openapi";
import { RiderDocumentsResponse, updateRiderDocumentsSchema } from "../../validators/riders";
import {
  documentObjectExists,
  documentsView,
  loadRiderVerification,
  RiderDataUnavailableError,
  writeRiderDocumentsCAS,
} from "./verification-shared";

const DocumentsConflictSchema = z
  .object({ error: z.string(), code: z.literal("documents_conflict") })
  .openapi("RiderDocumentsConflict");

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
      503: json(ErrorSchema, "Service unavailable"),
    },
  }),
  async (c) => {
    const user = c.get("user");
    try {
      const current = await loadRiderVerification(user.id);
      if (!current) return c.json({ error: "Rider profile not found" }, 404);
      return c.json(await documentsView(current), 200);
    } catch (e) {
      if (e instanceof RiderDataUnavailableError) return c.json({ error: "Service unavailable, please retry" }, 503);
      throw e;
    }
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
      409: json(DocumentsConflictSchema, "Documents changed concurrently"),
      503: json(ErrorSchema, "Service unavailable"),
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
    try {
      let current = await loadRiderVerification(user.id);
      if (!current) return c.json({ error: "Rider profile not found" }, 404);

      for (const [key, path] of Object.entries(body)) {
        if (path && current.documents[key as RiderDocumentKey]?.path !== path && !(await documentObjectExists(path))) {
          return c.json({ error: `File for ${key} was not uploaded` }, 400);
        }
      }

      // Compare-and-swap; on a lost race reload, re-apply and retry once.
      for (let attempt = 0; attempt < 2; attempt++) {
        const next = applyUploads(current, body, new Date().toISOString());
        if (next === current) return c.json(await documentsView(current), 200);
        const result = await writeRiderDocumentsCAS(
          user.id,
          current.documents,
          next.documents,
          next.verification_status
        );
        if (result === "ok") return c.json(await documentsView(next), 200);
        if (result === "error") return c.json({ error: "Service unavailable, please retry" }, 503);
        if (attempt === 0) {
          const reloaded = await loadRiderVerification(user.id);
          if (!reloaded) return c.json({ error: "Rider profile not found" }, 404);
          current = reloaded;
        }
      }
      return c.json({ error: "Your documents changed, please retry", code: "documents_conflict" as const }, 409);
    } catch (e) {
      if (e instanceof RiderDataUnavailableError) return c.json({ error: "Service unavailable, please retry" }, 503);
      throw e;
    }
  }
);

export default app;
