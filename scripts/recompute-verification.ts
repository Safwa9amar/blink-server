// scripts/recompute-verification.ts — one-off admin script (undoes verify-all-accounts).
//   npm run verify:strict            → DRY RUN (default): reads, prints the report, writes nothing
//   npm run verify:strict -- --apply → performs exactly what the dry run printed
//
// An account is verified only with every required REAL document verified AND complete details.
// 1. Undo: drop placeholder documents; "verified" docs with no reviewed_by go back to pending;
//    dev.agent@blink.dev commercial-register docs go back to pending.
// 2. Strict rider status; riders leaving "approved" go offline and release requests/booked jobs
//    (same as the staff de-approval path). No notifications are sent here.
// 3. Apply only: delete the placeholder file once nothing references it.
import "dotenv/config";
import { supabaseAdmin } from "../src/lib/supabase";
import { requiredDocumentKeys, type RiderVerificationStatus } from "../src/lib/rider-verification";
import { RIDER_DOCS_BUCKET } from "../src/routes/riders/verification-shared";
import { releaseRiderRequests, IN_DELIVERY } from "../src/lib/dispatch";
import { releaseBookedJobs } from "../src/lib/rider-release";
import { bookedJobs } from "../src/lib/rider-release-rules";
import { heldSinceIso } from "../src/lib/rider-offer";

const APPLY = process.argv.includes("--apply");
const PLACEHOLDER = "_placeholder/verified-document.png";
const AGENT_EMAIL = "dev.agent@blink.dev";
const AGENT_DOC_KEYS = ["commercial_register_front", "commercial_register_back"] as const;

type Row = Record<string, any>;
const filled = (v: unknown) => typeof v === "string" && v.trim() !== "";

