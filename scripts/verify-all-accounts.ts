// scripts/verify-all-accounts.ts — one-off admin script.
//   npm run verify:all            → DRY RUN (default): reads, prints the report, writes nothing
//   npm run verify:all -- --apply → performs exactly what the dry run printed
//
// 1. Riders: every required document (by vehicle type) becomes "verified"; missing ones
//    get a shared placeholder file in the private `rider-documents` bucket;
//    verification_status → 'approved'.
// 2. Agents: every uploaded commercial-register entry → "verified"; shops
//    'under_review' → 'active'. Missing agent documents are NOT invented.
// 3. Users with an incomplete name ("First Rest" in first_name, empty last_name) are split.
import "dotenv/config";
import { deflateSync } from "node:zlib";
import { supabaseAdmin } from "../src/lib/supabase";
import { requiredDocumentKeys, type RiderStoredDocument } from "../src/lib/rider-verification";
import { RIDER_DOCS_BUCKET } from "../src/routes/riders/verification-shared";

const APPLY = process.argv.includes("--apply");
const PLACEHOLDER = "_placeholder/verified-document.png";
const AGENT_DOC_KEYS = ["commercial_register_front", "commercial_register_back"] as const;
const now = new Date().toISOString();

type Row = Record<string, any>;

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
/** 64×40 8-bit grey PNG. */
function placeholderPng(): Buffer {
  const w = 64, h = 40;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grayscale
  const raw = Buffer.alloc((w + 1) * h, 0xd0); // light grey
  for (let y = 0; y < h; y++) raw[y * (w + 1)] = 0; // filter byte: none
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function fetchAll(table: string, columns: string, filter?: (q: any) => any): Promise<Row[]> {
  const out: Row[] = [];
  for (let from = 0; ; from += 1000) {
    let q: any = supabaseAdmin.from(table).select(columns).order("created_at", { ascending: true }).range(from, from + 999);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function emailsFor(ids: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await supabaseAdmin.from("users").select("id, email").in("id", ids.slice(i, i + 200));
    if (error) throw new Error(`users: ${error.message}`);
    for (const u of data ?? []) map.set(u.id, u.email ?? "(no email)");
  }
  return map;
}

async function placeholderExists(): Promise<boolean> {
  const { data, error } = await supabaseAdmin.storage.from(RIDER_DOCS_BUCKET).exists(PLACEHOLDER);
  if (error) return false;
  return !!data;
}

async function main() {
  console.log(`=== verify-all-accounts — ${APPLY ? "APPLY" : "DRY RUN"} ===\n`);

  // ── 1. Placeholder ──────────────────────────────────────────────
  const hadPlaceholder = await placeholderExists();
  console.log(`Placeholder ${RIDER_DOCS_BUCKET}/${PLACEHOLDER}: ${hadPlaceholder ? "exists" : "MISSING"}${
    !hadPlaceholder ? (APPLY ? " → uploading" : " → would upload") : ""}`);
  if (APPLY) {
    const { error } = await supabaseAdmin.storage
      .from(RIDER_DOCS_BUCKET)
      .upload(PLACEHOLDER, placeholderPng(), { upsert: true, contentType: "image/png" });
    if (error) throw new Error(`placeholder upload: ${error.message}`);
  }

  // ── 2. Riders ───────────────────────────────────────────────────
  const riders = await fetchAll("rider_profiles", "user_id, vehicle_type, documents, verification_status");
  const riderEmails = await emailsFor(riders.map((r) => r.user_id));
  const riderUpdates: { user_id: string; documents: Row; verification_status: string }[] = [];
  console.log(`\n--- Riders (${riders.length} profiles) ---`);
  let inPlace = 0, placeholdered = 0;
  for (const r of riders) {
    const docs: Row = { ...(r.documents ?? {}) };
    const verifiedInPlace: string[] = [];
    const given: string[] = [];
    for (const key of requiredDocumentKeys(r.vehicle_type)) {
      const cur = docs[key] as RiderStoredDocument | undefined;
      if (cur?.path) {
        if (cur.status === "verified" && !cur.note) continue;
        docs[key] = { ...cur, status: "verified", note: null, reviewed_at: now };
        verifiedInPlace.push(key);
      } else {
        docs[key] = { path: PLACEHOLDER, status: "verified", note: null, uploaded_at: now, reviewed_at: now };
        given.push(key);
      }
    }
    if (!verifiedInPlace.length && !given.length && r.verification_status === "approved") continue;
    riderUpdates.push({ user_id: r.user_id, documents: docs, verification_status: "approved" });
    inPlace += verifiedInPlace.length;
    placeholdered += given.length;
    console.log(
      `${riderEmails.get(r.user_id)} [${r.vehicle_type ?? "no type"}]: ${r.verification_status} → approved; ` +
        `verified in place: ${verifiedInPlace.join(", ") || "-"}; placeholder: ${given.join(", ") || "-"}`
    );
  }

  // ── 3. Agents ───────────────────────────────────────────────────
  const agents = await fetchAll("agent_profiles", "user_id, documents");
  const shops = await fetchAll("agent_shops", "id, user_id, shop_name, review_status");
  const agentEmails = await emailsFor([...new Set([...agents.map((a) => a.user_id), ...shops.map((s) => s.user_id)])]);
  const agentUpdates: { user_id: string; documents: Row }[] = [];
  console.log(`\n--- Agents (${agents.length} profiles, ${shops.length} shops) ---`);
  let agentDocChanges = 0, agentsMissing = 0;
  for (const a of agents) {
    const docs: Row = { ...(a.documents ?? {}) };
    const changed: string[] = [];
    const missing: string[] = [];
    for (const key of AGENT_DOC_KEYS) {
      const cur = docs[key];
      if (!cur || typeof cur !== "object" || !cur.url) { missing.push(key); continue; }
      if (cur.status === "verified") continue;
      docs[key] = { ...cur, status: "verified", reason: null };
      changed.push(`${key} ${cur.status ?? "none"} → verified`);
    }
    if (missing.length) agentsMissing++;
    if (!changed.length) continue;
    agentUpdates.push({ user_id: a.user_id, documents: docs });
    agentDocChanges += changed.length;
    console.log(`${agentEmails.get(a.user_id)}: ${changed.join("; ")}${missing.length ? ` (missing, untouched: ${missing.join(", ")})` : ""}`);
  }
  const shopUpdates = shops.filter((s) => s.review_status === "under_review");
  for (const s of shopUpdates) {
    console.log(`${agentEmails.get(s.user_id)}: shop "${s.shop_name}" under_review → active`);
  }

  // ── 4. Names ────────────────────────────────────────────────────
  const users = await fetchAll("users", "id, email, first_name, last_name");
  const nameUpdates: { id: string; first_name: string; last_name: string }[] = [];
  const singleWord: string[] = [];
  console.log(`\n--- Names ---`);
  for (const u of users) {
    if (u.last_name && String(u.last_name).trim()) continue;
    const first = String(u.first_name ?? "").trim();
    if (!first) continue;
    const parts = first.split(/\s+/);
    if (parts.length < 2) { singleWord.push(`${u.email ?? u.id}: "${first}"`); continue; }
    const [fn, ...rest] = parts;
    nameUpdates.push({ id: u.id, first_name: fn, last_name: rest.join(" ") });
    console.log(`${u.email ?? u.id}: "${u.first_name}" / "${u.last_name ?? ""}" → "${fn}" / "${rest.join(" ")}"`);
  }
  if (singleWord.length) {
    console.log(`Skipped single-word names (${singleWord.length}):`);
    for (const s of singleWord) console.log(`  ${s}`);
  }

  // ── Apply ───────────────────────────────────────────────────────
  if (APPLY) {
    for (const u of riderUpdates) {
      const { error } = await supabaseAdmin.from("rider_profiles").update({ documents: u.documents, verification_status: u.verification_status }).eq("user_id", u.user_id);
      if (error) throw new Error(`rider_profiles ${u.user_id}: ${error.message}`);
    }
    for (const u of agentUpdates) {
      const { error } = await supabaseAdmin.from("agent_profiles").update({ documents: u.documents }).eq("user_id", u.user_id);
      if (error) throw new Error(`agent_profiles ${u.user_id}: ${error.message}`);
    }
    for (const s of shopUpdates) {
      const { error } = await supabaseAdmin.from("agent_shops").update({ review_status: "active" }).eq("id", s.id);
      if (error) throw new Error(`agent_shops ${s.id}: ${error.message}`);
    }
    for (const n of nameUpdates) {
      const { error } = await supabaseAdmin.from("users").update({ first_name: n.first_name, last_name: n.last_name }).eq("id", n.id);
      if (error) throw new Error(`users ${n.id}: ${error.message}`);
    }
  }

  console.log(`\n=== Summary (${APPLY ? "APPLIED" : "dry run — nothing written"}) ===`);
  console.log(`placeholder file: ${hadPlaceholder ? "already present" : "to be uploaded"}${APPLY ? " (upserted)" : ""}`);
  console.log(`riders: ${riderUpdates.length}/${riders.length} rows change; ${inPlace} docs verified in place, ${placeholdered} docs given placeholder`);
  console.log(`agents: ${agentUpdates.length}/${agents.length} profiles change (${agentDocChanges} docs); ${shopUpdates.length}/${shops.length} shops → active; ${agentsMissing} agents with missing commercial-register docs (left as is)`);
  console.log(`names: ${nameUpdates.length} to split; ${singleWord.length} single-word skipped`);
}

main().catch((e) => {
  console.error("FAILED:", e instanceof Error ? e.message : "unknown error");
  process.exit(1);
});
