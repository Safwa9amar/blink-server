// scripts/seed-support-content.ts — run with: npx tsx scripts/seed-support-content.ts
//
// Idempotent seed for the Help Center data layer (00025_support_help_center):
//   • support_categories — the "Common Topics" tiles / FAQ groups, per role.
//   • support_articles    — the role FAQs (type:"faq"), ported from SUPPORT_KB.
// Skips entirely if support_articles already has rows. Writes go through the
// service-role client (bypasses RLS).
import "dotenv/config";
import { supabaseAdmin } from "../src/lib/supabase";
import { SUPPORT_KB } from "../src/lib/ai/support-kb";
import type { SupportCategoryInsert, SupportArticleInsert } from "../src/db";

// Capitalized role labels stored in target_roles / matched in RLS-free reads.
const ROLE_LABEL: Record<string, string> = {
  customer: "Customer",
  rider: "Rider",
  merchant: "Merchant",
  agent: "Agent",
};

// Per-role "account" category key each role's FAQs map onto.
const ROLE_ACCOUNT_KEY: Record<string, string> = {
  customer: "account",
  rider: "account",
  merchant: "account",
  agent: "account",
};

// Common Topics tiles, per role. Role-specific tiles carry the single
// capitalized role label; the shared "account" tile is visible to everyone.
const CATEGORIES: SupportCategoryInsert[] = [
  // ─── Shared ──────────────────────────────────────────────────────────
  {
    key: "account",
    targetRoles: ["All"],
    labelEng: "Account Issues",
    icon: "person.crop.circle",
    color: "#3B82F6",
    sort: 0,
  },
  // ─── Customer ────────────────────────────────────────────────────────
  {
    key: "payment",
    targetRoles: ["Customer"],
    labelEng: "Payment & Refunds",
    icon: "banknote",
    color: "#10B981",
    sort: 1,
  },
  {
    key: "tracking",
    targetRoles: ["Customer"],
    labelEng: "Order Tracking",
    icon: "truck.fill",
    color: "#F59E0B",
    sort: 2,
  },
  {
    key: "promos",
    targetRoles: ["Customer"],
    labelEng: "Promo Codes",
    icon: "tag.fill",
    color: "#8B5CF6",
    sort: 3,
  },
  // ─── Rider ───────────────────────────────────────────────────────────
  {
    key: "trips",
    targetRoles: ["Rider"],
    labelEng: "Trips & Cancellations",
    icon: "map.fill",
    color: "#F59E0B",
    sort: 1,
  },
  {
    key: "payouts",
    targetRoles: ["Rider"],
    labelEng: "Earnings & Payouts",
    icon: "banknote",
    color: "#10B981",
    sort: 2,
  },
  {
    key: "vehicle",
    targetRoles: ["Rider"],
    labelEng: "Vehicle & Documents",
    icon: "car.fill",
    color: "#8B5CF6",
    sort: 3,
  },
  // ─── Merchant ────────────────────────────────────────────────────────
  {
    key: "store",
    targetRoles: ["Merchant"],
    labelEng: "Store Management",
    icon: "storefront.fill",
    color: "#3B82F6",
    sort: 1,
  },
  {
    key: "earnings",
    targetRoles: ["Merchant"],
    labelEng: "Earnings & Payouts",
    icon: "banknote",
    color: "#10B981",
    sort: 2,
  },
  {
    key: "promotions",
    targetRoles: ["Merchant"],
    labelEng: "Promotions",
    icon: "tag.fill",
    color: "#8B5CF6",
    sort: 3,
  },
  // ─── Agent ───────────────────────────────────────────────────────────
  {
    key: "deposits",
    targetRoles: ["Agent"],
    labelEng: "Deposits",
    icon: "arrow.down.circle.fill",
    color: "#10B981",
    sort: 1,
  },
  {
    key: "withdrawals",
    targetRoles: ["Agent"],
    labelEng: "Withdrawals",
    icon: "arrow.up.circle.fill",
    color: "#F59E0B",
    sort: 2,
  },
  {
    key: "shop",
    targetRoles: ["Agent"],
    labelEng: "Shop Management",
    icon: "storefront.fill",
    color: "#3B82F6",
    sort: 3,
  },
];

async function main() {
  // Idempotency guard — skip the whole seed if articles already exist.
  const { count, error: countErr } = await supabaseAdmin
    .from("support_articles")
    .select("id", { count: "exact", head: true });
  if (countErr) throw countErr;
  if ((count ?? 0) > 0) {
    console.log(`support_articles already has ${count} row(s) — skipping seed.`);
    return;
  }

  // 1) Categories.
  const { data: catRows, error: catErr } = await supabaseAdmin
    .from("support_categories")
    .insert(CATEGORIES)
    .select("id");
  if (catErr) throw catErr;
  const catCount = catRows?.length ?? 0;

  // 2) FAQs from SUPPORT_KB — each role's entries map onto that role's
  //    "account" category, scoped to the role label.
  const faqs: SupportArticleInsert[] = [];
  for (const [role, entries] of Object.entries(SUPPORT_KB)) {
    const roleLabel = ROLE_LABEL[role];
    if (!roleLabel) continue; // unknown role — skip
    const categoryKey = ROLE_ACCOUNT_KEY[role] ?? "account";
    entries.forEach((e, i) => {
      faqs.push({
        type: "faq",
        category: categoryKey,
        targetRoles: [roleLabel],
        status: "published",
        contentEng: { title: e.q, body: e.a },
        sort: i,
      });
    });
  }

  const { data: faqRows, error: faqErr } = await supabaseAdmin
    .from("support_articles")
    .insert(faqs)
    .select("id");
  if (faqErr) throw faqErr;
  const faqCount = faqRows?.length ?? 0;

  console.log(`Seeded ${catCount} categories + ${faqCount} faqs.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
