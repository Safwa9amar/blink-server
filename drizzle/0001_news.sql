CREATE TYPE "public"."news_status" AS ENUM('published', 'scheduled', 'draft');--> statement-breakpoint
CREATE TABLE "news" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"category" text NOT NULL,
	"cover_url" text,
	"target_roles" text[] DEFAULT '{"All"}' NOT NULL,
	"status" "news_status" DEFAULT 'draft' NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"push" boolean DEFAULT false NOT NULL,
	"cta_label" text,
	"content" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"views" integer DEFAULT 0 NOT NULL,
	"clicks" integer DEFAULT 0 NOT NULL,
	"author_id" uuid,
	"published_at" timestamp with time zone,
	"scheduled_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "news_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "news" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "news" ADD CONSTRAINT "news_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_news_status" ON "news" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_news_pinned" ON "news" USING btree ("pinned") WHERE pinned;--> statement-breakpoint
CREATE INDEX "idx_news_scheduled" ON "news" USING btree ("scheduled_at") WHERE status = 'scheduled';--> statement-breakpoint
CREATE POLICY "news_select_published" ON "news" AS PERMISSIVE FOR SELECT TO public USING (status = 'published');--> statement-breakpoint
-- updated_at auto-bump. Drizzle can't model triggers, so it's hand-added here.
-- Reuses update_updated_at() from the baseline; CREATE OR REPLACE + IF EXISTS
-- keep this safe on the existing cloud DB and on a fresh local one alike.
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_news_updated_at ON "news";--> statement-breakpoint
CREATE TRIGGER trg_news_updated_at
  BEFORE UPDATE ON "news" FOR EACH ROW EXECUTE FUNCTION update_updated_at();