-- Two-factor for staff at the database level.
--
-- The dashboard refuses an aal1 session once the user has a verified MFA factor, but the
-- tables below also grant staff direct access through their own JWT (PostgREST /
-- Realtime). Without this, a stolen password alone could read support mail and chats
-- with the raw API. Callers with a verified factor need an aal2 session for staff
-- access; everyone else (app users, who never enrol factors) is unaffected, and a staff
-- member's OWN mobile-app data (their support chats, order channels) never needs aal2.
-- The service role bypasses RLS as before.

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
    'staff_notifications'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_mfa', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR ALL TO authenticated '
      'USING ((SELECT public.mfa_satisfied())) WITH CHECK ((SELECT public.mfa_satisfied()))',
      t || '_mfa', t
    );
  END LOOP;
END $$;

-- Support chats are read by app users too: only their staff branch needs aal2.
DROP POLICY IF EXISTS "support_conversations_select_own_or_staff" ON public.support_conversations;
CREATE POLICY "support_conversations_select_own_or_staff" ON public.support_conversations
  FOR SELECT USING (
    auth.uid() = user_id
    OR (
      EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.staff_role IS NOT NULL)
      AND (SELECT public.mfa_satisfied())
    )
  );

DROP POLICY IF EXISTS "support_messages_select_own_or_staff" ON public.support_messages;
CREATE POLICY "support_messages_select_own_or_staff" ON public.support_messages
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.support_conversations sc
      WHERE sc.id = conversation_id
        AND (sc.user_id = auth.uid()
             OR (EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.staff_role IS NOT NULL)
                 AND (SELECT public.mfa_satisfied())))
    )
  );

-- The staff inbox Realtime topic (`staff:notifications`): same condition on its own policy
-- (a restrictive policy on realtime.messages would also hit a staff member's app channels).
DROP POLICY IF EXISTS "blink_staff_receive_notifications" ON realtime.messages;
CREATE POLICY "blink_staff_receive_notifications"
  ON realtime.messages
  FOR SELECT
  TO authenticated
  USING (
    realtime.messages.extension = 'broadcast'
    AND realtime.topic() = 'staff:notifications'
    AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.staff_role IS NOT NULL)
    AND (SELECT public.mfa_satisfied())
  );
