// scripts/seed-dev-agents.ts — run with: npm run seed:dev-agents
//
// Gives the DEV environment several ACTIVE Blink Cash agent shops, so the rider
// deposit / withdraw agent locator (GET /agents/nearby) has agents to pick:
//   • dev.agent@blink.dev (seed-dev-users.ts — must already exist) gets 3 shops;
//   • two more dev agent accounts, dev.agent2@ and dev.agent3@blink.dev, are
//     created (same password as the other dev users) with 2 shops each.
// Every shop is open, staff-approved (review_status 'active') and open
// 08:00–22:00 every day, around Algiers.
//
// Idempotent, keyed by (agent, shop_name): re-running resets the seeded shops to
// these values and never duplicates them. Each agent's first shop is its
// primary and fills the blank placeholder shop ensureRoleProfile creates —
// unless the agent already has a named primary (their own shop, or a seeded one
// they promoted): the seed never moves it, and the seeded shops sit beside it.
// Apart from that placeholder, shops the seed didn't create are never modified.
// Existing accounts keep their password and profile (only role 'agent' is
// enforced). No PIN is set and no transactions are created.
import "dotenv/config";
import { supabaseAdmin } from "../src/lib/supabase";
import { ensureRoleProfile } from "../src/routes/auth/shared";

const PASSWORD = process.env.DEV_USERS_PASSWORD ?? "BlinkDev#2026";

const OPEN = "08:00";
const CLOSE = "22:00";
const DAYS = ["sat", "sun", "mon", "tue", "wed", "thu", "fri"];

/** Columns every seeded shop shares: open now, verified, 08:00–22:00 daily. */
const SHOP_DEFAULTS = {
  status: "open",
  review_status: "active",
  open_time: OPEN,
  close_time: CLOSE,
  hours: Object.fromEntries(
    DAYS.map((d) => [d, { enabled: true, shifts: [{ open: OPEN, close: CLOSE }] }])
  ),
  documents: {},
  manual_override: false,
};

const IMG = (id: string) => `https://images.unsplash.com/${id}?w=600&q=80`;

type SeedShop = {
  shop_name: string;
  latitude: number;
  longitude: number;
  address: string;
  phone_number: string;
  rating: number;
  shop_image_url: string;
};

type DevAgent = {
  email: string;
  /** Profile of a NEW account — absent for dev.agent@, which seed-dev-users.ts owns. */
  profile?: {
    first_name: string;
    last_name: string;
    phone_number: string;
    gender: "male" | "female";
    birthday: string;
  };
  /** The first shop is the agent's primary. */
  shops: SeedShop[];
};

const DEV_AGENTS: DevAgent[] = [
  {
    email: "dev.agent@blink.dev",
    shops: [
      { shop_name: "Blink Point Didouche Mourad", latitude: 36.7631, longitude: 3.0506, address: "12 Rue Didouche Mourad, Alger Centre", phone_number: "0550000004", rating: 4.8, shop_image_url: IMG("photo-1604754742629-3e5728249d73") },
      { shop_name: "Blink Point Bab Ezzouar", latitude: 36.7213, longitude: 3.1835, address: "Cité 5 Juillet, Bab Ezzouar", phone_number: "0550000014", rating: 4.6, shop_image_url: IMG("photo-1578916171728-46686eac8d58") },
      { shop_name: "Blink Point Hydra", latitude: 36.7406, longitude: 3.0335, address: "Rue des Frères Daoud, Hydra", phone_number: "0550000024", rating: 4.5, shop_image_url: IMG("photo-1582539512157-2d0d59953dad") },
    ],
  },
  {
    email: "dev.agent2@blink.dev",
    profile: { first_name: "Dev", last_name: "Agent Two", phone_number: "0550000005", gender: "male", birthday: "1995-01-05" },
    shops: [
      { shop_name: "Kouba Cash Point", latitude: 36.7241, longitude: 3.0838, address: "Boulevard Mohamed V, Kouba", phone_number: "0550000005", rating: 4.7, shop_image_url: IMG("photo-1556740738-b6a63e27c4df") },
      { shop_name: "Bir Mourad Raïs Cash Point", latitude: 36.7364, longitude: 3.051, address: "Rue Ahmed Ouaked, Bir Mourad Raïs", phone_number: "0550000015", rating: 4.4, shop_image_url: IMG("photo-1601597111158-2fceff292cdc") },
    ],
  },
  {
    email: "dev.agent3@blink.dev",
    profile: { first_name: "Dev", last_name: "Agent Three", phone_number: "0550000006", gender: "female", birthday: "1995-01-06" },
    shops: [
      { shop_name: "Chéraga Blink Agent", latitude: 36.7676, longitude: 2.9584, address: "Route de Dely Ibrahim, Chéraga", phone_number: "0550000006", rating: 4.9, shop_image_url: IMG("photo-1567449303078-57ad995bd329") },
      { shop_name: "El Harrach Blink Agent", latitude: 36.7206, longitude: 3.1389, address: "Rue Mohamed Belouizdad, El Harrach", phone_number: "0550000016", rating: 4.3, shop_image_url: IMG("photo-1563013544-824ae1b704d3") },
    ],
  },
];

type ShopRow = { id: string; shop_name: string; is_primary: boolean };

/** The unnamed shop ensureRoleProfile creates for a new agent. */
const isPlaceholder = (r: ShopRow) => !r.shop_name.trim();

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

