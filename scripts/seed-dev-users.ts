// scripts/seed-dev-users.ts — run with: npm run seed:dev-users
//
// Idempotent seed for the four DEV test accounts — one per app role — used by
// the mobile app's dev account switcher (blink: data/dev-users.ts). Each gets:
//   • a Supabase auth user (email + password, email pre-confirmed), so the app
//     can `signInWithPassword` and get a REAL session/JWT for authed endpoints;
//   • a public.users row with the role + profile fields;
//   • the role-specific profile row(s) via ensureRoleProfile (same as /auth/*).
// Re-running resets the password and profile fields; it never duplicates.
// Keep the emails/password in sync with the mobile app's data/dev-users.ts.
import "dotenv/config";
import { supabaseAdmin } from "../src/lib/supabase";
import { ensureRoleProfile, type ServerRole } from "../src/routes/auth/shared";

const PASSWORD = process.env.DEV_USERS_PASSWORD ?? "BlinkDev#2026";

type DevUser = {
  email: string;
  role: ServerRole;
  first_name: string;
  last_name: string;
  phone_number: string;
  gender: "male" | "female";
  birthday: string;
};

const DEV_USERS: DevUser[] = [
  { email: "dev.customer@blink.dev", role: "customer", first_name: "Dev", last_name: "Customer", phone_number: "0550000001", gender: "male", birthday: "1995-01-01" },
  { email: "dev.rider@blink.dev", role: "rider", first_name: "Dev", last_name: "Rider", phone_number: "0550000002", gender: "male", birthday: "1995-01-02" },
  { email: "dev.merchant@blink.dev", role: "merchant", first_name: "Dev", last_name: "Merchant", phone_number: "0550000003", gender: "female", birthday: "1995-01-03" },
  { email: "dev.agent@blink.dev", role: "agent", first_name: "Dev", last_name: "Agent", phone_number: "0550000004", gender: "female", birthday: "1995-01-04" },
];

/** Find an auth user by email (admin API has no direct lookup — page through). */
async function findAuthUserId(email: string): Promise<string | undefined> {
  for (let page = 1; ; page++) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    const hit = data.users.find((u) => u.email?.toLowerCase() === email);
    if (hit) return hit.id;
    if (data.users.length < 1000) return undefined;
  }
}

async function seed(u: DevUser): Promise<void> {
  const metadata = { given_name: u.first_name, family_name: u.last_name, dev_user: true };

  let id = await findAuthUserId(u.email);
  if (id) {
    const { error } = await supabaseAdmin.auth.admin.updateUserById(id, {
      password: PASSWORD,
      email_confirm: true,
      user_metadata: metadata,
    });
    if (error) throw error;
  } else {
    const { data, error } = await supabaseAdmin.auth.admin.createUser({
      email: u.email,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: metadata,
    });
    if (error) throw error;
    id = data.user.id;
  }

  const { email, role, first_name, last_name, phone_number, gender, birthday } = u;
  const { error: rowError } = await supabaseAdmin
    .from("users")
    .upsert(
      { id, email, role, first_name, last_name, phone_number, gender, birthday },
      { onConflict: "id" },
    );
  if (rowError) throw rowError;

  await ensureRoleProfile(id, role);
  console.log(`✓ ${role.padEnd(8)} ${email}  (${id})`);
}

for (const u of DEV_USERS) await seed(u);
console.log(`\nPassword for all dev users: ${PASSWORD}`);
