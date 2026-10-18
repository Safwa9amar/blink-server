import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { overlaps, resolveFrom, type OverrideLike } from "./pricing/resolve";

const defaults = { merchant_commission_rate: { rate: 0.05 }, service_fee: { amount: 1.5 } };
let n = 0;
const ov = (p: Partial<OverrideLike>): OverrideLike => ({
  id: `o${++n}`,
  key: "merchant_commission_rate",
  service: null,
  wilaya_code: null,
  merchant_id: null,
  agent_id: null,
  value: { rate: 0.03 },
  starts_at: null,
  ends_at: null,
  archived_at: null,
  ...p,
});
const NOW = new Date("2026-11-15T12:00:00Z");

describe("resolveFrom", () => {
  it("falls back to the default with no overrides", () => {
    assert.deepEqual(resolveFrom(defaults, [], "merchant_commission_rate", {}), {
      value: { rate: 0.05 },
      overrideId: null,
    });
  });

  it("an unscoped override applies everywhere", () => {
    const o = ov({ value: { rate: 0.04 } });
    const r = resolveFrom(defaults, [o], "merchant_commission_rate", { wilaya: "16", merchantId: "m1", at: NOW });
    assert.deepEqual(r, { value: { rate: 0.04 }, overrideId: o.id });
  });

  it("ignores other keys", () => {
    const o = ov({ key: "service_fee", value: { amount: 0 } });
    assert.equal(resolveFrom(defaults, [o], "merchant_commission_rate", {}).overrideId, null);
  });

  it("non-matching scope is skipped (null scope = any, set scope must equal)", () => {
    const o = ov({ wilaya_code: "31" });
    assert.equal(resolveFrom(defaults, [o], "merchant_commission_rate", { wilaya: "16" }).overrideId, null);
    assert.equal(resolveFrom(defaults, [o], "merchant_commission_rate", { wilaya: null }).overrideId, null);
    assert.equal(resolveFrom(defaults, [o], "merchant_commission_rate", { wilaya: "31" }).overrideId, o.id);
  });

  it("partner beats wilaya beats service beats unscoped", () => {
    const any = ov({ value: { rate: 0.1 } });
    const service = ov({ service: "merchant", value: { rate: 0.11 } });
    const wilaya = ov({ wilaya_code: "16", value: { rate: 0.12 } });
    const partner = ov({ merchant_id: "m1", value: { rate: 0.13 } });
    const all = [any, service, wilaya, partner];
    const ctx = { service: "merchant", wilaya: "16", merchantId: "m1", at: NOW };
    const pick = (list: OverrideLike[], c = ctx) => resolveFrom(defaults, list, "merchant_commission_rate", c).overrideId;
    assert.equal(pick(all), partner.id);
    assert.equal(pick([any, service, wilaya]), wilaya.id);
    assert.equal(pick([any, service]), service.id);
    assert.equal(pick([any]), any.id);
    // another merchant → partner override doesn't match
    assert.equal(pick(all, { ...ctx, merchantId: "m2" }), wilaya.id);
  });

  it("partner (4) outranks wilaya+service (3)", () => {
    const both = ov({ wilaya_code: "16", service: "merchant" });
    const partner = ov({ agent_id: "a1" });
    const ctx = { service: "merchant", wilaya: "16", agentId: "a1", at: NOW };
    assert.equal(resolveFrom(defaults, [both, partner], "merchant_commission_rate", ctx).overrideId, partner.id);
  });

  it("respects the date window (start inclusive, end exclusive)", () => {
    const o = ov({ starts_at: "2026-11-01T00:00:00Z", ends_at: "2026-12-31T00:00:00Z" });
    const at = (iso: string) => resolveFrom(defaults, [o], "merchant_commission_rate", { at: new Date(iso) }).overrideId;
    assert.equal(at("2026-10-31T23:59:59Z"), null);
    assert.equal(at("2026-11-01T00:00:00Z"), o.id);
    assert.equal(at("2026-12-30T23:59:59Z"), o.id);
    assert.equal(at("2026-12-31T00:00:00Z"), null);
  });

  it("skips archived overrides", () => {
    const o = ov({ archived_at: "2026-11-02T00:00:00Z" });
    assert.equal(resolveFrom(defaults, [o], "merchant_commission_rate", { at: NOW }).overrideId, null);
  });

  it("an expired specific override falls back to a looser active one", () => {
    const expired = ov({ merchant_id: "m1", ends_at: "2026-11-01T00:00:00Z" });
    const loose = ov({ value: { rate: 0.02 } });
    const r = resolveFrom(defaults, [expired, loose], "merchant_commission_rate", { merchantId: "m1", at: NOW });
    assert.equal(r.overrideId, loose.id);
  });
});

describe("overlaps", () => {
  const base = { key: "service_fee", service: null, wilaya_code: "16", merchant_id: null, agent_id: null, archived_at: null };
  const w = (starts_at: string | null, ends_at: string | null, extra: Partial<OverrideLike> = {}) => ({
    ...base,
    starts_at,
    ends_at,
    ...extra,
  });

  it("detects overlapping windows", () => {
    assert.equal(overlaps(w("2026-11-01T00:00:00Z", "2026-12-01T00:00:00Z"), w("2026-11-15T00:00:00Z", "2027-01-01T00:00:00Z")), true);
    assert.equal(overlaps(w(null, null), w("2026-11-15T00:00:00Z", "2027-01-01T00:00:00Z")), true);
    assert.equal(overlaps(w("2026-11-01T00:00:00Z", null), w("2030-01-01T00:00:00Z", null)), true);
  });
  it("touching or disjoint windows don't overlap", () => {
    assert.equal(overlaps(w("2026-11-01T00:00:00Z", "2026-12-01T00:00:00Z"), w("2026-12-01T00:00:00Z", "2027-01-01T00:00:00Z")), false);
    assert.equal(overlaps(w(null, "2026-11-01T00:00:00Z"), w("2026-12-01T00:00:00Z", null)), false);
  });
  it("different scope or key never overlaps", () => {
    assert.equal(overlaps(w(null, null), w(null, null, { wilaya_code: "31" })), false);
    assert.equal(overlaps(w(null, null), w(null, null, { service: "merchant" })), false);
    assert.equal(overlaps(w(null, null), w(null, null, { key: "ride_fare" })), false);
    assert.equal(overlaps(w(null, null, { merchant_id: "m1" }), w(null, null, { merchant_id: "m2" })), false);
  });
  it("archived overrides never conflict", () => {
    assert.equal(overlaps(w(null, null), w(null, null, { archived_at: "2026-11-01T00:00:00Z" })), false);
  });
});
