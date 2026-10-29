-- Staff auth audit actions for the dashboard: password recovery, MFA / passkey
-- enrol-remove-reset, and reset emails. Widens the CHECK on
-- public.staff_access_events.action (originally in 20261014200000).
-- Idempotent (re-runnable). Mirrors src/db/schema/staff-access-events.ts.

alter table public.staff_access_events
  drop constraint if exists staff_access_events_action_check;

alter table public.staff_access_events
  add constraint staff_access_events_action_check check (action in (
    'created', 'granted', 'role_changed', 'revoked',
    'suspended', 'reinstated', 'password_reset', 'password_changed',
    'password_recovered', 'mfa_enrolled', 'mfa_removed',
    'passkey_added', 'passkey_removed', 'mfa_reset', 'passkeys_reset',
    'reset_email_sent'
  ));
