import { z } from "zod";
import { supabaseAdmin } from "../../lib/supabase";
import { maskRib, sanitizeSearch } from "../../lib/mcp-util";
import { defineTool } from "../registry";
import { limitField, listResult, must, offsetField, page, uuidField } from "./_shared";

const USER_LIST_COLS =
  "id, first_name, last_name, middle_name, role, granted_roles, staff_role, phone_number, email, wilaya, created_at";
const USER_DETAIL_COLS = `${USER_LIST_COLS}, gender, birthday, address, wilaya_code, updated_at`;

const PROFILE_TABLE: Record<string, { table: string; col: string }> = {
  "BK-CU-": { table: "customer_profiles", col: "customer_id" },
  "BK-RR-": { table: "rider_profiles", col: "rider_id" },
  "BK-MR-": { table: "merchant_profiles", col: "merchant_id" },
  "BK-AG-": { table: "agent_profiles", col: "agent_id" },
};

export const findUsers = defineTool({
  name: "find_users",
  title: "Find users",
  description:
    "Find app users (read-only). `query`: Blink id (BK-RR-/BK-CU-/BK-MR-/BK-AG-…), email, phone (any format), uuid, or name words (all must match). Optional `role` (active or granted). Returns id, names, roles, staff_role, phone, email, wilaya. Pass the id to get_user, list_orders, get_wallet…",
  input: {
    query: z.string().min(1).max(80).describe("Name, phone, email, uuid or BK-xx-###### id."),
    role: z.enum(["customer", "rider", "merchant", "agent"]).optional().describe("Only users who have this app role."),
    limit: limitField,
    offset: offsetField,
  },
  handler: async (args) => {
    const { offset, from, to } = page(args);
    const raw = args.query.trim();
    let q = supabaseAdmin.from("users").select(USER_LIST_COLS, { count: "exact" });

    const prefix = raw.slice(0, 6).toUpperCase();
    if (PROFILE_TABLE[prefix]) {
      const { table, col } = PROFILE_TABLE[prefix];
      const { data } = must(
        await supabaseAdmin.from(table).select("user_id").ilike(col, `${sanitizeSearch(raw)}%`).limit(50)
      );
      const ids = (data as unknown as { user_id: string }[]).map((r) => r.user_id);
      if (!ids.length) return { data: listResult([], 0, offset), rowCount: 0 };
      q = q.in("id", ids);
    } else if (z.string().uuid().safeParse(raw).success) {
      q = q.eq("id", raw);
    } else if (raw.includes("@")) {
      q = q.ilike("email", `%${sanitizeSearch(raw)}%`);
    } else if (/^[+\d][\d\s().-]{4,}$/.test(raw)) {
      const digits = raw.replace(/\D/g, "").replace(/^(00)?213/, "").replace(/^0+/, "");
      q = q.ilike("phone_number", `%${digits}%`);
    } else {
      const words = sanitizeSearch(raw).split(" ").filter(Boolean);
      if (!words.length) throw new Error("query is empty after removing special characters");
      for (const w of words) {
        q = q.or(`first_name.ilike.%${w}%,last_name.ilike.%${w}%,middle_name.ilike.%${w}%`);
      }
    }
    if (args.role) q = q.contains("granted_roles", [args.role]);

    const { data, count } = must(await q.order("created_at", { ascending: false }).range(from, to));
    const items = data as unknown as Record<string, unknown>[];
    return { data: listResult(items, count, offset), rowCount: items.length };
  },
});

export const getUser = defineTool({
  name: "get_user",
  title: "Get user",
  description:
    "One user by id (read-only): identity, phone/email, roles, staff_role, RIB last 4, and each role profile: rider (rider_id, vehicle, verification, availability), merchant stores, agent shops, customer id. Never returns the PIN, tokens or document files.",
  input: { user_id: uuidField("User id (from find_users).") },
  handler: async ({ user_id }) => {
    const { data: u } = must(
      await supabaseAdmin
        .from("users")
        .select(`${USER_DETAIL_COLS}, bank_rib`)
        .eq("id", user_id)
        .maybeSingle()
    );
    if (!u) throw new Error("User not found");
    const { bank_rib, ...user } = u as unknown as Record<string, unknown> & { bank_rib: string | null };

    const [cust, rider, vehicle, merch, stores, agent, shops] = await Promise.all([
      supabaseAdmin.from("customer_profiles").select("customer_id").eq("user_id", user_id).maybeSingle(),
      supabaseAdmin
        .from("rider_profiles")
        .select("rider_id, vehicle_type, vehicle_class, verification_status, is_available, location_updated_at")
        .eq("user_id", user_id)
        .maybeSingle(),
      supabaseAdmin
        .from("vehicles")
        .select("brand, model, license_plate, year, color, category, gray_card_status, insurance_status, driving_license_status")
        .eq("user_id", user_id)
        .maybeSingle(),
      supabaseAdmin.from("merchant_profiles").select("merchant_id").eq("user_id", user_id).maybeSingle(),
      supabaseAdmin.from("stores").select("id, name, status, is_open").eq("owner_id", user_id).limit(20),
      supabaseAdmin.from("agent_profiles").select("agent_id").eq("user_id", user_id).maybeSingle(),
      supabaseAdmin.from("agent_shops").select("id, shop_name, status").eq("user_id", user_id).limit(20),
    ]);
    return {
      data: {
        user: { ...user, bank_rib_masked: maskRib(bank_rib) },
        customer_profile: cust.data ?? null,
        rider_profile: rider.data ?? null,
        vehicle: vehicle.data ?? null,
        merchant_profile: merch.data ?? null,
        stores: stores.data ?? [],
        agent_profile: agent.data ?? null,
        agent_shops: shops.data ?? [],
      },
      rowCount: 1,
    };
  },
});
