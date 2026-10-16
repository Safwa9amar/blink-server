// Helpers shared by the staff Blink Cash routes (admin-*.ts).
import type { UserRole } from "../../db";
import { mapWalletError } from "../../lib/blink-cash-admin";
import type { BlinkCashCopy } from "../../lib/blink-cash-copy";
import { createNotification } from "../../lib/notifications";
import { supabaseAdmin } from "../../lib/supabase";
import { requireStaffRole } from "../../middleware/staff-roles";

/** Same roles as the dashboard's /blink-cash (super_admin always passes). */
export const staff = requireStaffRole("finance_admin");

export type UserLite = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  phone_number: string | null;
  email: string | null;
};

export const nameOf = (u?: UserLite) =>
  u ? [u.first_name, u.last_name].filter(Boolean).join(" ").trim() || null : null;

export async function usersById(ids: string[]) {
  const map = new Map<string, UserLite>();
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += 100) {
    const { data, error } = await supabaseAdmin
      .from("users")
      .select("id, first_name, last_name, phone_number, email")
      .in("id", unique.slice(i, i + 100));
    if (error) throw new Error(`[blink-cash-admin] users read failed: ${error.message}`);
    for (const u of (data ?? []) as UserLite[]) map.set(u.id, u);
  }
  return map;
}

export type RpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: 404 | 409; body: { error: string; code: string } };

/** Call a ledger SQL function; known business errors become a 404 / 409 body, anything else throws. */
export async function callRpc<T = unknown>(fn: string, args: Record<string, unknown>): Promise<RpcResult<T>> {
  const { data, error } = await supabaseAdmin.rpc(fn, args);
  if (error) {
    const mapped = mapWalletError(error);
    if (mapped) return { ok: false, ...mapped };
    throw new Error(`[blink-cash-admin] ${fn} failed: ${error.message}`);
  }
  return { ok: true, data: data as T };
}

/** A user-facing push + in-app notification; never fails the action it reports. */
export async function notifyUser(opts: {
  userId: string;
  role: UserRole;
  copy: BlinkCashCopy;
  href: string;
  payload?: Record<string, unknown>;
  createdBy?: string | null;
}) {
  try {
    await createNotification({
      userId: opts.userId,
      role: opts.role,
      type: "alert",
      title: opts.copy.en.title,
      description: opts.copy.en.description,
      contentEng: opts.copy.en,
      contentFr: opts.copy.fr,
      contentAr: opts.copy.ar,
      href: opts.href,
      payload: opts.payload ?? null,
      createdBy: opts.createdBy ?? null,
    });
  } catch (e) {
    console.error("[blink-cash-admin] notification failed:", e);
  }
}

export const RIDER_BLINK_CASH_HREF = "/(rider)/blink-cash";
export const PAGE_SIZE = 50;

/** Escape `%`, `_` and PostgREST list separators out of a user search term. */
export const searchTerm = (q: string) => q.replace(/[%_,()\\]/g, " ").trim();
