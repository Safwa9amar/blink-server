// A merchant's own driver for a checkout made only of its stores (rules:
// src/lib/bundle.ts canAssignOwnDriver + checkout-siblings.ts
// ownsWholeCheckout). Every write covers EVERY member in one conditional
// update with a member-count guard, like the rider's bundle claim.
import { bundleMembers, type BundleRow } from "../../lib/bundle";
import { CLEAR_OFFER } from "../../lib/rider-offer";
import { supabaseAdmin } from "../../lib/supabase";

export interface OwnCheckout {
  members: BundleRow[];
  /** Every member's store is `ownerId`'s. */
  ownOnly: boolean;
  /** The members' stores. */
  storeIds: string[];
}

/** The checkout's live members and whether every one is in `ownerId`'s stores. */
export async function loadOwnCheckout(checkoutId: string, ownerId: string): Promise<OwnCheckout> {
  const { data } = await supabaseAdmin
    .from("orders")
    .select("*, store:stores(owner_id)")
    .eq("checkout_id", checkoutId);
  const members = bundleMembers(data ?? []);
  // A non-`*` embed is typed as an array but is an object at runtime (many-to-one).
  const owners = members.map((m) => (m.store as { owner_id?: string | null } | null)?.owner_id ?? null);
  return {
    members,
    ownOnly: members.length > 0 && owners.every((o) => o === ownerId),
    storeIds: [...new Set(members.map((m) => m.store_id as string).filter(Boolean))],
  };
}

/** `offered_at = value`, or IS NULL when it was read as null. */
const sameOfferedAt = <Q extends { filter(column: string, operator: "eq" | "is", value: unknown): Q }>(
  q: Q,
  value: unknown
) => (value == null ? q.filter("offered_at", "is", null) : q.filter("offered_at", "eq", value));

const idsOf = (members: BundleRow[]) => members.map((m) => m.id as string);

/**
 * Patch every member, only while each is still as read (no rider, searching,
 * accepted / ready, the request as read). False = a member moved meanwhile;
 * the members already written are reverted with `undo`.
 */
async function writeAll(members: BundleRow[], patch: Record<string, unknown>, undo: Record<string, unknown>) {
  const q = supabaseAdmin
    .from("orders")
    .update(patch)
    .in("id", idsOf(members))
    .is("rider_id", null)
    .eq("status", "searching")
    .in("merchant_status", ["accepted", "ready"]);
  const { data } = await sameOfferedAt(q, members[0].offered_at).select("id");
  const written = (data ?? []).map((r) => r.id as string);
  if (written.length === members.length) return true;
  if (written.length) await supabaseAdmin.from("orders").update(undo).in("id", written);
  return false;
}

/** A driver without the app: every member is theirs now (heading to the stores). */
export function assignExternalDriver(members: BundleRow[], driverId: string, nowIso: string) {
  return writeAll(
    members,
    {
      delivery_mode: "own",
      store_driver_id: driverId,
      status: "heading_to_store",
      rider_assigned_at: nowIso,
      ...CLEAR_OFFER,
    },
    { delivery_mode: null, store_driver_id: null, status: "searching", rider_assigned_at: null }
  );
}

/** A driver with the app: one request (one shared offered_at) on every member. */
export function requestDriver(members: BundleRow[], riderId: string, driverId: string, nowIso: string) {
  return writeAll(
    members,
    {
      offered_rider_id: riderId,
      offered_driver_id: driverId,
      offered_mode: "own",
      offered_at: nowIso,
      offer_declined_at: null,
    },
    CLEAR_OFFER
  );
}

/** End this request on every member that still carries it (declined / withdrawn). */
export async function endRequest(
  checkoutId: string,
  riderId: string,
  offeredAt: string,
  patch: Record<string, unknown>
) {
  const { data } = await supabaseAdmin
    .from("orders")
    .update(patch)
    .eq("checkout_id", checkoutId)
    .eq("offered_rider_id", riderId)
    .eq("offered_at", offeredAt)
    .is("rider_id", null)
    .eq("status", "searching")
    .select("*");
  return data ?? [];
}
