import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  menuCategoryFilter,
  PRIVATE_STORE_FIELDS,
  productSearchFilter,
  storeOpenState,
  stripPrivateStoreFields,
  toStorefront,
} from "./store-categories";

// Stores run on Africa/Algiers time (UTC+1, no DST). 2026-10-09 is a Friday.
const DAYS = ["sat", "sun", "mon", "tue", "wed", "thu", "fri"];
const week = (open: string, close: string, closed: string[] = []) =>
  Object.fromEntries(
    DAYS.map((d) => [d, { enabled: !closed.includes(d), shifts: [{ open, close }] }])
  );
const only = (day: string, shifts: { open: string; close: string }[]) =>
  Object.fromEntries(DAYS.map((d) => [d, { enabled: d === day, shifts }]));
const at = (iso: string) => new Date(iso);

describe("storeOpenState", () => {
  const hydra = { hours: week("09:00", "21:00"), is_open: true };
  const babEzzouar = { hours: week("08:00", "22:00", ["fri"]), is_open: true };

  it("is closed just after midnight and opens later the same day", () => {
    // Sat 00:04 local.
    assert.deepEqual(storeOpenState(hydra, at("2026-10-09T23:04:00Z")), {
      is_open: false,
      next_open_at: "2026-10-10T08:00:00.000Z",
    });
  });

  it("is open inside a shift", () => {
    assert.deepEqual(storeOpenState(hydra, at("2026-10-10T10:00:00Z")), {
      is_open: true,
      next_open_at: null,
    });
  });

  it("closes at the shift's close time", () => {
    // Sat 21:00 local → reopens Sun 09:00.
    assert.deepEqual(storeOpenState(hydra, at("2026-10-10T20:00:00Z")), {
      is_open: false,
      next_open_at: "2026-10-11T08:00:00.000Z",
    });
  });

  it("skips a closed day", () => {
    // Thu 22:30 local; Friday is off → Sat 08:00.
    assert.deepEqual(storeOpenState(babEzzouar, at("2026-10-08T21:30:00Z")), {
      is_open: false,
      next_open_at: "2026-10-10T07:00:00.000Z",
    });
  });

  it("finds a later shift the same day", () => {
    const store = {
      hours: only("sat", [
        { open: "14:00", close: "22:00" },
        { open: "08:00", close: "12:00" },
      ]),
    };
    // Sat 13:00 local.
    assert.deepEqual(storeOpenState(store, at("2026-10-10T12:00:00Z")), {
      is_open: false,
      next_open_at: "2026-10-10T13:00:00.000Z",
    });
  });

  it("wraps to the same weekday next week", () => {
    const store = { hours: only("sat", [{ open: "08:00", close: "10:00" }]) };
    // Sat 11:00 local → next Saturday 08:00.
    assert.equal(
      storeOpenState(store, at("2026-10-10T10:00:00Z")).next_open_at,
      "2026-10-17T07:00:00.000Z"
    );
  });

  it("stays open after midnight for an overnight shift", () => {
    const store = { hours: only("fri", [{ open: "20:00", close: "02:00" }]) };
    // Sat 01:00 local, carried over from Friday.
    assert.equal(storeOpenState(store, at("2026-10-10T00:00:00Z")).is_open, true);
    // Sat 03:00 local → next Friday 20:00.
    assert.deepEqual(storeOpenState(store, at("2026-10-10T02:00:00Z")), {
      is_open: false,
      next_open_at: "2026-10-16T19:00:00.000Z",
    });
  });

  it("never opens when every day is off", () => {
    const store = { hours: week("09:00", "21:00", DAYS) };
    assert.deepEqual(storeOpenState(store, at("2026-10-10T10:00:00Z")), {
      is_open: false,
      next_open_at: null,
    });
  });

  it("lets the merchant's manual override win over the schedule", () => {
    const now = at("2026-10-10T10:00:00Z"); // inside Hydra's shift
    assert.deepEqual(storeOpenState({ ...hydra, manual_override: true, is_open: false }, now), {
      is_open: false,
      next_open_at: null,
    });
    const night = at("2026-10-09T23:04:00Z"); // outside it
    assert.equal(
      storeOpenState({ ...hydra, manual_override: true, is_open: true }, night).is_open,
      true
    );
  });

  it("uses the stored flag without a schedule", () => {
    assert.deepEqual(storeOpenState({ hours: null, is_open: false }), {
      is_open: false,
      next_open_at: null,
    });
    assert.equal(storeOpenState({ hours: {}, is_open: true }).is_open, true);
  });
});

