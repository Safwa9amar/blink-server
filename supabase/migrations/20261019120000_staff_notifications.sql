-- =====================================================================
-- Blink Server — Staff notifications (the dashboard bell / inbox)
-- =====================================================================
-- Authored in Drizzle (src/db/schema/staff-notifications.ts).
--
-- Every app-side change that staff should hear about (a sign-up, a partner
-- joining or uploading documents, a store / product / pack sent for review, a
-- customer waiting on support, a deletion request, a fired alert, …) is
-- recorded HERE by triggers on the source tables, so it is captured whichever
-- path wrote it (blink-server, the app's own RLS writes, a cron).
--
--   staff_notifications        one row per event (or per folded group)
--   staff_notification_reads   per-staff read marks
--   staff_notification_state   per-staff "mark all read" watermark
--
-- Rows hold a `kind` + display `params` (names, counts), not copy: the
-- dashboard renders them in en / fr / ar and decides who may see a kind from
-- its access map. `summary` is an English fallback for kinds the dashboard
-- doesn't know yet (only super_admin sees those).
--
-- Folding: events with the same `group_key` within an hour of the group's
-- first event bump `occurrences` + `last_at` on one row instead of adding rows
-- (a merchant importing 200 products is one notification, not 200). A bump
-- makes the row unread again for everyone.
--
-- Safety: the trigger functions only fire on the changes they report (WHEN
-- clauses / UPDATE OF), and staff_notify swallows its own errors, so a
-- notification problem never aborts the app's write.
--
-- Realtime: every insert / bump is announced on the PRIVATE topic
-- `staff:notifications` (event `staff_notification`, payload = the row id
-- only); the dashboard refetches through its server. Only staff may join it.

-- ─── Tables ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "staff_notifications" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "kind"        text NOT NULL,
  "severity"    text DEFAULT 'info' NOT NULL,
  "entity_id"   uuid,
  "params"      jsonb DEFAULT '{}'::jsonb NOT NULL,
  "summary"     text NOT NULL,
  "group_key"   text,
  "occurrences" integer DEFAULT 1 NOT NULL,
  "created_at"  timestamp with time zone DEFAULT now() NOT NULL,
  "last_at"     timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "staff_notifications_severity_check" CHECK ("severity" IN ('info', 'warning', 'critical'))
);

CREATE INDEX IF NOT EXISTS "idx_staff_notifications_last" ON "staff_notifications" USING btree ("last_at" DESC, "id" DESC);
CREATE INDEX IF NOT EXISTS "idx_staff_notifications_kind" ON "staff_notifications" USING btree ("kind", "last_at" DESC);
CREATE INDEX IF NOT EXISTS "idx_staff_notifications_group" ON "staff_notifications" USING btree ("group_key", "created_at" DESC)
  WHERE "group_key" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "staff_notification_reads" (
  "notification_id" uuid NOT NULL REFERENCES "public"."staff_notifications"("id") ON DELETE cascade,
  "user_id"         uuid NOT NULL REFERENCES "public"."users"("id") ON DELETE cascade,
  "read_at"         timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("user_id", "notification_id")
);

CREATE TABLE IF NOT EXISTS "staff_notification_state" (
  "user_id"     uuid PRIMARY KEY NOT NULL REFERENCES "public"."users"("id") ON DELETE cascade,
  "read_all_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- RLS: the dashboard reads and writes with the service role (bypasses RLS).
-- These policies are a deny-by-default backstop: staff may read the feed and
-- their own read state; nobody writes directly.
ALTER TABLE "staff_notifications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "staff_notification_reads" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "staff_notification_state" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "staff_notifications_staff_select" ON "staff_notifications";
CREATE POLICY "staff_notifications_staff_select" ON "staff_notifications" AS PERMISSIVE FOR SELECT TO public
  USING (EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid() AND u.staff_role IS NOT NULL));

DROP POLICY IF EXISTS "staff_notification_reads_select_own" ON "staff_notification_reads";
CREATE POLICY "staff_notification_reads_select_own" ON "staff_notification_reads" AS PERMISSIVE FOR SELECT TO public
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "staff_notification_state_select_own" ON "staff_notification_state";
CREATE POLICY "staff_notification_state_select_own" ON "staff_notification_state" AS PERMISSIVE FOR SELECT TO public
  USING (auth.uid() = user_id);

