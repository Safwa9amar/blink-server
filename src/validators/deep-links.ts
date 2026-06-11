import { z } from "zod";

const role = z.enum(["customer", "rider", "merchant", "agent", "auth", "shared"]);
const slug = z
  .string()
  .min(1)
  .max(60)
  .regex(/^[a-z0-9-]+$/, "slug must be lowercase letters, numbers and hyphens");

// Create — `slug` is optional (derived from the title when omitted); fields with
// DB defaults are optional here too.
export const createDeepLinkSchema = z.object({
  title: z.string().min(1).max(120),
  slug: slug.optional(),
  description: z.string().max(500).optional(),
  role: role.default("shared"),
  routePath: z.string().min(1), // Expo route, e.g. "/(customer)/deal/[id]"
  deepLink: z.string().min(1), // resolved scheme URL, e.g. "blink://customer/deal/42"
  webUrl: z.string().url().optional(),
  requiredParams: z.array(z.string()).default([]),
  params: z.record(z.string(), z.string()).default({}),
  campaign: z.string().max(80).optional(),
  isActive: z.boolean().default(true),
  expiresAt: z.string().optional(), // ISO 8601; Postgres validates the format
});

// Update — every field optional, no defaults (an omitted field is left
// untouched). Nullable fields accept `null` to clear them.
export const updateDeepLinkSchema = z.object({
  title: z.string().min(1).max(120).optional(),
  slug: slug.optional(),
  description: z.string().max(500).nullable().optional(),
  role: role.optional(),
  routePath: z.string().min(1).optional(),
  deepLink: z.string().min(1).optional(),
  webUrl: z.string().url().nullable().optional(),
  requiredParams: z.array(z.string()).optional(),
  params: z.record(z.string(), z.string()).optional(),
  campaign: z.string().max(80).nullable().optional(),
  isActive: z.boolean().optional(),
  expiresAt: z.string().nullable().optional(),
});

export const listDeepLinksSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  role: role.optional(),
  campaign: z.string().optional(),
  active: z.enum(["true", "false"]).optional(), // query strings
  q: z.string().optional(), // search slug / title
});
