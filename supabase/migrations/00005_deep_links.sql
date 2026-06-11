-- =====================================================================
-- Blink Server — Deep Links management table
-- =====================================================================
-- Authored in Drizzle (src/db/schema/deep-links.ts) and kept here as a Supabase
-- migration so the existing `npm run db:push` / `db:reset` pipeline applies it.
-- Additive only — no changes to the baseline tables in 00001.
--
-- Managed / generated deep links: a short `slug` → Expo route + resolved
-- blink:// URL, with filled params, optional campaign tag, active flag, expiry
-- and click tracking. Resolving an active link is public (works before login);
-- writes go through the service role, same as news.

CREATE TYPE "public"."deep_link_role" AS ENUM('customer', 'rider', 'merchant', 'agent', 'auth', 'shared');

CREATE TABLE "deep_links" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "slug"            text NOT NULL,
  "title"           text NOT NULL,
  "description"     text,
  "role"            "deep_link_role" DEFAULT 'shared' NOT NULL,
  "route_path"      text NOT NULL,
  "deep_link"       text NOT NULL,
  "web_url"         text,
  "required_params" text[] DEFAULT '{}'::text[] NOT NULL,
  "params"          jsonb DEFAULT '{}'::jsonb NOT NULL,
  "campaign"        text,
  "is_active"       boolean DEFAULT true NOT NULL,
  "clicks"          integer DEFAULT 0 NOT NULL,
  "expires_at"      timestamp with time zone,
  "created_by"      uuid,
  "created_at"      timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at"      timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "deep_links_slug_unique" UNIQUE("slug")
);

ALTER TABLE "deep_links" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "deep_links" ADD CONSTRAINT "deep_links_created_by_users_id_fk"
  FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;

CREATE INDEX "idx_deep_links_role" ON "deep_links" USING btree ("role");
CREATE INDEX "idx_deep_links_active" ON "deep_links" USING btree ("is_active") WHERE is_active;
CREATE INDEX "idx_deep_links_campaign" ON "deep_links" USING btree ("campaign");

-- Anyone can resolve an ACTIVE link (works before login); writes go through the service role.
CREATE POLICY "deep_links_select_active" ON "deep_links" AS PERMISSIVE FOR SELECT TO public USING (is_active);

-- updated_at auto-bump (reuses update_updated_at() from 00001).
CREATE TRIGGER trg_deep_links_updated_at
  BEFORE UPDATE ON "deep_links" FOR EACH ROW EXECUTE FUNCTION update_updated_at();