-- ─── Helpers ─────────────────────────────────────────────────────────
-- "First Last", else the phone, else the email, else ''.
CREATE OR REPLACE FUNCTION public.staff_display_name(p_first text, p_last text, p_phone text, p_email text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT coalesce(nullif(btrim(concat_ws(' ', p_first, p_last)), ''), nullif(p_phone, ''), nullif(p_email, ''), '')
$$;

CREATE OR REPLACE FUNCTION public.staff_user_name(p_user uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(
    (SELECT staff_display_name(u.first_name, u.last_name, u.phone_number, u.email) FROM users u WHERE u.id = p_user),
    ''
  )
$$;

CREATE OR REPLACE FUNCTION public.staff_store_name(p_store uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce((SELECT s.name FROM stores s WHERE s.id = p_store), '')
$$;

-- True when a documents JSON (rider / agent: { <key>: { path|url, status, uploaded_at, … } })
-- gained a document waiting for staff: a key now `pending` that is new, was
-- not pending before, or was replaced (path / url / uploaded_at changed).
CREATE OR REPLACE FUNCTION public.staff_docs_uploaded(p_old jsonb, p_new jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE WHEN jsonb_typeof(p_new) IS DISTINCT FROM 'object' THEN false ELSE EXISTS (
    SELECT 1
    FROM jsonb_each(p_new) AS d(k, v)
    CROSS JOIN LATERAL (
      SELECT CASE WHEN jsonb_typeof(p_old) = 'object' THEN p_old -> d.k END AS prev
    ) o
    WHERE jsonb_typeof(d.v) = 'object'
      AND d.v ->> 'status' = 'pending'
      AND (
        o.prev IS NULL
        OR (o.prev ->> 'status') IS DISTINCT FROM 'pending'
        OR (o.prev ->> 'path') IS DISTINCT FROM (d.v ->> 'path')
        OR (o.prev ->> 'url') IS DISTINCT FROM (d.v ->> 'url')
        OR (o.prev ->> 'uploaded_at') IS DISTINCT FROM (d.v ->> 'uploaded_at')
      )
  ) END
$$;

-- Record one event. With a group_key, an event within an hour of that group's
-- first event folds into it (occurrences + 1, last_at = now, params merged).
-- Never raises: a failure is logged as a warning and the caller's write goes on.
CREATE OR REPLACE FUNCTION public.staff_notify(
  p_kind text,
  p_entity_id uuid,
  p_params jsonb,
  p_summary text,
  p_group_key text DEFAULT NULL,
  p_severity text DEFAULT 'info'
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_severity text := CASE WHEN p_severity IN ('info', 'warning', 'critical') THEN p_severity ELSE 'info' END;
BEGIN
  IF p_group_key IS NOT NULL THEN
    -- Serialize concurrent events of one group so they fold into one row.
    PERFORM pg_advisory_xact_lock(hashtextextended('staff_notify:' || p_group_key, 0));
    SELECT n.id INTO v_id
    FROM staff_notifications n
    WHERE n.group_key = p_group_key AND n.created_at > now() - interval '1 hour'
    ORDER BY n.created_at DESC
    LIMIT 1;

    IF v_id IS NOT NULL THEN
      UPDATE staff_notifications n
      SET occurrences = n.occurrences + 1,
          last_at = now(),
          entity_id = coalesce(p_entity_id, n.entity_id),
          params = n.params || coalesce(p_params, '{}'::jsonb),
          summary = coalesce(p_summary, n.summary),
          severity = CASE
            WHEN 'critical' IN (n.severity, v_severity) THEN 'critical'
            WHEN 'warning' IN (n.severity, v_severity) THEN 'warning'
            ELSE 'info'
          END
      WHERE n.id = v_id;
      RETURN;
    END IF;
  END IF;

  INSERT INTO staff_notifications (kind, severity, entity_id, params, summary, group_key)
  VALUES (p_kind, v_severity, p_entity_id, coalesce(p_params, '{}'::jsonb), coalesce(p_summary, p_kind), p_group_key);

  -- Retention: now and then, drop what the feed no longer shows (90 days).
  IF random() < 0.01 THEN
    DELETE FROM staff_notifications WHERE last_at < now() - interval '90 days';
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'staff_notify(%) failed: %', p_kind, SQLERRM;
END;
$$;

-- ─── Event triggers ──────────────────────────────────────────────────
-- users: a new app account (staff accounts are not announced).
CREATE OR REPLACE FUNCTION public.staff_events_users()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name text := staff_display_name(NEW.first_name, NEW.last_name, NEW.phone_number, NEW.email);
BEGIN
  PERFORM staff_notify('user.signup', NEW.id, jsonb_build_object('name', v_name),
    'New sign-up: ' || coalesce(nullif(v_name, ''), 'unnamed account'), 'user.signup');
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_users_staff_events ON public.users;
CREATE TRIGGER trg_users_staff_events
  AFTER INSERT ON public.users
  FOR EACH ROW WHEN (NEW.staff_role IS NULL)
  EXECUTE FUNCTION public.staff_events_users();

-- rider_profiles: a new rider, and documents uploaded for review.
CREATE OR REPLACE FUNCTION public.staff_events_rider_profiles()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name text := staff_user_name(NEW.user_id);
  v_params jsonb := jsonb_build_object('name', v_name, 'rider_id', coalesce(NEW.rider_id, ''));
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM staff_notify('rider.joined', NEW.user_id, v_params,
      'New rider: ' || coalesce(nullif(v_name, ''), NEW.rider_id), 'rider.joined');
  END IF;
  IF staff_docs_uploaded(CASE WHEN TG_OP = 'UPDATE' THEN OLD.documents END, NEW.documents) THEN
    PERFORM staff_notify('rider.documents', NEW.user_id, v_params,
      'Rider documents to review: ' || coalesce(nullif(v_name, ''), NEW.rider_id),
      'rider.documents:' || NEW.user_id, 'warning');
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_rider_profiles_staff_events_ins ON public.rider_profiles;
CREATE TRIGGER trg_rider_profiles_staff_events_ins
  AFTER INSERT ON public.rider_profiles
  FOR EACH ROW EXECUTE FUNCTION public.staff_events_rider_profiles();

DROP TRIGGER IF EXISTS trg_rider_profiles_staff_events_upd ON public.rider_profiles;
CREATE TRIGGER trg_rider_profiles_staff_events_upd
  AFTER UPDATE OF documents ON public.rider_profiles
  FOR EACH ROW WHEN (OLD.documents IS DISTINCT FROM NEW.documents)
  EXECUTE FUNCTION public.staff_events_rider_profiles();

-- merchant_profiles: a new merchant.
CREATE OR REPLACE FUNCTION public.staff_events_merchant_profiles()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name text := staff_user_name(NEW.user_id);
BEGIN
  PERFORM staff_notify('merchant.joined', NEW.user_id,
    jsonb_build_object('name', v_name, 'merchant_id', coalesce(NEW.merchant_id, '')),
    'New merchant: ' || coalesce(nullif(v_name, ''), NEW.merchant_id), 'merchant.joined');
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_merchant_profiles_staff_events ON public.merchant_profiles;
CREATE TRIGGER trg_merchant_profiles_staff_events
  AFTER INSERT ON public.merchant_profiles
  FOR EACH ROW EXECUTE FUNCTION public.staff_events_merchant_profiles();

-- agent_profiles: a new agent, and register scans uploaded for review.
CREATE OR REPLACE FUNCTION public.staff_events_agent_profiles()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name text := staff_user_name(NEW.user_id);
  v_params jsonb := jsonb_build_object('name', v_name, 'agent_id', coalesce(NEW.agent_id, ''));
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM staff_notify('agent.joined', NEW.user_id, v_params,
      'New agent: ' || coalesce(nullif(v_name, ''), NEW.agent_id), 'agent.joined');
  END IF;
  IF staff_docs_uploaded(CASE WHEN TG_OP = 'UPDATE' THEN OLD.documents END, NEW.documents) THEN
    PERFORM staff_notify('agent.documents', NEW.user_id, v_params,
      'Agent documents to review: ' || coalesce(nullif(v_name, ''), NEW.agent_id),
      'agent.documents:' || NEW.user_id, 'warning');
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_agent_profiles_staff_events_ins ON public.agent_profiles;
CREATE TRIGGER trg_agent_profiles_staff_events_ins
  AFTER INSERT ON public.agent_profiles
  FOR EACH ROW EXECUTE FUNCTION public.staff_events_agent_profiles();

DROP TRIGGER IF EXISTS trg_agent_profiles_staff_events_upd ON public.agent_profiles;
CREATE TRIGGER trg_agent_profiles_staff_events_upd
  AFTER UPDATE OF documents ON public.agent_profiles
  FOR EACH ROW WHEN (OLD.documents IS DISTINCT FROM NEW.documents)
  EXECUTE FUNCTION public.staff_events_agent_profiles();

-- agent_shops: a shop sent for review (new, or re-submitted).
CREATE OR REPLACE FUNCTION public.staff_events_agent_shops()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM staff_notify('agent.shop_review', NEW.id,
    jsonb_build_object('shop', NEW.shop_name, 'name', staff_user_name(NEW.user_id)),
    'Agent shop to review: ' || NEW.shop_name, 'agent.shop_review:' || NEW.id, 'warning');
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_agent_shops_staff_events_ins ON public.agent_shops;
CREATE TRIGGER trg_agent_shops_staff_events_ins
  AFTER INSERT ON public.agent_shops
  FOR EACH ROW WHEN (NEW.review_status = 'under_review')
  EXECUTE FUNCTION public.staff_events_agent_shops();

DROP TRIGGER IF EXISTS trg_agent_shops_staff_events_upd ON public.agent_shops;
CREATE TRIGGER trg_agent_shops_staff_events_upd
  AFTER UPDATE OF review_status ON public.agent_shops
  FOR EACH ROW WHEN (NEW.review_status = 'under_review' AND OLD.review_status IS DISTINCT FROM NEW.review_status)
  EXECUTE FUNCTION public.staff_events_agent_shops();

-- stores: a store sent for review (new, or re-submitted).
CREATE OR REPLACE FUNCTION public.staff_events_stores()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM staff_notify('merchant.review', NEW.id,
    jsonb_build_object('store', NEW.name, 'name', staff_user_name(NEW.owner_id)),
    'Store to review: ' || NEW.name, 'merchant.review:' || NEW.id, 'warning');
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_stores_staff_events_ins ON public.stores;
CREATE TRIGGER trg_stores_staff_events_ins
  AFTER INSERT ON public.stores
  FOR EACH ROW WHEN (NEW.status = 'under_review')
  EXECUTE FUNCTION public.staff_events_stores();

DROP TRIGGER IF EXISTS trg_stores_staff_events_upd ON public.stores;
CREATE TRIGGER trg_stores_staff_events_upd
  AFTER UPDATE OF status ON public.stores
  FOR EACH ROW WHEN (NEW.status = 'under_review' AND OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.staff_events_stores();

-- store_products: a product sent for review, and a merchant price suggestion.
-- Folded per store.
CREATE OR REPLACE FUNCTION public.staff_events_store_products()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_store text := staff_store_name(NEW.store_id);
BEGIN
  IF NEW.review_status = 'pending'
     AND (TG_OP = 'INSERT' OR OLD.review_status IS DISTINCT FROM NEW.review_status) THEN
    PERFORM staff_notify('product.review', NEW.store_id,
      jsonb_build_object('store', v_store, 'product', NEW.title),
      'Product to review: ' || NEW.title || ' (' || v_store || ')', 'product.review:' || NEW.store_id, 'warning');
  END IF;
  IF NEW.suggestion_status = 'pending'
     AND (TG_OP = 'INSERT' OR OLD.suggestion_status IS DISTINCT FROM NEW.suggestion_status
          OR OLD.suggested_price IS DISTINCT FROM NEW.suggested_price) THEN
    PERFORM staff_notify('price.suggestion', NEW.store_id,
      jsonb_build_object('store', v_store, 'product', NEW.title, 'price', coalesce(NEW.suggested_price, 0)),
      'Price suggestion: ' || NEW.title || ' (' || v_store || ')', 'price.suggestion:' || NEW.store_id, 'warning');
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_store_products_staff_events_ins ON public.store_products;
CREATE TRIGGER trg_store_products_staff_events_ins
  AFTER INSERT ON public.store_products
  FOR EACH ROW WHEN (NEW.review_status = 'pending' OR NEW.suggestion_status = 'pending')
  EXECUTE FUNCTION public.staff_events_store_products();

DROP TRIGGER IF EXISTS trg_store_products_staff_events_upd ON public.store_products;
CREATE TRIGGER trg_store_products_staff_events_upd
  AFTER UPDATE OF review_status, suggestion_status, suggested_price ON public.store_products
  FOR EACH ROW WHEN (
    (NEW.review_status = 'pending' AND OLD.review_status IS DISTINCT FROM NEW.review_status)
    OR (NEW.suggestion_status = 'pending' AND (OLD.suggestion_status IS DISTINCT FROM NEW.suggestion_status
        OR OLD.suggested_price IS DISTINCT FROM NEW.suggested_price))
  )
  EXECUTE FUNCTION public.staff_events_store_products();

-- store_packs: a pack sent for review. Folded per store.
CREATE OR REPLACE FUNCTION public.staff_events_store_packs()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_store text := staff_store_name(NEW.store_id);
BEGIN
  PERFORM staff_notify('pack.review', NEW.store_id,
    jsonb_build_object('store', v_store, 'pack', NEW.name),
    'Pack to review: ' || NEW.name || ' (' || v_store || ')', 'pack.review:' || NEW.store_id, 'warning');
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_store_packs_staff_events_ins ON public.store_packs;
CREATE TRIGGER trg_store_packs_staff_events_ins
  AFTER INSERT ON public.store_packs
  FOR EACH ROW WHEN (NEW.status = 'under_review')
  EXECUTE FUNCTION public.staff_events_store_packs();

DROP TRIGGER IF EXISTS trg_store_packs_staff_events_upd ON public.store_packs;
CREATE TRIGGER trg_store_packs_staff_events_upd
  AFTER UPDATE OF status ON public.store_packs
  FOR EACH ROW WHEN (NEW.status = 'under_review' AND OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.staff_events_store_packs();

-- orders: canceled (folded hourly), rejected by the merchant (folded per
-- store), and a low store rating (1-2 stars).
CREATE OR REPLACE FUNCTION public.staff_events_orders()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status = 'canceled' THEN
    PERFORM staff_notify('order.canceled', NEW.id,
      jsonb_build_object('store', NEW.store_name, 'type', NEW.type),
      'Order canceled: ' || NEW.store_name, 'order.canceled');
  ELSIF NEW.status IS DISTINCT FROM OLD.status AND NEW.status = 'merchant_rejected' THEN
    PERFORM staff_notify('order.rejected', NEW.id,
      jsonb_build_object('store', NEW.store_name, 'reason', coalesce(NEW.merchant_reject_reason, '')),
      'Order rejected by ' || NEW.store_name, 'order.rejected:' || coalesce(NEW.store_id::text, NEW.store_name), 'warning');
  END IF;
  IF OLD.store_rating IS NULL AND NEW.store_rating IS NOT NULL AND NEW.store_rating <= 2 THEN
    PERFORM staff_notify('order.low_rating', NEW.id,
      jsonb_build_object('store', NEW.store_name, 'rating', NEW.store_rating, 'review', coalesce(NEW.store_review, '')),
      NEW.store_rating || '★ rating for ' || NEW.store_name, NULL, 'warning');
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_orders_staff_events ON public.orders;
CREATE TRIGGER trg_orders_staff_events
  AFTER UPDATE OF status, store_rating ON public.orders
  FOR EACH ROW WHEN (
    (NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('canceled', 'merchant_rejected'))
    OR (OLD.store_rating IS NULL AND NEW.store_rating IS NOT NULL AND NEW.store_rating <= 2)
  )
  EXECUTE FUNCTION public.staff_events_orders();

-- trips: put under review, or a dispute opened.
CREATE OR REPLACE FUNCTION public.staff_events_trips()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM staff_notify('trip.review', NEW.id,
    jsonb_build_object('trip', NEW.display_id, 'name', staff_user_name(NEW.rider_id)),
    'Trip to review: ' || NEW.display_id, 'trip.review:' || NEW.id, 'warning');
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_trips_staff_events ON public.trips;
CREATE TRIGGER trg_trips_staff_events
  AFTER UPDATE OF status, dispute_status ON public.trips
  FOR EACH ROW WHEN (
    (NEW.status = 'under_review' AND OLD.status IS DISTINCT FROM NEW.status)
    OR (OLD.dispute_status IS NULL AND NEW.dispute_status IS NOT NULL)
  )
  EXECUTE FUNCTION public.staff_events_trips();

-- support_conversations: a customer asked for a human (status → waiting).
CREATE OR REPLACE FUNCTION public.staff_events_support_conversations()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name text := staff_user_name(NEW.user_id);
BEGIN
  PERFORM staff_notify('support.waiting', NEW.id,
    jsonb_build_object('name', v_name, 'role', NEW.user_role, 'subject', coalesce(NEW.subject, NEW.last_message_preview, '')),
    'Waiting for support: ' || coalesce(nullif(v_name, ''), 'a customer'), 'support.waiting:' || NEW.id, 'warning');
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_support_conversations_staff_events_ins ON public.support_conversations;
CREATE TRIGGER trg_support_conversations_staff_events_ins
  AFTER INSERT ON public.support_conversations
  FOR EACH ROW WHEN (NEW.status = 'waiting')
  EXECUTE FUNCTION public.staff_events_support_conversations();

DROP TRIGGER IF EXISTS trg_support_conversations_staff_events_upd ON public.support_conversations;
CREATE TRIGGER trg_support_conversations_staff_events_upd
  AFTER UPDATE OF status ON public.support_conversations
  FOR EACH ROW WHEN (NEW.status = 'waiting' AND OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.staff_events_support_conversations();

-- email_threads: inbound mail (the staff unread counter went up). Folded per thread.
CREATE OR REPLACE FUNCTION public.staff_events_email_threads()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_from text := coalesce(nullif(NEW.customer_name, ''), NEW.customer_email);
BEGIN
  PERFORM staff_notify('email.inbound', NEW.id,
    jsonb_build_object('name', v_from, 'subject', coalesce(NEW.subject, '')),
    'Email from ' || v_from || ': ' || coalesce(NEW.subject, ''), 'email.inbound:' || NEW.id);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_email_threads_staff_events_ins ON public.email_threads;
CREATE TRIGGER trg_email_threads_staff_events_ins
  AFTER INSERT ON public.email_threads
  FOR EACH ROW WHEN (NEW.unread_for_staff > 0)
  EXECUTE FUNCTION public.staff_events_email_threads();

DROP TRIGGER IF EXISTS trg_email_threads_staff_events_upd ON public.email_threads;
CREATE TRIGGER trg_email_threads_staff_events_upd
  AFTER UPDATE OF unread_for_staff ON public.email_threads
  FOR EACH ROW WHEN (NEW.unread_for_staff > OLD.unread_for_staff)
  EXECUTE FUNCTION public.staff_events_email_threads();

-- account_deletion_requests: a user asked to delete their account (or one role).
CREATE OR REPLACE FUNCTION public.staff_events_account_deletion_requests()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name text := staff_user_name(NEW.user_id);
BEGIN
  PERFORM staff_notify('deletion.requested', NEW.id,
    jsonb_build_object('name', v_name, 'role', NEW.role, 'scope', NEW.scope),
    'Deletion requested: ' || coalesce(nullif(v_name, ''), 'a user') || ' (' || NEW.scope || ', ' || NEW.role || ')',
    NULL, 'warning');
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_account_deletion_requests_staff_events ON public.account_deletion_requests;
CREATE TRIGGER trg_account_deletion_requests_staff_events
  AFTER INSERT ON public.account_deletion_requests
  FOR EACH ROW WHEN (NEW.status = 'pending')
  EXECUTE FUNCTION public.staff_events_account_deletion_requests();

-- alert_events: a monitoring rule fired.
CREATE OR REPLACE FUNCTION public.staff_events_alert_events()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rule text := coalesce((SELECT r.name FROM alert_rules r WHERE r.id = NEW.rule_id), '');
BEGIN
  PERFORM staff_notify('alert.fired', NEW.id,
    jsonb_build_object('rule', v_rule, 'message', coalesce(NEW.message, ''), 'value', NEW.value),
    'Alert: ' || coalesce(nullif(v_rule, ''), NEW.message, 'rule fired'), 'alert.fired:' || NEW.rule_id,
    NEW.severity::text);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_alert_events_staff_events ON public.alert_events;
CREATE TRIGGER trg_alert_events_staff_events
  AFTER INSERT ON public.alert_events
  FOR EACH ROW EXECUTE FUNCTION public.staff_events_alert_events();

-- merchant_dues_payments: a merchant paid their dues.
CREATE OR REPLACE FUNCTION public.staff_events_merchant_dues_payments()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_who text := coalesce(nullif(staff_store_name(NEW.store_id), ''), staff_user_name(NEW.merchant_id));
BEGIN
  PERFORM staff_notify('dues.paid', NEW.id,
    jsonb_build_object('store', v_who, 'amount', NEW.amount, 'method', NEW.method),
    'Dues paid: ' || NEW.amount || ' Da by ' || v_who);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_merchant_dues_payments_staff_events ON public.merchant_dues_payments;
CREATE TRIGGER trg_merchant_dues_payments_staff_events
  AFTER INSERT ON public.merchant_dues_payments
  FOR EACH ROW WHEN (NEW.status = 'completed')
  EXECUTE FUNCTION public.staff_events_merchant_dues_payments();

-- scheduled_notifications: a scheduled campaign was delivered, or failed.
CREATE OR REPLACE FUNCTION public.staff_events_scheduled_notifications()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'sent' THEN
    PERFORM staff_notify('campaign.sent', NEW.id,
      jsonb_build_object('title', NEW.title, 'recipients', NEW.recipients),
      'Campaign sent: ' || NEW.title || ' (' || NEW.recipients || ' recipients)');
  ELSE
    PERFORM staff_notify('campaign.failed', NEW.id,
      jsonb_build_object('title', NEW.title, 'error', coalesce(NEW.error, '')),
      'Campaign failed: ' || NEW.title, NULL, 'critical');
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_scheduled_notifications_staff_events ON public.scheduled_notifications;
CREATE TRIGGER trg_scheduled_notifications_staff_events
  AFTER UPDATE OF status ON public.scheduled_notifications
  FOR EACH ROW WHEN (NEW.status IN ('sent', 'failed') AND OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.staff_events_scheduled_notifications();

-- ─── Realtime ────────────────────────────────────────────────────────
-- Announce each new / bumped row on the private staff topic. Payload is the id
-- only: the dashboard refetches (role-filtered) through its server.
CREATE OR REPLACE FUNCTION public.broadcast_staff_notification()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.last_at IS NOT DISTINCT FROM OLD.last_at THEN
    RETURN NULL;
  END IF;
  PERFORM realtime.send(jsonb_build_object('id', NEW.id), 'staff_notification', 'staff:notifications', true);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_staff_notifications_broadcast ON public.staff_notifications;
CREATE TRIGGER trg_staff_notifications_broadcast
  AFTER INSERT OR UPDATE ON public.staff_notifications
  FOR EACH ROW EXECUTE FUNCTION public.broadcast_staff_notification();

-- Staff (any staff_role) may join the private staff topic. Permissive policies
-- are OR'd, so blink_receive_own_topics (user:<uuid>, riders:offers) is untouched.
DROP POLICY IF EXISTS "blink_staff_receive_notifications" ON realtime.messages;
CREATE POLICY "blink_staff_receive_notifications"
  ON realtime.messages
  FOR SELECT
  TO authenticated
  USING (
    realtime.messages.extension = 'broadcast'
    AND realtime.topic() = 'staff:notifications'
    AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.staff_role IS NOT NULL)
  );

-- ─── Inbox reads (dashboard, service role) ───────────────────────────
-- Unread = changed (last_at) after the staff member's "mark all read"
-- watermark (default: the last 7 days) and not read since it last changed.
CREATE OR REPLACE FUNCTION public.staff_inbox(
  p_user uuid,
  p_kinds text[] DEFAULT NULL,
  p_unread_only boolean DEFAULT false,
  p_limit integer DEFAULT 20,
  p_before_at timestamptz DEFAULT NULL,
  p_before_id uuid DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  kind text,
  severity text,
  entity_id uuid,
  params jsonb,
  summary text,
  occurrences integer,
  created_at timestamptz,
  last_at timestamptz,
  unread boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH st AS (
    SELECT coalesce(
      (SELECT s.read_all_at FROM staff_notification_state s WHERE s.user_id = p_user),
      now() - interval '7 days'
    ) AS since
  ),
  feed AS (
    SELECT n.*,
      (n.last_at > st.since AND NOT EXISTS (
        SELECT 1 FROM staff_notification_reads r
        WHERE r.user_id = p_user AND r.notification_id = n.id AND r.read_at >= n.last_at
      )) AS is_unread
    FROM staff_notifications n CROSS JOIN st
    WHERE n.last_at > now() - interval '90 days'
      AND (p_kinds IS NULL OR n.kind = ANY (p_kinds))
      AND (p_before_at IS NULL OR (n.last_at, n.id) < (p_before_at, coalesce(p_before_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)))
  )
  SELECT f.id, f.kind, f.severity, f.entity_id, f.params, f.summary, f.occurrences, f.created_at, f.last_at, f.is_unread
  FROM feed f
  WHERE NOT coalesce(p_unread_only, false) OR f.is_unread
  ORDER BY f.last_at DESC, f.id DESC
  LIMIT least(greatest(coalesce(p_limit, 20), 1), 100)
$$;

CREATE OR REPLACE FUNCTION public.staff_inbox_unread(p_user uuid, p_kinds text[] DEFAULT NULL)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH st AS (
    SELECT coalesce(
      (SELECT s.read_all_at FROM staff_notification_state s WHERE s.user_id = p_user),
      now() - interval '7 days'
    ) AS since
  )
  SELECT count(*)::integer
  FROM staff_notifications n CROSS JOIN st
  WHERE n.last_at > st.since
    AND (p_kinds IS NULL OR n.kind = ANY (p_kinds))
    AND NOT EXISTS (
      SELECT 1 FROM staff_notification_reads r
      WHERE r.user_id = p_user AND r.notification_id = n.id AND r.read_at >= n.last_at
    )
$$;

CREATE OR REPLACE FUNCTION public.staff_inbox_mark_read(p_user uuid, p_ids uuid[])
RETURNS void
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO staff_notification_reads (notification_id, user_id, read_at)
  SELECT n.id, p_user, now() FROM staff_notifications n WHERE n.id = ANY (p_ids)
  ON CONFLICT (user_id, notification_id) DO UPDATE SET read_at = excluded.read_at
$$;

CREATE OR REPLACE FUNCTION public.staff_inbox_mark_all_read(p_user uuid)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO staff_notification_state (user_id, read_all_at) VALUES (p_user, now())
  ON CONFLICT (user_id) DO UPDATE SET read_all_at = excluded.read_all_at;
  -- Every per-item mark is now older than the watermark.
  DELETE FROM staff_notification_reads WHERE user_id = p_user;
END;
$$;

-- ─── Grants ──────────────────────────────────────────────────────────
-- Supabase grants EXECUTE on new public functions to anon/authenticated by
-- default, which would expose them as RPCs. These take a user id or write
-- notifications, so only the service role (dashboard server, blink-server)
-- may call them. Trigger functions can't be called directly.
REVOKE ALL ON FUNCTION public.staff_user_name(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.staff_store_name(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.staff_notify(text, uuid, jsonb, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.staff_inbox(uuid, text[], boolean, integer, timestamptz, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.staff_inbox_unread(uuid, text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.staff_inbox_mark_read(uuid, uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.staff_inbox_mark_all_read(uuid) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.staff_notify(text, uuid, jsonb, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.staff_inbox(uuid, text[], boolean, integer, timestamptz, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.staff_inbox_unread(uuid, text[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.staff_inbox_mark_read(uuid, uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.staff_inbox_mark_all_read(uuid) TO service_role;
