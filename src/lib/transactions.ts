// Transaction helpers shared by the /transactions routes.
import { supabaseAdmin } from "./supabase";

type Row = Record<string, any>;

/**
 * Embed the rider's identity (`rider`) on each transaction so the agent app
 * can show who it is serving — name, phone, avatar and the BK-RR display ID.
 * Two batched reads regardless of how many rows.
 */
export async function withRiders<T extends Row>(rows: T[]): Promise<(T & { rider?: Row })[]> {
  const ids = [...new Set(rows.map((r) => r.rider_id ?? r.user_id).filter(Boolean))];
  if (!ids.length) return rows;
  const [{ data: users }, { data: profiles }] = await Promise.all([
    supabaseAdmin
      .from("users")
      .select("id, first_name, last_name, phone_number, profile_picture")
      .in("id", ids),
    supabaseAdmin.from("rider_profiles").select("user_id, rider_id").in("user_id", ids),
  ]);
  const userBy = new Map((users ?? []).map((u) => [u.id, u]));
  const codeBy = new Map((profiles ?? []).map((p) => [p.user_id, p.rider_id]));
  return rows.map((r) => {
    const id = r.rider_id ?? r.user_id;
    const u = userBy.get(id);
    if (!u) return r;
    const name = [u.first_name, u.last_name].filter(Boolean).join(" ").trim();
    return {
      ...r,
      rider: {
        id,
        name: name || null,
        phone_number: u.phone_number ?? null,
        profile_picture: u.profile_picture ?? null,
        display_id: codeBy.get(id) ?? null,
      },
    };
  });
}

export async function withRider<T extends Row>(row: T) {
  const [out] = await withRiders([row]);
  return out;
}
