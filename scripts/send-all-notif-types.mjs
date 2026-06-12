// Send ONE notification of every type to all four roles, via the live
// broadcast-test endpoint. Types with server-side detail pages (offer/benefit/
// deposit/alert/security) omit href so the server auto-derives the correct
// per-role deep link from the new notification id. `news` links to a real post.
import "dotenv/config";

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY } = process.env;
const API = "https://blink.greenpedal.net";
const ROLES = ["customer", "rider", "merchant", "agent"];
const svc = {
  apikey: SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
  "Content-Type": "application/json",
};

// 1) Create a published news post so the news-type notif has a real target.
const now = new Date().toISOString();
const slug = `whats-new-${now.replace(/[^0-9]/g, "").slice(0, 14)}`;
const nRes = await fetch(`${SUPABASE_URL}/rest/v1/news`, {
  method: "POST",
  headers: { ...svc, Prefer: "return=representation" },
  body: JSON.stringify({
    slug, category: "Network", target_roles: ["All"], status: "published",
    push: true, cta_label: "Read more", published_at: now,
    content_eng: { title: "What's new in Blink", sum: "A roundup of the latest updates.", body: "<p>Here's everything new this week.</p>" },
    content_fr: { title: "Quoi de neuf sur Blink", sum: "Un résumé des dernières nouveautés.", body: "<p>Voici toutes les nouveautés de la semaine.</p>" },
    content_ar: { title: "ما الجديد في بلينك", sum: "ملخص لآخر التحديثات.", body: "<p>إليك كل جديد هذا الأسبوع.</p>" },
  }),
});
const post = (await nRes.json())[0];
if (!nRes.ok || !post) { console.error("news insert failed", post); process.exit(1); }
console.log("✓ news post:", post.slug);

// 2) Mint a token.
const apikey = SUPABASE_ANON_KEY || SUPABASE_SERVICE_ROLE_KEY;
const [u] = await (await fetch(`${SUPABASE_URL}/rest/v1/users?select=id,email&limit=1`, { headers: svc })).json();
const gen = await (await fetch(`${SUPABASE_URL}/auth/v1/admin/generate_link`, {
  method: "POST", headers: svc, body: JSON.stringify({ type: "magiclink", email: u.email }),
})).json();
const { access_token } = await (await fetch(`${SUPABASE_URL}/auth/v1/verify`, {
  method: "POST", headers: { apikey, "Content-Type": "application/json" },
  body: JSON.stringify({ type: "magiclink", token_hash: gen.hashed_token }),
})).json();
if (!access_token) { console.error("token mint failed"); process.exit(1); }

// 3) One broadcast per type. href omitted = auto-derive per-role detail link.
const TYPES = [
  { type: "announcement", title: "Welcome to Blink",        description: "Thanks for being part of Blink 🎉" },
  { type: "alert",        title: "Account alert",            description: "We noticed something that needs your attention." },
  { type: "security",     title: "Security notice",          description: "A new device signed in to your account." },
  { type: "offer",        title: "Special offer for you",    description: "20% off your next ride — tap to view." },
  { type: "benefit",      title: "New benefit unlocked",     description: "You've earned a new member benefit 🎁" },
  { type: "deposit",      title: "Bonus credited",           description: "A deposit bonus has landed in your wallet 💰" },
  { type: "promo",        title: "Weekend promo",            description: "Limited-time deals all weekend long." },
  { type: "order",        title: "Order update",             description: "There's an update on your recent order." },
  { type: "courier",      title: "Courier on the way",       description: "Your courier is heading to you now 🛵" },
  { type: "news",         title: "What's new in Blink",      description: "A roundup of the latest updates.", href: `/news/${post.slug}` },
];

for (const n of TYPES) {
  const body = { roles: ROLES, type: n.type, title: n.title, description: n.description };
  if (n.href) body.href = n.href;
  const r = await fetch(`${API}/notifications/broadcast-test`, {
    method: "POST",
    headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  console.log(`  ${n.type.padEnd(13)} → HTTP ${r.status}  recipients=${j.recipients ?? JSON.stringify(j)}${n.href ? "  href=" + n.href : ""}`);
}
console.log("✓ done — sent", TYPES.length, "notification types to", ROLES.length, "roles each");