async function fetchAll(table: string, columns: string): Promise<Row[]> {
  const out: Row[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabaseAdmin.from(table).select(columns).order("created_at", { ascending: true }).range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...((data ?? []) as unknown as Row[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function byIds(table: string, columns: string, col: string, ids: string[]): Promise<Row[]> {
  const out: Row[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await supabaseAdmin.from(table).select(columns).in(col, ids.slice(i, i + 200));
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...((data ?? []) as unknown as Row[]));
  }
  return out;
}

async function jobCounts(riderId: string): Promise<{ requests: number; booked: number }> {
  const { count, error } = await supabaseAdmin
    .from("orders")
    .select("id", { count: "exact", head: true })
    .eq("offered_rider_id", riderId)
    .is("rider_id", null)
    .eq("status", "searching")
    .is("offer_declined_at", null)
    .gt("offered_at", heldSinceIso(Date.now()));
  if (error) throw new Error(`orders: ${error.message}`);
  const { data, error: e2 } = await supabaseAdmin
    .from("orders")
    .select("id, status, checkout_id")
    .eq("rider_id", riderId)
    .in("status", ["searching", ...IN_DELIVERY]);
  if (e2) throw new Error(`orders: ${e2.message}`);
  const { singles, checkouts } = bookedJobs(data ?? []);
  return { requests: count ?? 0, booked: singles.length + checkouts.length };
}

async function main() {
  console.log(`=== recompute-verification — ${APPLY ? "APPLY" : "DRY RUN"} ===\n`);

  const riders = await fetchAll("rider_profiles", "user_id, vehicle_type, documents, verification_status, is_available");
  const ids = riders.map((r) => r.user_id as string);
  const users = new Map((await byIds("users", "id, email, first_name, last_name, phone_number", "id", ids)).map((u) => [u.id, u]));
  const vehicles = new Map((await byIds("vehicles", "user_id, brand, model, license_plate", "user_id", ids)).map((v) => [v.user_id, v]));

  type Plan = { user_id: string; documents: Row; status: RiderVerificationStatus; offline: boolean };
  const plans: Plan[] = [];
  const releases: { user_id: string; email: string }[] = [];
  const tally: Record<string, number> = {};
  let placeholdersRemoved = 0, unreviewedReverted = 0, availOff = 0, stillRefs = 0;

  console.log(`--- Riders (${riders.length} profiles) ---`);
  for (const r of riders) {
    const u = users.get(r.user_id) ?? {};
    const email = u.email ?? "(no email)";
    const docs: Row = {};
    const notes: string[] = [];
    for (const [k, d] of Object.entries((r.documents ?? {}) as Row)) {
      if (!d || typeof d !== "object") continue;
      if (d.path === PLACEHOLDER) { placeholdersRemoved++; notes.push(`${k}: placeholder removed`); continue; }
      let doc = d;
      if (d.status === "verified" && !d.reviewed_by) {
        const { reviewed_at: _drop, ...rest } = d;
        doc = { ...rest, status: "pending" };
        unreviewedReverted++;
        notes.push(`${k}: verified (no reviewer) → pending`);
      }
      docs[k] = doc;
    }

    const required = requiredDocumentKeys(r.vehicle_type);
    const real = required.filter((k) => docs[k]?.path);
    const missingDocs = required.filter((k) => !docs[k]?.path);
    const missingDetails: string[] = [];
    if (!r.vehicle_type) missingDetails.push("vehicle_type");
    if (!filled(u.first_name)) missingDetails.push("first_name");
    if (!filled(u.last_name)) missingDetails.push("last_name");
    if (!filled(u.phone_number)) missingDetails.push("phone_number");
    if (r.vehicle_type !== "bicycle") {
      const v = vehicles.get(r.user_id);
      if (!v) missingDetails.push("vehicle");
      else for (const f of ["brand", "model", "license_plate"]) if (!filled(v[f])) missingDetails.push(`vehicle.${f}`);
    }

    let status: RiderVerificationStatus;
    if (real.some((k) => docs[k].status === "rejected")) status = "rejected";
    else if (!missingDocs.length && real.every((k) => docs[k].status === "verified") && !missingDetails.length) status = "approved";
    else if (!missingDocs.length) status = "pending";
    else status = "not_submitted";

    const deapproved = r.verification_status === "approved" && status !== "approved";
    const offline = status !== "approved" && r.is_available === true;
    const after = status !== "approved" ? false : r.is_available;
    if (offline) availOff++;
    let jobs = "-";
    if (deapproved) {
      const c = await jobCounts(r.user_id);
      jobs = `release ${c.requests} requests, ${c.booked} booked jobs`;
      releases.push({ user_id: r.user_id, email });
    }
    tally[status] = (tally[status] ?? 0) + 1;
    for (const d of Object.values(docs)) if (d.path === PLACEHOLDER) stillRefs++;

    const changed = status !== r.verification_status || notes.length || offline;
    if (changed) plans.push({ user_id: r.user_id, documents: docs, status, offline });
    console.log(
      `${email} [${r.vehicle_type ?? "no type"}]: ${r.verification_status} → ${status}; ` +
        `missing real docs: ${missingDocs.join(", ") || "-"}; missing details: ${missingDetails.join(", ") || "-"}; ` +
        `is_available ${r.is_available} → ${after}; jobs: ${jobs}` +
        (notes.length ? `; doc changes: ${notes.join("; ")}` : "")
    );
  }

  // ── Agent doc revert ────────────────────────────────────────────
  console.log(`\n--- Agent doc revert (${AGENT_EMAIL}) ---`);
  let agentUpdate: { user_id: string; documents: Row } | null = null;
  const { data: au, error: aue } = await supabaseAdmin.from("users").select("id").eq("email", AGENT_EMAIL).maybeSingle();
  if (aue) throw new Error(`users: ${aue.message}`);
  if (!au) console.log("user not found — nothing to do");
  else {
    const { data: ap, error: ape } = await supabaseAdmin.from("agent_profiles").select("user_id, documents").eq("user_id", au.id).maybeSingle();
    if (ape) throw new Error(`agent_profiles: ${ape.message}`);
    const docs: Row = { ...(ap?.documents ?? {}) };
    const ch: string[] = [];
    for (const k of AGENT_DOC_KEYS) {
      const cur = docs[k];
      if (!cur || typeof cur !== "object" || !cur.url) continue;
      if (cur.status === "pending" && cur.reason == null) continue;
      docs[k] = { ...cur, status: "pending", reason: null };
      ch.push(`${k} ${cur.status ?? "none"} → pending`);
    }
    if (ch.length) { agentUpdate = { user_id: au.id, documents: docs }; console.log(ch.join("; ")); }
    else console.log("nothing to change");
  }

  // ── Placeholder deletion ────────────────────────────────────────
  const { data: exists } = await supabaseAdmin.storage.from(RIDER_DOCS_BUCKET).exists(PLACEHOLDER);
  const deletePlaceholder = !!exists && stillRefs === 0;
  console.log(`\n--- Placeholder ---\n${RIDER_DOCS_BUCKET}/${PLACEHOLDER}: ${exists ? "exists" : "not present"}; ` +
    `${stillRefs} document(s) would still reference it → ${deletePlaceholder ? (APPLY ? "deleting" : "would delete") : "no deletion"}`);

  // ── Apply ───────────────────────────────────────────────────────
  if (APPLY) {
    for (const p of plans) {
      const patch: Row = { documents: p.documents, verification_status: p.status };
      if (p.offline) patch.is_available = false;
      const { error } = await supabaseAdmin.from("rider_profiles").update(patch).eq("user_id", p.user_id);
      if (error) throw new Error(`rider_profiles ${p.user_id}: ${error.message}`);
    }
    for (const rel of releases) {
      // Same as the staff de-approval path: offline, then release requests and booked jobs.
      await supabaseAdmin.from("rider_profiles").update({ is_available: false }).eq("user_id", rel.user_id);
      await releaseRiderRequests(rel.user_id).catch(() => {});
      await releaseBookedJobs(rel.user_id);
    }
    if (agentUpdate) {
      const { error } = await supabaseAdmin.from("agent_profiles").update({ documents: agentUpdate.documents }).eq("user_id", agentUpdate.user_id);
      if (error) throw new Error(`agent_profiles: ${error.message}`);
    }
    if (deletePlaceholder) {
      const { error } = await supabaseAdmin.storage.from(RIDER_DOCS_BUCKET).remove([PLACEHOLDER]);
      if (error) throw new Error(`placeholder delete: ${error.message}`);
    }
  }

  console.log(`\n=== Summary (${APPLY ? "APPLIED" : "dry run — nothing written"}) ===`);
  console.log(`riders: ${plans.length}/${riders.length} rows change; final: ${Object.entries(tally).map(([k, v]) => `${k}=${v}`).join(", ")}`);
  console.log(`docs: ${placeholdersRemoved} placeholder entries removed, ${unreviewedReverted} unreviewed verified → pending`);
  console.log(`de-approved riders (released): ${releases.length}; set offline: ${availOff}`);
  console.log(`agent doc revert: ${agentUpdate ? "yes" : "no"}; placeholder file deletion: ${deletePlaceholder ? "yes" : "no"}`);
}

main().catch((e) => {
  console.error("FAILED:", e instanceof Error ? e.message : "unknown error");
  process.exit(1);
});