describe("toStorefront", () => {
  it("adds today's hours and the open state", () => {
    const out = toStorefront(
      { category_slugs: ["grocery"], hours: week("09:00", "21:00"), is_open: true, opening_hours: null },
      at("2026-10-09T23:04:00Z")
    );
    assert.equal(out.opening_hours, "09:00 - 21:00");
    assert.equal(out.is_open, false);
    assert.equal(out.next_open_at, "2026-10-10T08:00:00.000Z");
    assert.deepEqual(out.category_slugs, ["grocery", "supermarket"]);
    assert.equal(out.is_supermarket, true);
  });
});

describe("store privacy", () => {
  // A full stores row as select("*") returns it (the columns customers may see
  // plus the staff/merchant-only ones).
  const row = {
    id: "store-1",
    owner_id: "merchant-1",
    name: "Kouba Market",
    phone: "+213555000000",
    whatsapp: "+213555000001",
    email: "kouba@example.com",
    category_slugs: ["grocery"],
    is_supermarket: false,
    is_open: false,
    manual_override: true,
    hours: week("09:00", "21:00"),
    opening_hours: null,
    status: "active",
    documents: {
      commercial_register: "https://cdn.example/rc.jpg",
      nif: "000016001234567",
      nis: "000116001234567",
      additional: ["https://cdn.example/extra.pdf"],
    },
    document_review: { nif: { status: "approved", reviewed_by: "staff-7" } },
    review_note: "Owner called — RC scan blurry, accepted anyway",
    weekly_goal: 50000,
  };

  it("lists exactly the four private columns", () => {
    assert.deepEqual([...PRIVATE_STORE_FIELDS].sort(), [
      "document_review",
      "documents",
      "review_note",
      "weekly_goal",
    ]);
  });

  it("stripPrivateStoreFields drops them and keeps every other column", () => {
    const out = stripPrivateStoreFields(row);
    for (const key of PRIVATE_STORE_FIELDS) assert.equal(key in out, false, key);
    const { documents, document_review, review_note, weekly_goal, ...rest } = row;
    assert.deepEqual(out, rest);
    // The input row is left alone.
    assert.equal(row.weekly_goal, 50000);
    assert.ok(row.documents.nif);
  });

  it("toStorefront never returns them, still honours manual_override", () => {
    const out = toStorefront(row, at("2026-10-10T10:00:00Z"));
    for (const key of PRIVATE_STORE_FIELDS) assert.equal(key in out, false, key);
    for (const key of ["id", "owner_id", "name", "phone", "whatsapp", "email", "manual_override", "hours", "status"]) {
      assert.ok(key in out, key);
    }
    // Inside the schedule, but the merchant forced the store closed.
    assert.equal(out.is_open, false);
    assert.equal(out.next_open_at, null);
    assert.equal(out.manual_override, true);
    assert.equal(out.opening_hours, "09:00 - 21:00");
    assert.equal(out.is_supermarket, true);
    assert.equal(JSON.stringify(out).includes("staff-7"), false);
  });
});

describe("menuCategoryFilter", () => {
  it("matches tagged rows only when no name slugs to the id", () => {
    assert.equal(menuCategoryFilter("burgers", ["Drinks", null]), 'or(menu_category.eq."burgers")');
  });

  it("also matches untagged rows by category name, once per name", () => {
    assert.equal(
      menuCategoryFilter("fresh-produce", ["Fresh Produce", "Drinks", "Fresh Produce", "fresh produce"]),
      'or(menu_category.eq."fresh-produce",and(menu_category.is.null,category.in.("Fresh Produce","fresh produce")))'
    );
  });

  it("quotes names with PostgREST-reserved characters", () => {
    assert.equal(
      menuCategoryFilter("snacks-sweets", ['Snacks, "Sweets"']),
      'or(menu_category.eq."snacks-sweets",and(menu_category.is.null,category.in.("Snacks, \\"Sweets\\"")))'
    );
  });
});

describe("productSearchFilter", () => {
  it("searches title, description and unit with the term quoted", () => {
    assert.equal(
      productSearchFilter("lait (1L)"),
      'or(title.ilike."%lait (1L)%",description.ilike."%lait (1L)%",unit.ilike."%lait (1L)%")'
    );
  });
});
