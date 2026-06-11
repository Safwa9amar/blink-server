-- OAuth (Google) users authenticate by email and have no phone number.
-- Drop the NOT NULL constraint on users.phone_number so an email-only profile
-- row can be created. The UNIQUE constraint stays (Postgres allows multiple
-- NULLs under a unique index), so phone uniqueness is still enforced for the
-- OTP flow.
ALTER TABLE public.users ALTER COLUMN phone_number DROP NOT NULL;
