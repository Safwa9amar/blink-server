// Rider challenge progress + settlement. Progress is derived from the rider's
// trips (completed / canceled) inside the challenge window, counted from when
// they joined. A joined challenge is settled lazily on read: won as soon as the
// target is reached (reward credited — counted by riderWallet), lost when the
// cancellation limit is exceeded or it ends short of the target.
import { supabaseAdmin } from "./supabase";
import { postChallengeReward } from "./wallet";

type Row = Record<string, any>;
const NEW_FOR_MS = 7 * 24 * 60 * 60 * 1000;
/** Challenge hour windows are Algeria local time (UTC+1, no DST). */
const LOCAL_OFFSET_H = 1;

const localHour = (iso: string) => (new Date(iso).getUTCHours() + LOCAL_OFFSET_H) % 24;

function inWindow(c: Row, iso: string) {
  if (c.hour_from == null || c.hour_to == null) return true;
  const h = localHour(iso);
  return c.hour_from <= c.hour_to ? h >= c.hour_from && h < c.hour_to : h >= c.hour_from || h < c.hour_to;
}

/** Challenges for a rider (active ones + any they took part in), settled. */
export async function riderChallenges(riderId: string, onlyId?: string) {
  const nowIso = new Date().toISOString();
  let q = supabaseAdmin.from("rider_challenges").select("*").eq("is_active", true);
  if (onlyId) q = q.eq("id", onlyId);
  const [{ data: challenges }, { data: parts }] = await Promise.all([
    q.order("ends_at", { ascending: true }),
    supabaseAdmin.from("rider_challenge_participants").select("*").eq("rider_id", riderId),
  ]);
  const partBy = new Map((parts ?? []).map((p) => [p.challenge_id, p]));
  const joined = (challenges ?? []).filter((c) => partBy.get(c.id));

  // One trips read covering every joined window.
  let trips: Row[] = [];
  if (joined.length) {
    const from = joined
      .map((c) => [c.starts_at, partBy.get(c.id)!.joined_at].sort().pop()!)
      .sort()[0];
    const { data } = await supabaseAdmin
      .from("trips")
      .select("status, created_at")
      .eq("rider_id", riderId)
      .in("status", ["completed", "canceled"])
      .gte("created_at", from);
    trips = data ?? [];
  }

  const out = [];
  for (const c of challenges ?? []) {
    const p = partBy.get(c.id);
    const ended = c.ends_at <= nowIso;
    if (!p && ended) continue; // missed challenges aren't shown

    let progress = 0;
    let cancellations = 0;
    if (p) {
      const since = [c.starts_at, p.joined_at].sort().pop()!;
      for (const t of trips) {
        if (t.created_at < since || t.created_at >= c.ends_at || !inWindow(c, t.created_at)) continue;
        if (t.status === "completed") progress++;
        else cancellations++;
      }
    }

    let status: "available" | "ongoing" | "won" | "lost" | "gave_up" = p ? "ongoing" : "available";
    if (p && p.status !== "joined") {
      status = p.status;
    } else if (p) {
      const overLimit = c.max_cancellations != null && cancellations > c.max_cancellations;
      const next = progress >= c.target_trips && !overLimit ? "won" : overLimit || ended ? "lost" : null;
      if (next) {
        // Settle once (conditional on still `joined` so a reward is never doubled).
        const { data: settled } = await supabaseAdmin
          .from("rider_challenge_participants")
          .update({
            status: next,
            settled_at: nowIso,
            reward_amount: next === "won" ? c.reward_amount : null,
          })
          .eq("challenge_id", c.id)
          .eq("rider_id", riderId)
          .eq("status", "joined")
          .select("rider_id");
        // The reward goes to the Blink Cash ledger once, when this call is the one that settled it.
        if (next === "won" && settled?.length) await postChallengeReward(c.id, riderId, Number(c.reward_amount));
        status = next;
      }
    }

    out.push({
      id: c.id,
      title: c.title,
      image_url: c.image_url ?? null,
      rules: c.rules,
      reward_amount: Number(c.reward_amount),
      status,
      is_new: !p && Date.now() - new Date(c.created_at).getTime() < NEW_FOR_MS,
      starts_at: c.starts_at,
      ends_at: c.ends_at,
      progress_current: Math.min(progress, c.target_trips),
      progress_target: c.target_trips,
      cancellations,
      max_cancellations: c.max_cancellations ?? null,
    });
  }
  return out;
}
