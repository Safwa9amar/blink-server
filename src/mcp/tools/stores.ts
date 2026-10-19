import { z } from "zod";
import { supabaseAdmin } from "../../lib/supabase";
import { sanitizeSearch } from "../../lib/mcp-util";
import { defineTool } from "../registry";
import { limitField, listResult, must, offsetField, page, uuidField } from "./_shared";

const ROLES = ["ops_admin", "commerce_admin"] as const;
const STORE_LIST_COLS =
  "id, owner_id, name, status, is_open, rating, review_count, city, wilaya, category_slugs, is_supermarket, is_featured, review_note, created_at, updated_at";
const STORE_DETAIL_COLS = `${STORE_LIST_COLS}, description, location, latitude, longitude, opening_hours, hours, delivery_fee, delivery_time, min_order, is_primary, manual_override, weekly_goal, document_review, documents`;

export const listStores = defineTool({
  name: "list_stores",
  title: "List merchant stores",
  description:
    "List merchant stores (read-only), newest first. Status: active | inactive | under_review (under_review = awaiting staff approval; review_note holds the staff rejection/deactivation reason). " +
    "Filters: status, owner_id (merchant user id), is_open, q (name contains). Returns items + total/next_offset.",
  roles: [...ROLES],
  input: {
    status: z.enum(["active", "inactive", "under_review"]).optional(),
    owner_id: uuidField("Merchant user id").optional(),
    is_open: z.boolean().optional(),
    q: z.string().max(80).optional().describe("Store name contains"),
    limit: limitField,
    offset: offsetField,
  },
  handler: async (a) => {
    const { offset, from, to } = page(a);
    let q = supabaseAdmin.from("stores").select(STORE_LIST_COLS, { count: "exact" });
    if (a.status) q = q.eq("status", a.status);
    if (a.owner_id) q = q.eq("owner_id", a.owner_id);
    if (a.is_open !== undefined) q = q.eq("is_open", a.is_open);
    if (a.q && sanitizeSearch(a.q)) q = q.ilike("name", `%${sanitizeSearch(a.q)}%`);
    const { data, count } = must(await q.order("created_at", { ascending: false }).range(from, to));
    const items = data as unknown as Record<string, unknown>[];
    return { data: listResult(items, count, offset), rowCount: items.length };
  },
});

export const getStore = defineTool({
  name: "get_store",
  title: "Get store",
  description:
    "One merchant store by id (read-only): profile, location, opening hours, delivery fee / min order (DZD), review state, per-document staff verdicts and which documents were uploaded (file URLs are not returned), " +
    "owner name, product counts (total / pending review) and order counts (total / delivered).",
  roles: [...ROLES],
  input: { store_id: uuidField("Store id") },
  handler: async ({ store_id }) => {
    const { data } = must(await supabaseAdmin.from("stores").select(STORE_DETAIL_COLS).eq("id", store_id).maybeSingle());
    if (!data) throw new Error("Store not found");
    const { documents, ...store } = data as unknown as Record<string, unknown> & {
      documents: Record<string, unknown> | null;
      owner_id: string | null;
    };
    const head = { count: "exact" as const, head: true };
    const [owner, products, pending, orders, delivered] = await Promise.all([
      store.owner_id
        ? supabaseAdmin.from("users").select("id, first_name, last_name").eq("id", store.owner_id as string).maybeSingle()
        : Promise.resolve({ data: null }),
      supabaseAdmin.from("store_products").select("id", head).eq("store_id", store_id),
      supabaseAdmin.from("store_products").select("id", head).eq("store_id", store_id).neq("review_status", "approved"),
      supabaseAdmin.from("orders").select("id", head).eq("store_id", store_id),
      supabaseAdmin.from("orders").select("id", head).eq("store_id", store_id).eq("status", "delivered"),
    ]);
    return {
      data: {
        store: { ...store, documents_uploaded: Object.entries(documents ?? {}).filter(([, v]) => !!v).map(([k]) => k) },
        owner: owner.data ?? null,
        products: { total: products.count ?? 0, not_approved: pending.count ?? 0 },
        orders: { total: orders.count ?? 0, delivered: delivered.count ?? 0 },
      },
      rowCount: 1,
    };
  },
});
