// scripts/seed-support-full.ts
// Full Help Center seed — REPLACES all support content with a large, trilingual,
// role-scoped library (categories + articles + FAQs).
//
//   npx tsx scripts/seed-support-full.ts --dry   # validate only, no DB writes
//   npx tsx scripts/seed-support-full.ts         # wipe + reseed
//
// Reads scripts/support-seed/*.json:
//   • categories.json — the Common-Topics tiles / FAQ groups (hand-authored).
//   • {shared,customer,rider,merchant,agent}.json — the articles & FAQs.
// Writes go through the service-role client (bypasses RLS).
import "dotenv/config";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { supabaseAdmin } from "../src/lib/supabase";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIR = join(__dirname, "support-seed");
const DRY = process.argv.includes("--dry");

type Row = Record<string, unknown>;
type Content = { title: string; body: string };
type Item = {
  type: "article" | "faq";
  category: string;
  target_roles: string[];
  status?: string;
  sort?: number;
  author?: string | null;
  cover_url?: string | null;
  content_eng: Content;
  content_fr: Content;
  content_ar: Content;
};

const CONTENT_FILES = ["shared", "customer", "rider", "merchant", "agent"];
const VALID_TYPES = new Set(["article", "faq"]);
const VALID_STATUS = new Set(["draft", "review", "published"]);
const VALID_ROLES = new Set(["All", "Customer", "Rider", "Merchant", "Agent"]);

function read<T>(name: string): T {
  return JSON.parse(readFileSync(join(DIR, name), "utf8")) as T;
}

function nonEmpty(c: unknown): c is Content {
  return (
    !!c &&
    typeof (c as Content).title === "string" &&
    (c as Content).title.trim().length > 0 &&
    typeof (c as Content).body === "string" &&
    (c as Content).body.trim().length > 0
  );
}

function main() {
  // ── Load ───────────────────────────────────────────────────────────────
  const categories = read<Row[]>("categories.json");
  const validKeys = new Set(categories.map((c) => String(c.key)));

  const items: Item[] = [];
  for (const f of CONTENT_FILES) {
    let arr: Item[] = [];
    try {
      arr = read<Item[]>(`${f}.json`);
    } catch {
      console.warn(`⚠️  ${f}.json missing — skipping.`);
      continue;
    }
    console.log(`  ${f}.json: ${arr.length} item(s)`);
    items.push(...arr);
  }

  // ── Validate ─────────────────────────────────────────────────────────────
  const errors: string[] = [];
  items.forEach((it, i) => {
    const where = `${it.content_eng?.title ?? "<no title>"} (#${i})`;
    if (!VALID_TYPES.has(it.type)) errors.push(`bad type "${it.type}" — ${where}`);
    if (!validKeys.has(it.category)) errors.push(`unknown category "${it.category}" — ${where}`);
    if (it.status && !VALID_STATUS.has(it.status)) errors.push(`bad status "${it.status}" — ${where}`);
    if (!Array.isArray(it.target_roles) || it.target_roles.length === 0)
      errors.push(`empty target_roles — ${where}`);
    else
      for (const r of it.target_roles)
        if (!VALID_ROLES.has(r)) errors.push(`bad role "${r}" — ${where}`);
    if (!nonEmpty(it.content_eng)) errors.push(`missing content_eng — ${where}`);
    if (!nonEmpty(it.content_fr)) errors.push(`missing content_fr — ${where}`);
    if (!nonEmpty(it.content_ar)) errors.push(`missing content_ar — ${where}`);
  });

  // Every category should have ≥1 item targeting a compatible audience.
  const usedKeys = new Set(items.map((i) => i.category));
  const emptyCats = categories.map((c) => String(c.key)).filter((k) => !usedKeys.has(k));
  if (emptyCats.length) console.warn(`⚠️  categories with no items: ${emptyCats.join(", ")}`);

  console.log(
    `\nSummary: ${categories.length} categories, ${items.length} items ` +
      `(${items.filter((i) => i.type === "faq").length} faqs, ${items.filter((i) => i.type === "article").length} articles).`,
  );
  const byRole: Record<string, number> = {};
  for (const it of items) for (const r of it.target_roles) byRole[r] = (byRole[r] ?? 0) + 1;
  console.log("By audience:", byRole);

  if (errors.length) {
    console.error(`\n❌ ${errors.length} validation error(s):`);
    errors.slice(0, 40).forEach((e) => console.error("  - " + e));
    process.exit(1);
  }
  console.log("✅ Validation passed.");

  if (DRY) {
    console.log("\n(--dry) No DB writes performed.");
    return Promise.resolve();
  }

  return seed(categories, items);
}

async function seed(categories: Row[], items: Item[]) {
  // ── Wipe (replace-everything mode) ───────────────────────────────────────
  const ALL = "00000000-0000-0000-0000-000000000000";
  const { error: delA } = await supabaseAdmin.from("support_articles").delete().neq("id", ALL);
  if (delA) throw delA;
  const { error: delC } = await supabaseAdmin.from("support_categories").delete().neq("id", ALL);
  if (delC) throw delC;
  console.log("🧹 Cleared existing support_articles + support_categories.");

  // ── Categories ───────────────────────────────────────────────────────────
  const { data: catRows, error: catErr } = await supabaseAdmin
    .from("support_categories")
    .insert(categories)
    .select("id");
  if (catErr) throw catErr;
  console.log(`📂 Inserted ${catRows?.length ?? 0} categories.`);

  // ── Articles + FAQs (batched) ────────────────────────────────────────────
  const rows: Row[] = items.map((it) => ({
    type: it.type,
    category: it.category,
    target_roles: it.target_roles,
    status: it.status ?? "published",
    sort: it.sort ?? 0,
    author: it.author ?? (it.type === "article" ? "Blink Support" : null),
    cover_url: it.cover_url ?? null,
    content_eng: it.content_eng,
    content_fr: it.content_fr,
    content_ar: it.content_ar,
  }));

  let inserted = 0;
  const BATCH = 50;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const { data, error } = await supabaseAdmin.from("support_articles").insert(chunk).select("id");
    if (error) throw error;
    inserted += data?.length ?? 0;
    console.log(`  …inserted ${inserted}/${rows.length}`);
  }

  console.log(`\n✅ Seeded ${catRows?.length ?? 0} categories + ${inserted} articles/faqs.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
