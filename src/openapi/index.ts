// ─── OpenAPI building blocks ─────────────────────────────────────────
// The mobile app's API client is generated (orval) from the spec these
// helpers produce, so every app-facing route is declared with `createRoute`
// on an `OpenAPIHono` router. Run `npm run openapi` to write openapi.json.
//
// Response bodies are snake_case because handlers return PostgREST rows
// (supabase-js), so `rowSchema` re-keys Drizzle's camelCase columns by their
// DB names.
import { OpenAPIHono, z, type Hook } from "@hono/zod-openapi";
import { getTableColumns, type Table } from "drizzle-orm";
import { createSelectSchema } from "drizzle-zod";
import type { AuthEnv } from "../middleware/auth";

export { z, createRoute } from "@hono/zod-openapi";

// Same `{ error, details }` shape the global errorHandler returns for ZodErrors,
// so request validation failures look identical whether they come from a
// converted route or a legacy one.
const validationHook: Hook<any, any, any, any> = (result, c) => {
  if (!result.success) {
    return c.json(
      {
        error: "Validation error",
        details: result.error.issues.map((e) => ({
          path: e.path.join("."),
          message: e.message,
        })),
      },
      400
    );
  }
};

/** Router factory — use instead of `new Hono<AuthEnv>()` in route files. */
export function router() {
  return new OpenAPIHono<AuthEnv>({ defaultHook: validationHook });
}

// ─── Shared schemas ──────────────────────────────────────────────────

export const ErrorSchema = z
  .object({
    error: z.string(),
    details: z
      .array(z.object({ path: z.string(), message: z.string() }))
      .optional(),
  })
  .openapi("ApiErrorBody");

export const PaginationSchema = z
  .object({ page: z.number().int(), limit: z.number().int(), total: z.number().int() })
  .openapi("Pagination");

export const IdParam = z.object({
  id: z.string().openapi({ param: { name: "id", in: "path" } }),
});

export const OkSchema = z.object({ success: z.boolean() }).openapi("Ok");

/** `{ description, content: application/json }` shorthand for responses/bodies. */
export function json<T extends z.ZodTypeAny>(schema: T, description = "OK") {
  return { description, content: { "application/json": { schema } } };
}

/** Standard error responses every authenticated route can return. */
export const errorResponses = {
  400: json(ErrorSchema, "Bad request"),
  401: json(ErrorSchema, "Unauthorized"),
  403: json(ErrorSchema, "Forbidden"),
  404: json(ErrorSchema, "Not found"),
  429: json(ErrorSchema, "Too many requests"),
} as const;

export const bearer = [{ bearerAuth: [] }];

/**
 * Zod schema for a DB row as PostgREST returns it: snake_case keys, numeric
 * columns as numbers (Drizzle infers `numeric` as string), ISO timestamps.
 */
export function rowSchema<T extends Table>(
  table: T,
  name: string,
  /** Per-column replacements (e.g. a typed schema for a jsonb column). */
  overrides: Record<string, z.ZodTypeAny> = {}
) {
  const select = createSelectSchema(table) as unknown as z.ZodObject<any>;
  const columns = getTableColumns(table) as Record<string, any>;
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, schema] of Object.entries(select.shape)) {
    const col = columns[key];
    let s = schema as z.ZodTypeAny;
    if (col.columnType === "PgNumeric") {
      s = col.notNull ? z.number() : z.number().nullable();
    }
    shape[col.name] = s;
  }
  Object.assign(shape, overrides);
  return z.object(shape).openapi(name);
}

/** Register the security scheme + serve the spec on the root app. */
export function mountDocs(app: OpenAPIHono<any>, version: string) {
  app.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
    type: "http",
    scheme: "bearer",
    bearerFormat: "JWT",
  });
  app.doc("/openapi.json", openapiConfig(version));
}

export function openapiConfig(version: string) {
  return {
    openapi: "3.0.3",
    info: { title: "Blink API", version },
  };
}