async function must<T>(p: PromiseLike<{ data: T; error: { message: string } | null }>, what: string): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(`${what}: ${error.message}`);
  return data;
}

/**
 * The agent's user id. A new dev agent gets its auth user + users row; an
 * existing account is reused as-is (password and profile untouched) with only
 * role 'agent' enforced. dev.agent@ is never created here — undefined if missing.
 */
async function ensureAgent(a: DevAgent): Promise<string | undefined> {
  let id = await findAuthUserId(a.email);
  if (!id) {
    if (!a.profile) {
      console.error(`✗ ${a.email} not found — run npm run seed:dev-users first. Skipped.`);
      return undefined;
    }
    const { data, error } = await supabaseAdmin.auth.admin.createUser({
      email: a.email,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { given_name: a.profile.first_name, family_name: a.profile.last_name, dev_user: true },
    });
    if (error) throw error;
    id = data.user.id;
    console.log(`✓ created ${a.email}`);
  }

  const row = await must(supabaseAdmin.from("users").select("role").eq("id", id).maybeSingle(), `load ${a.email}`);
  if (!row) {
    if (!a.profile) {
      console.error(`✗ ${a.email} has no users row — run npm run seed:dev-users first. Skipped.`);
      return undefined;
    }
    // New account (or one whose earlier run stopped before this row).
    await must(
      supabaseAdmin.from("users").upsert({ id, email: a.email, role: "agent", signup_role: "agent", ...a.profile }, { onConflict: "id" }),
      `upsert ${a.email}`
    );
  } else if (row.role !== "agent") {
    await must(supabaseAdmin.from("users").update({ role: "agent" }).eq("id", id), `set ${a.email} role`);
    console.log(`  role ${row.role} → agent`);
  }

  // agent_profiles row + (brand-new agent only) the blank primary placeholder shop.
  await ensureRoleProfile(id, "agent");
  return id;
}

/** Update `row` (the seeded shop or the placeholder) with `s`, or insert it. */
async function saveShop(userId: string, s: SeedShop, isPrimary: boolean, row: ShopRow | undefined): Promise<void> {
  const values = { ...s, ...SHOP_DEFAULTS, is_primary: isPrimary };
  const { data, error } = await (row
    ? supabaseAdmin.from("agent_shops").update(values).eq("id", row.id).eq("user_id", userId).select("id").single()
    : supabaseAdmin.from("agent_shops").insert({ user_id: userId, ...values }).select("id").single());
  if (error) throw new Error(`save ${s.shop_name}: ${error.message}`);
  const how = !row ? "inserted" : isPlaceholder(row) ? "filled the placeholder" : "updated";
  console.log(`  ✓ ${s.shop_name.padEnd(28)} ${data.id}  ${isPrimary ? "primary, " : ""}${how}`);
}

/**
 * Upsert the agent's seeded shops by name. The first one fills the blank
 * placeholder when there is one and takes the primary slot — unless the agent
 * already has a named primary, which then stays the primary.
 */
async function seedShops(userId: string, a: DevAgent): Promise<void> {
  const rows = (await must(
    supabaseAdmin
      .from("agent_shops")
      .select("id, shop_name, is_primary")
      .eq("user_id", userId)
      .order("created_at", { ascending: true }),
    "list shops"
  )) as ShopRow[];
  const byName = (name: string) => rows.find((r) => r.shop_name === name);

  const current = rows.find((r) => r.is_primary);
  // A named primary is never moved — the agent's own shop, or a seeded one
  // (an earlier run's, or one the agent promoted in the app).
  const keptPrimary = current && !isPlaceholder(current) ? current : undefined;

  const [first, ...rest] = a.shops;
  // By name first, so a re-run never fills a second row with the same shop.
  const firstRow =
    byName(first.shop_name) ??
    rows.find((r) => isPlaceholder(r) && r.is_primary) ??
    rows.find(isPlaceholder);

  if (keptPrimary) {
    console.log(`  • keeping "${keptPrimary.shop_name}" (${keptPrimary.id}) as primary`);
  } else if (current && current.id !== firstRow?.id) {
    // One primary per agent (unique index agent_shops_one_primary): demote first.
    await must(
      supabaseAdmin.from("agent_shops").update({ is_primary: false }).eq("id", current.id).eq("user_id", userId),
      "demote primary"
    );
  }

  // With a kept primary every seeded shop keeps its current flag; otherwise the first one is primary.
  const isKept = (row: ShopRow | undefined) => !!row && row.id === keptPrimary?.id;
  await saveShop(userId, first, keptPrimary ? isKept(firstRow) : true, firstRow);
  for (const s of rest) {
    const row = byName(s.shop_name);
    await saveShop(userId, s, isKept(row), row);
  }
}

async function main() {
  let skipped = 0;
  for (const a of DEV_AGENTS) {
    const id = await ensureAgent(a);
    if (!id) {
      skipped++;
      continue;
    }
    console.log(`✓ agent ${a.email}  (${id})`);
    await seedShops(id, a);
  }
  console.log(`\nDone — ${DEV_AGENTS.length - skipped}/${DEV_AGENTS.length} dev agents seeded. New ones sign in with: ${PASSWORD}`);
  if (skipped) process.exitCode = 1;
}

main().catch((e) => {
  console.error("✗", e.message ?? e);
  process.exit(1);
});
