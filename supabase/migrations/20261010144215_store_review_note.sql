-- Store review note: why staff rejected or deactivated a merchant store.
--
-- Set when staff move a store to `inactive` (PATCH /merchant/admin/stores/{id}/status),
-- shown to the merchant, and kept while the merchant resubmits (status back to
-- `under_review`) so the reviewer sees the earlier reason. Cleared when staff
-- approve the store. A null note on an `inactive` store means it was hidden for
-- another reason (e.g. an account deletion request), which can't be resubmitted.

alter table public.stores add column if not exists review_note text;
