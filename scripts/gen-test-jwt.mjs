// One-off: get a REAL Supabase access token for an existing user, so we can hit
// the authed API from curl. Uses the service-role key to have GoTrue issue the
// token (admin generate_link -> verify token_hash), so the server's getUser()
// accepts it by construction. No JWT secret required.
//
//   node scripts/gen-test-jwt.mjs [role]      e.g. rider | customer | merchant | agent
import "dotenv/config";

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
const apikey = SUPABASE_ANON_KEY || SUPABASE_SERVICE_ROLE_KEY;

// 1) Pick a user (optionally by role).
const wantRole = process.argv[2];
const filter = wantRole ? `&role=eq.${wantRole}` : "";
const uRes = await fetch(
  `${SUPABASE_URL}/rest/v1/users?select=id,email,role${filter}&limit=1`,
  { headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } }
);
const users = await uRes.json();
if (!Array.isArray(users) || users.length === 0) {
  console.error("No user found", users);
  process.exit(1);
}
const u = users[0];

// 2) Admin: generate a magiclink to get a verifiable token_hash for this email.
const genRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/generate_link`, {
  method: "POST",
  headers: {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ type: "magiclink", email: u.email }),
});
const gen = await genRes.json();
if (!genRes.ok || !gen.hashed_token) {
  console.error("generate_link failed", genRes.status, gen);
  process.exit(1);
}

// 3) Verify the token_hash -> a real session (access_token).
const vRes = await fetch(`${SUPABASE_URL}/auth/v1/verify`, {
  method: "POST",
  headers: { apikey, "Content-Type": "application/json" },
  body: JSON.stringify({ type: "magiclink", token_hash: gen.hashed_token }),
});
const session = await vRes.json();
if (!vRes.ok || !session.access_token) {
  console.error("verify failed", vRes.status, session);
  process.exit(1);
}

console.log(JSON.stringify({ user: u, token: session.access_token }, null, 2));
