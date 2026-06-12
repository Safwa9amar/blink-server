// Create a published Blink News post, then broadcast a `news`-type notification
// to all roles, deep-linking to the post (/news/<slug>). Uses the service role
// for the insert and the live broadcast-test endpoint for the fan-out.
import "dotenv/config";

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY } = process.env;
const API = "https://blink.greenpedal.net";
const svc = {
  apikey: SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
  "Content-Type": "application/json",
};

const now = new Date().toISOString();
const stamp = now.replace(/[^0-9]/g, "").slice(0, 14);
const slug = `blink-update-${stamp}`;

const copy = {
  eng: {
    title: "Blink is better than ever",
    sum: "New features just landed — see what's new in this release.",
    body: "<p>We've shipped a fresh batch of improvements across rides, payments and rewards. Tap through to read the full rundown and start using them today.</p>",
  },
  fr: {
    title: "Blink est meilleur que jamais",
    sum: "De nouvelles fonctionnalités sont arrivées — découvrez les nouveautés.",
    body: "<p>Nous avons déployé de nombreuses améliorations sur les trajets, les paiements et les récompenses. Cliquez pour tout découvrir et en profiter dès aujourd'hui.</p>",
  },
  ar: {
    title: "بلينك أفضل من أي وقت مضى",
    sum: "ميزات جديدة وصلت — اكتشف الجديد في هذا الإصدار.",
    body: "<p>أطلقنا مجموعة من التحسينات على الرحلات والمدفوعات والمكافآت. اضغط لقراءة التفاصيل الكاملة والبدء باستخدامها اليوم.</p>",
  },
};

// 1) Insert the published news post.
const insert = {
  slug,
  category: "Network",
  target_roles: ["All"],
  status: "published",
  pinned: false,
  push: true,
  cta_label: "Read more",
  content_eng: copy.eng,
  content_fr: copy.fr,
  content_ar: copy.ar,
  published_at: now,
};

const nRes = await fetch(`${SUPABASE_URL}/rest/v1/news`, {
  method: "POST",
  headers: { ...svc, Prefer: "return=representation" },
  body: JSON.stringify(insert),
});
const nBody = await nRes.json();
if (!nRes.ok) {
  console.error("news insert failed", nRes.status, nBody);
  process.exit(1);
}
const post = Array.isArray(nBody) ? nBody[0] : nBody;
console.log("✓ created news:", { id: post.id, slug: post.slug, status: post.status });

// 2) Mint a token (same flow as gen-test-jwt) to call the authed endpoint.
const apikey = SUPABASE_ANON_KEY || SUPABASE_SERVICE_ROLE_KEY;
const uRes = await fetch(`${SUPABASE_URL}/rest/v1/users?select=id,email&limit=1`, { headers: svc });
const [u] = await uRes.json();
const gRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/generate_link`, {
  method: "POST",
  headers: svc,
  body: JSON.stringify({ type: "magiclink", email: u.email }),
});
const gen = await gRes.json();
const vRes = await fetch(`${SUPABASE_URL}/auth/v1/verify`, {
  method: "POST",
  headers: { apikey, "Content-Type": "application/json" },
  body: JSON.stringify({ type: "magiclink", token_hash: gen.hashed_token }),
});
const { access_token } = await vRes.json();
if (!access_token) { console.error("token mint failed"); process.exit(1); }

// 3) Broadcast a news-type notification to all roles, linking to the post.
const bRes = await fetch(`${API}/notifications/broadcast-test`, {
  method: "POST",
  headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" },
  body: JSON.stringify({
    roles: ["customer", "rider", "merchant", "agent"],
    type: "news",
    title: copy.eng.title,
    description: copy.eng.sum,
    href: `/news/${post.slug}`,
    payload: { newsId: post.id, slug: post.slug, category: post.category },
  }),
});
const bBody = await bRes.json();
console.log("✓ broadcast:", bRes.status, bBody, "→ href /news/" + post.slug);
