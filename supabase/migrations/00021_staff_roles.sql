-- Staff role: the console / ERP authority axis, SEPARATE from `users.role`
-- (the mobile-app persona: customer/rider/merchant/agent). Until now the
-- dashboard's access model (blink-dashboard/src/lib/auth/access.ts + staff.ts)
-- expected a `users.staff_role` column that never existed, so staff.ts fell back
-- to treating every authenticated user as super_admin. This migration lands the
-- column so console access is real and gateable.
--
--  • NULL  → not a console operator (app users: customers, riders, …).
--  • value → dashboard authority at the level access.ts maps for that role.
--
-- Mirrors src/db/schema/enums.ts (staffRole) + src/db/schema/users.ts.

CREATE TYPE staff_role AS ENUM (
  'super_admin',
  'ops_admin',
  'finance_admin',
  'support_admin',
  'commerce_admin',
  'hr_admin'
);

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS staff_role staff_role;

CREATE INDEX IF NOT EXISTS idx_users_staff_role ON public.users(staff_role);

-- Seed the bootstrap console admin. Without this, enabling the column would lock
-- the existing admin account out of the dashboard (null staff_role = no access).
UPDATE public.users SET staff_role = 'super_admin' WHERE email = 'admin@blink.dz';
