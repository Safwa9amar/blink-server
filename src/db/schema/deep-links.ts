import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { timestamps } from "./_shared";
import { users } from "./users";

// Audience for a managed deep link — the four app roles plus "auth" (pre-login
// flows like verify/reset) and "shared" (role-agnostic). Lives here (not in
// enums.ts) so it ships in the additive deep_links migration, not the baseline
// snapshot of the already-deployed tables.
export const deepLinkRole = pgEnum("deep_link_role", [
  "customer",
  "rider",
  "merchant",
  "agent",
  "auth",
  "shared",
]);

// Managed / generated deep links — shareable, trackable links that map a short
// `slug` to an Expo route (`route_path`) and its resolved `blink://` URL, with
// filled params, an optional campaign tag and click tracking. Authoring happens
// in the dashboard (service role); the mobile app or a web redirector resolves a
// link by slug (public, via the `deep_links_select_active` RLS policy).
//
// NB: this is the DYNAMIC, persisted set of links. The static CATALOG of every
// available route template stays in the app's deeplinks.json — these rows are
// built from it.
export const deepLinks = pgTable(
  "deep_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull().unique(), // short code, e.g. "summer-deal-2026"
    title: text("title").notNull(), // admin label
    description: text("description"),
    role: deepLinkRole("role").notNull().default("shared"),
    routePath: text("route_path").notNull(), // Expo route, e.g. "/(customer)/deal/[id]"
    deepLink: text("deep_link").notNull(), // resolved scheme URL, e.g. "blink://customer/deal/42"
    webUrl: text("web_url"), // universal-link / web fallback
    requiredParams: text("required_params").array().notNull().default(sql`'{}'::text[]`),
    params: jsonb("params").$type<Record<string, string>>().notNull().default(sql`'{}'::jsonb`),
    campaign: text("campaign"), // analytics tag (UTM-style)
    isActive: boolean("is_active").notNull().default(true),
    clicks: integer("clicks").notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [
    index("idx_deep_links_role").on(t.role),
    index("idx_deep_links_active")
      .on(t.isActive)
      .where(sql`is_active`),
    index("idx_deep_links_campaign").on(t.campaign),
    // Resolving an active link is public (works before login); writes go through
    // the service role, same as news.
    pgPolicy("deep_links_select_active", { for: "select", using: sql`is_active` }),
  ]
);
