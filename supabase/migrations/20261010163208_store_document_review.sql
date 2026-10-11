-- Store document review: Blink's verdict on each required store document.
--
-- Shape: { "<key>": { "status": "verified" | "rejected", "reason": text|null,
--                     "value": text, "reviewed_at": timestamptz, "reviewed_by": uuid } }
-- for key in commercial_register_front, commercial_register_back, nif, nis.
--
-- `value` is the exact document value staff looked at (the URL for scans, the
-- number for NIF/NIS). A review only counts while it still matches the current
-- value in `stores.documents`; when the merchant uploads a new file or edits a
-- number, the document is "pending" again until staff review it. Only
-- blink-server (service role) writes this column — merchants can't set it.
-- No backfill: existing documents start "pending" so staff verify them.

alter table public.stores
  add column if not exists document_review jsonb not null default '{}'::jsonb;
