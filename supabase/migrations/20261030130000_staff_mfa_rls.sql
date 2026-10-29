-- Two-factor for staff at the database level.
--
-- The dashboard refuses an aal1 session once the user has a verified MFA factor, but the
-- tables below also grant staff direct access through their own JWT (PostgREST /
-- Realtime). Without this, a stolen password alone could read support mail and chats
-- with the raw API. A RESTRICTIVE policy is ANDed with the existing permissive ones:
-- callers with a verified factor need an aal2 session; everyone else (app users, who
-- never enrol factors) is unaffected. The service role bypasses RLS as before.

CREATE OR REPLACE FUNCTION public.mfa_satisfied()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT coalesce(auth.jwt() ->> 'aal', '') = 'aal2'
      OR NOT EXISTS (
        SELECT 1
        FROM auth.mfa_factors f
        WHERE f.user_id = auth.uid()
          AND f.status = 'verified'
      );
$$;

REVOKE ALL ON FUNCTION public.mfa_satisfied() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mfa_satisfied() TO anon, authenticated;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'alert_rules',
    'alert_events',
    'email_threads',
    'email_messages',
    'staff_notifications',
    'support_conversations',
    'support_messages'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_mfa', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR ALL TO authenticated '
      'USING ((SELECT public.mfa_satisfied())) WITH CHECK ((SELECT public.mfa_satisfied()))',
      t || '_mfa', t
    );
  END LOOP;
END $$;

-- The staff inbox Realtime topic (`staff:notifications`) is authorised by
-- `blink_staff_receive_notifications` on realtime.messages.
DROP POLICY IF EXISTS "blink_mfa_receive" ON realtime.messages;
CREATE POLICY "blink_mfa_receive" ON realtime.messages
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING ((SELECT public.mfa_satisfied()));
