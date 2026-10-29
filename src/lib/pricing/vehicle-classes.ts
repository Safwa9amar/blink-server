// Vehicle classes (Bicycle / Moto / Moto Comfort …): staff-defined products a
// job is priced and matched by. Pure — no DB; index.ts loads the classes into
// the pricing snapshot. Spec: specs/2026-10-29-zone-pricing-design.md, Addendum 2.
//  - per-class fare legs resolve on top of resolveFrom (resolveClassLeg);
//  - canTake decides which riders a job class may be offered to.
import { LEG_SERVICE, legOf, PRICING_SEEDS, type LegKey } from "./catalog";
import type { FareLeg } from "./fare";
import { resolveFrom, type OverrideLike, type PricingContext } from "./resolve";

export type BaseVehicle = "bicycle" | "motorcycle";
export type ClassService = "ride" | "courier" | "store";
export const CLASS_SERVICES: readonly ClassService[] = ["ride", "courier", "store"];
export const BASE_VEHICLES: readonly BaseVehicle[] = ["bicycle", "motorcycle"];

export type VehicleClass = {
  code: string;
  names: { en: string; fr: string; ar: string };
  /** = rider_profiles.vehicle_type of the riders who can take it. */
  base_vehicle: BaseVehicle;
  services: ClassService[];
  /** Only riders OF this class take its jobs. */
  exclusive: boolean;
  enabled: boolean;
  sort_order: number;
  /** Archived classes stay in the list for matching open jobs, but are never quoted or priced. */
  archived?: boolean;
};

/** The classes the migration seeds (the runtime snapshot uses them when the DB is unreachable). */
export const VEHICLE_CLASS_SEEDS: VehicleClass[] = [
  { code: "bicycle", names: { en: "Bicycle", fr: "Vélo", ar: "دراجة" }, base_vehicle: "bicycle", services: ["courier", "store"], exclusive: false, enabled: true, sort_order: 1 },
  { code: "motorcycle", names: { en: "Moto", fr: "Moto", ar: "دراجة نارية" }, base_vehicle: "motorcycle", services: ["ride", "courier", "store"], exclusive: false, enabled: true, sort_order: 2 },
  // Disabled until the app can show it; staff enable it after the app update.
  { code: "motorcycle_comfort", names: { en: "Moto Comfort", fr: "Moto Confort", ar: "دراجة نارية مريحة" }, base_vehicle: "motorcycle", services: ["ride"], exclusive: true, enabled: false, sort_order: 3 },
];

/** Live classes serving `service`, in display order. `enabledOnly` = false includes disabled ones (staff views). */
export function classesFor(classes: readonly VehicleClass[], service: ClassService, enabledOnly = true): VehicleClass[] {
  return classes
    .filter((c) => !c.archived && c.services.includes(service) && (!enabledOnly || c.enabled))
    .sort((a, b) => a.sort_order - b.sort_order || a.code.localeCompare(b.code));
}

/** The default class of a base vehicle (a rider without an explicit class). */
export const defaultClassOf = (base: string | null | undefined): string | null =>
  base === "bicycle" || base === "motorcycle" ? base : null;

/** The class code a rider works as: the assigned one, else the default of their base vehicle. */
export function riderClassCode(rider: { vehicleType?: string | null; vehicleClass?: string | null }): string | null {
  return rider.vehicleClass ?? defaultClassOf(rider.vehicleType);
}

/**
 * Can a rider take a job of class `jobClass`? An exclusive class needs a rider
 * OF that class; otherwise a motorcycle-based class needs a motorcycle rider
 * and a bicycle-based one takes anyone. A null job class (a store order in
 * merchant mode, old rows) and any value no live class knows keep the legacy
 * rule: only `motorcycle` excludes bicycles. `strict` (rides) also refuses a
 * rider with an unknown vehicle, as rides always did.
 */
export function canTake(
  jobClass: string | null | undefined,
  rider: { vehicleType?: string | null; vehicleClass?: string | null },
  classes: readonly Pick<VehicleClass, "code" | "base_vehicle" | "exclusive">[],
  opts: { strict?: boolean } = {}
): boolean {
  if (jobClass == null) return !opts.strict || rider.vehicleType === "motorcycle";
  const cls = classes.find((c) => c.code === jobClass);
  const base = cls?.base_vehicle ?? (jobClass === "motorcycle" ? "motorcycle" : null);
  if (cls?.exclusive) return riderClassCode(rider) === cls.code;
  if (base === "motorcycle") return opts.strict ? rider.vehicleType === "motorcycle" : rider.vehicleType !== "bicycle";
  return true;
}

// ─── Per-class fare legs ─────────────────────────────────────────────

export type ClassLeg = {
  cls: Pick<VehicleClass, "code" | "names" | "base_vehicle">;
  leg: FareLeg;
  /** The override that supplied this leg (null = the default or the seed). */
  overrideId: string | null;
  source: "override" | "default" | "seed";
};

/**
 * The leg of class `code` for `key` in a context: the best-scoring active
 * matching override whose value HAS that class, else the default's, else the
 * seed's; null = the class has no price for this key. Non-leg fields
 * (extra_stop_fee, mode, min/max fee) are not part of this — they resolve as
 * before through resolveFrom.
 */
export function resolveClassLeg(
  defaults: Record<string, unknown>,
  overrides: OverrideLike[],
  key: LegKey,
  code: string,
  ctx: PricingContext
): { leg: FareLeg; overrideId: string | null; source: ClassLeg["source"] } | null {
  const holding = overrides.filter((o) => o.key !== key || legOf(o.value, code, key) != null);
  const r = resolveFrom<unknown>(defaults, holding, key, ctx);
  if (r.overrideId) {
    const leg = legOf(r.value, code, key);
    if (leg) return { leg, overrideId: r.overrideId, source: "override" };
  }
  const fromDefault = legOf(defaults[key], code, key);
  if (fromDefault) return { leg: fromDefault, overrideId: null, source: "default" };
  const fromSeed = legOf(PRICING_SEEDS[key], code, key);
  return fromSeed ? { leg: fromSeed, overrideId: null, source: "seed" } : null;
}

/** Every enabled class serving the key's service that has a price, in display order. */
export function resolveClassLegs(
  defaults: Record<string, unknown>,
  overrides: OverrideLike[],
  key: LegKey,
  classes: readonly VehicleClass[],
  ctx: PricingContext
): ClassLeg[] {
  const out: ClassLeg[] = [];
  for (const cls of classesFor(classes, LEG_SERVICE[key])) {
    const r = resolveClassLeg(defaults, overrides, key, cls.code, ctx);
    if (r) out.push({ cls, ...r });
  }
  return out;
}

/** A value's legs as ClassLegs for the given classes (callers that already hold one resolved value, e.g. the staff preview). */
export function legsFromValue(
  key: LegKey,
  value: unknown,
  classes: readonly VehicleClass[],
  opts: { enabledOnly?: boolean } = {}
): ClassLeg[] {
  const out: ClassLeg[] = [];
  for (const cls of classesFor(classes, LEG_SERVICE[key], opts.enabledOnly ?? true)) {
    const leg = legOf(value, cls.code, key);
    if (leg) out.push({ cls, leg, overrideId: null, source: "default" });
  }
  return out;
}

/** The legacy two-vehicle value ({bicycle, motorcycle, …}) as ClassLegs — for callers that pass `rates` only. */
export function legacyLegs(key: LegKey, value: unknown): ClassLeg[] {
  return legsFromValue(key, value, VEHICLE_CLASS_SEEDS.map((c) => ({ ...c, enabled: !c.exclusive })));
}
