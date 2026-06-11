CREATE TYPE "public"."address_type" AS ENUM('home', 'work', 'other');--> statement-breakpoint
CREATE TYPE "public"."agent_shop_status" AS ENUM('open', 'closed');--> statement-breakpoint
CREATE TYPE "public"."deposit_method" AS ENUM('electronic', 'agent');--> statement-breakpoint
CREATE TYPE "public"."dispute_status" AS ENUM('under_review', 'pending', 'decision_issued');--> statement-breakpoint
CREATE TYPE "public"."document_status" AS ENUM('approved', 'needs_update', 'pending', 'not_uploaded');--> statement-breakpoint
CREATE TYPE "public"."gender" AS ENUM('male', 'female');--> statement-breakpoint
CREATE TYPE "public"."notification_type" AS ENUM('courier', 'promo', 'offer', 'order', 'security', 'news', 'alert', 'announcement', 'benefit', 'deposit');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('searching', 'heading_to_store', 'preparation', 'pickup', 'on_the_way', 'delivered', 'canceled', 'merchant_rejected', 'processing');--> statement-breakpoint
CREATE TYPE "public"."order_type" AS ENUM('merchant', 'shopper');--> statement-breakpoint
CREATE TYPE "public"."transaction_status" AS ENUM('completed', 'cancelled', 'pending');--> statement-breakpoint
CREATE TYPE "public"."transaction_type" AS ENUM('deposit', 'withdrawal');--> statement-breakpoint
CREATE TYPE "public"."trip_status" AS ENUM('upcoming', 'completed', 'under_review', 'canceled');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('customer', 'rider', 'merchant', 'agent');--> statement-breakpoint
CREATE TYPE "public"."vehicle_category" AS ENUM('standard', 'electric', 'hybrid');--> statement-breakpoint
CREATE TYPE "public"."vehicle_type" AS ENUM('bicycle', 'motorcycle');--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT auth.uid() NOT NULL,
	"phone_number" text NOT NULL,
	"first_name" text,
	"last_name" text,
	"middle_name" text,
	"email" text,
	"role" "user_role" DEFAULT 'customer' NOT NULL,
	"gender" "gender",
	"birthday" date,
	"profile_picture" text,
	"address" text,
	"pin_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_phone_number_unique" UNIQUE("phone_number")
);
--> statement-breakpoint
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "rider_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"rider_id" text NOT NULL,
	"wilaya" text,
	"wilaya_code" text,
	"bank_rib" text,
	"vehicle_type" "vehicle_type",
	"license_front_url" text,
	"license_back_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rider_profiles_rider_id_unique" UNIQUE("rider_id"),
	CONSTRAINT "rider_profiles_user_id_key" UNIQUE("user_id")
);
--> statement-breakpoint
ALTER TABLE "rider_profiles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "vehicles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"brand" text NOT NULL,
	"model" text NOT NULL,
	"license_plate" text NOT NULL,
	"year" text NOT NULL,
	"color" text NOT NULL,
	"category" "vehicle_category" DEFAULT 'standard' NOT NULL,
	"gray_card_url" text,
	"gray_card_status" "document_status" DEFAULT 'not_uploaded' NOT NULL,
	"insurance_url" text,
	"insurance_status" "document_status" DEFAULT 'not_uploaded' NOT NULL,
	"driving_license_url" text,
	"driving_license_status" "document_status" DEFAULT 'not_uploaded' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vehicles_user_id_key" UNIQUE("user_id")
);
--> statement-breakpoint
ALTER TABLE "vehicles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "trips" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"display_id" text NOT NULL,
	"rider_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"status" "trip_status" DEFAULT 'upcoming' NOT NULL,
	"pickup_label" text NOT NULL,
	"pickup_address" text NOT NULL,
	"pickup_lat" double precision NOT NULL,
	"pickup_lng" double precision NOT NULL,
	"dropoff_label" text NOT NULL,
	"dropoff_address" text NOT NULL,
	"dropoff_lat" double precision NOT NULL,
	"dropoff_lng" double precision NOT NULL,
	"estimated_payout" numeric(10, 2) NOT NULL,
	"net_payout" numeric(10, 2) NOT NULL,
	"distance_km" numeric(6, 2) NOT NULL,
	"duration_minutes" integer NOT NULL,
	"cancellation_reason" text,
	"notes" text,
	"penalty_amount" numeric(10, 2),
	"dispute_status" "dispute_status",
	"fraud_notice" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trips_display_id_unique" UNIQUE("display_id")
);
--> statement-breakpoint
ALTER TABLE "trips" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" "transaction_type" NOT NULL,
	"user_id" uuid NOT NULL,
	"agent_id" uuid,
	"rider_id" uuid,
	"amount" numeric(10, 2) NOT NULL,
	"fees" numeric(10, 2) DEFAULT 0 NOT NULL,
	"total" numeric(10, 2) NOT NULL,
	"status" "transaction_status" DEFAULT 'pending' NOT NULL,
	"method" "deposit_method",
	"pending_id" uuid,
	"offer_title" text,
	"offer_detail" text,
	"rating" smallint,
	"feedback" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transactions_pending_id_unique" UNIQUE("pending_id"),
	CONSTRAINT "transactions_rating_check" CHECK (rating >= 1 AND rating <= 5)
);
--> statement-breakpoint
ALTER TABLE "transactions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "agent_shops" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"shop_name" text NOT NULL,
	"phone_number" text,
	"shop_image_url" text,
	"open_time" time DEFAULT '08:00' NOT NULL,
	"close_time" time DEFAULT '20:00' NOT NULL,
	"status" "agent_shop_status" DEFAULT 'closed' NOT NULL,
	"latitude" double precision DEFAULT 0 NOT NULL,
	"longitude" double precision DEFAULT 0 NOT NULL,
	"address" text,
	"rating" numeric(2, 1) DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_shops_user_id_key" UNIQUE("user_id")
);
--> statement-breakpoint
ALTER TABLE "agent_shops" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"rider_id" uuid,
	"store_name" text NOT NULL,
	"store_logo" text,
	"type" "order_type" NOT NULL,
	"status" "order_status" DEFAULT 'processing' NOT NULL,
	"estimated_time" text,
	"subtotal" numeric(10, 2) DEFAULT 0 NOT NULL,
	"delivery_fee" numeric(10, 2) DEFAULT 0 NOT NULL,
	"service_fee" numeric(10, 2) DEFAULT 0 NOT NULL,
	"discount" numeric(10, 2) DEFAULT 0 NOT NULL,
	"total" numeric(10, 2) DEFAULT 0 NOT NULL,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"pickup_address" text,
	"destination_address" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "orders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" "notification_type" NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"is_unread" boolean DEFAULT true NOT NULL,
	"payload" jsonb,
	"href" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "addresses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"label" text NOT NULL,
	"address" text NOT NULL,
	"type" "address_type" DEFAULT 'other' NOT NULL,
	"latitude" double precision NOT NULL,
	"longitude" double precision NOT NULL,
	"street" text,
	"street_number" text,
	"floor_apt" text,
	"directions" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "addresses" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "rider_profiles" ADD CONSTRAINT "rider_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_rider_id_users_id_fk" FOREIGN KEY ("rider_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_customer_id_users_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_agent_id_users_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_rider_id_users_id_fk" FOREIGN KEY ("rider_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_shops" ADD CONSTRAINT "agent_shops_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_users_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_rider_id_users_id_fk" FOREIGN KEY ("rider_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "addresses" ADD CONSTRAINT "addresses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_users_phone" ON "users" USING btree ("phone_number");--> statement-breakpoint
CREATE INDEX "idx_users_role" ON "users" USING btree ("role");--> statement-breakpoint
CREATE INDEX "idx_rider_profiles_user" ON "rider_profiles" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_vehicles_user" ON "vehicles" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_trips_rider" ON "trips" USING btree ("rider_id");--> statement-breakpoint
CREATE INDEX "idx_trips_customer" ON "trips" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "idx_trips_status" ON "trips" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_transactions_user" ON "transactions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_transactions_agent" ON "transactions" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "idx_transactions_rider" ON "transactions" USING btree ("rider_id");--> statement-breakpoint
CREATE INDEX "idx_transactions_status" ON "transactions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_transactions_pending" ON "transactions" USING btree ("pending_id") WHERE pending_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_agent_shops_user" ON "agent_shops" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_agent_shops_status" ON "agent_shops" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_agent_shops_location" ON "agent_shops" USING btree ("latitude","longitude");--> statement-breakpoint
CREATE INDEX "idx_orders_customer" ON "orders" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "idx_orders_rider" ON "orders" USING btree ("rider_id");--> statement-breakpoint
CREATE INDEX "idx_orders_status" ON "orders" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_notifications_user" ON "notifications" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_notifications_unread" ON "notifications" USING btree ("user_id","is_unread") WHERE is_unread = true;--> statement-breakpoint
CREATE INDEX "idx_addresses_user" ON "addresses" USING btree ("user_id");--> statement-breakpoint
CREATE POLICY "users_select_own" ON "users" AS PERMISSIVE FOR SELECT TO public USING (auth.uid() = id);--> statement-breakpoint
CREATE POLICY "users_update_own" ON "users" AS PERMISSIVE FOR UPDATE TO public USING (auth.uid() = id);--> statement-breakpoint
CREATE POLICY "rider_profiles_select_own" ON "rider_profiles" AS PERMISSIVE FOR SELECT TO public USING (auth.uid() = user_id);--> statement-breakpoint
CREATE POLICY "rider_profiles_update_own" ON "rider_profiles" AS PERMISSIVE FOR UPDATE TO public USING (auth.uid() = user_id);--> statement-breakpoint
CREATE POLICY "vehicles_select_own" ON "vehicles" AS PERMISSIVE FOR SELECT TO public USING (auth.uid() = user_id);--> statement-breakpoint
CREATE POLICY "vehicles_all_own" ON "vehicles" AS PERMISSIVE FOR ALL TO public USING (auth.uid() = user_id);--> statement-breakpoint
CREATE POLICY "trips_select_own" ON "trips" AS PERMISSIVE FOR SELECT TO public USING (auth.uid() = rider_id OR auth.uid() = customer_id);--> statement-breakpoint
CREATE POLICY "transactions_select_own" ON "transactions" AS PERMISSIVE FOR SELECT TO public USING (auth.uid() = user_id OR auth.uid() = agent_id);--> statement-breakpoint
CREATE POLICY "agent_shops_select_all" ON "agent_shops" AS PERMISSIVE FOR SELECT TO public USING (true);--> statement-breakpoint
CREATE POLICY "agent_shops_update_own" ON "agent_shops" AS PERMISSIVE FOR UPDATE TO public USING (auth.uid() = user_id);--> statement-breakpoint
CREATE POLICY "orders_select_own" ON "orders" AS PERMISSIVE FOR SELECT TO public USING (auth.uid() = customer_id OR auth.uid() = rider_id);--> statement-breakpoint
CREATE POLICY "notifications_select_own" ON "notifications" AS PERMISSIVE FOR SELECT TO public USING (auth.uid() = user_id);--> statement-breakpoint
CREATE POLICY "notifications_update_own" ON "notifications" AS PERMISSIVE FOR UPDATE TO public USING (auth.uid() = user_id);--> statement-breakpoint
CREATE POLICY "addresses_all_own" ON "addresses" AS PERMISSIVE FOR ALL TO public USING (auth.uid() = user_id);