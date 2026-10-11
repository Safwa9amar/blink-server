import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildMerchantRequiredActions,
  hoursSet,
  missingDocuments,
  type RequiredActionsInput,
  type RequiredActionStore,
} from "./merchant-required-actions";

const HOURS = { sat: { enabled: true, shifts: [{ open: "09:00", close: "21:00" }] } };
const DOCS = {
  commercial_register_front_url: "front.jpg",
  commercial_register_back_url: "back.jpg",
  nif: "123",
  nis: "456",
};
const verified = (value: string) => ({
  status: "verified",
  reason: null,
  value,
  reviewed_at: "2026-10-01T00:00:00Z",
  reviewed_by: "staff-1",
});
/** Blink verified every document of DOCS. */
const REVIEW = {
  commercial_register_front: verified(DOCS.commercial_register_front_url),
  commercial_register_back: verified(DOCS.commercial_register_back_url),
  nif: verified(DOCS.nif),
  nis: verified(DOCS.nis),
};

const store = (over: Partial<RequiredActionStore> = {}): RequiredActionStore => ({
  id: "s1",
  name: "Superette Hydra",
  status: "active",
  hours: HOURS,
  documents: DOCS,
  document_review: REVIEW,
  ...over,
});

const product = (over = {}) => ({
  store_id: "s1",
  review_status: "approved",
  suggestion_status: null,
  review_note: null,
  updated_at: "2026-10-01T00:00:00Z",
  ...over,
});

const input = (over: Partial<RequiredActionsInput> = {}): RequiredActionsInput => ({
  stores: [store()],
  products: [product()],
  packs: [],
  dues: new Map(),
  pinSet: true,
  ...over,
});

describe("missingDocuments / hoursSet", () => {
  it("lists blank or absent documents", () => {
    assert.deepEqual(missingDocuments(DOCS), []);
    assert.deepEqual(missingDocuments({ ...DOCS, nif: " ", commercial_register_back_url: null }), [
      "commercial_register_back_url",
      "nif",
    ]);
    assert.deepEqual(missingDocuments(null).length, 4);
  });
  it("needs an enabled day with a shift", () => {
    assert.equal(hoursSet(HOURS), true);
    assert.equal(hoursSet(null), false);
    assert.equal(hoursSet({ sat: { enabled: false, shifts: [{ open: "09:00", close: "10:00" }] } }), false);
    assert.equal(hoursSet({ sat: { enabled: true, shifts: [] } }), false);
  });
});

describe("buildMerchantRequiredActions", () => {
  it("is empty for a store with nothing to fix", () => {
    assert.deepEqual(buildMerchantRequiredActions(input()), []);
  });

  it("flags a new store: in review, documents, products, hours", () => {
    const actions = buildMerchantRequiredActions(
      input({
        stores: [store({ status: "under_review", hours: null, documents: { nif: "1" } })],
        products: [],
      })
    );
    assert.deepEqual(
      actions.map((a) => [a.id, a.severity, a.status]),
      [
        ["store_under_review:s1", "blocking", "in_review"],
        ["store_documents_missing:s1", "blocking", "todo"],
        ["no_products:s1", "blocking", "todo"],
        ["hours_not_set:s1", "warning", "todo"],
        // The NIF it did provide isn't verified in this form ("1", not "123").
        ["store_documents_pending:s1", "info", "in_review"],
      ]
    );
    assert.deepEqual(actions[4].params, { store_name: "Superette Hydra", documents: ["nif"] });
    assert.deepEqual(actions[1].params, {
      store_name: "Superette Hydra",
      missing: ["commercial_register_front_url", "commercial_register_back_url", "nis"],
    });
    assert.equal(actions[0].store_id, "s1");
  });

  it("flags a store staff rejected or deactivated, with the note, as blocking", () => {
    const actions = buildMerchantRequiredActions(
      input({ stores: [store({ status: "inactive", review_note: "  Blurry register " })] })
    );
    assert.deepEqual(actions, [
      {
        id: "store_rejected:s1",
        kind: "store_rejected",
        severity: "blocking",
        status: "rejected",
        params: { store_name: "Superette Hydra", note: "Blurry register" },
        store_id: "s1",
      },
    ]);
  });

  it("keeps the earlier reason on a resubmitted store, still in review", () => {
    const [resubmitted] = buildMerchantRequiredActions(
      input({ stores: [store({ status: "under_review", review_note: "Blurry register" })] })
    );
    assert.deepEqual(
      [resubmitted.kind, resubmitted.status, resubmitted.params],
      ["store_under_review", "in_review", { store_name: "Superette Hydra", note: "Blurry register" }]
    );
    const [fresh] = buildMerchantRequiredActions(input({ stores: [store({ status: "under_review" })] }));
    assert.deepEqual(fresh.params, { store_name: "Superette Hydra" });
  });

  it("has no review action for a store hidden for another reason (inactive, no note)", () => {
    for (const review_note of [null, " "]) {
      const kinds = buildMerchantRequiredActions(
        input({ stores: [store({ status: "inactive", review_note })] })
      ).map((a) => a.kind);
      assert.deepEqual(kinds, []);
    }
  });

  it("makes missing documents blocking on a rejected store (Blink needs them to approve the store)", () => {
    const actions = buildMerchantRequiredActions(
      input({ stores: [store({ status: "inactive", review_note: "No NIF", documents: { ...DOCS, nif: "" } })] })
    );
    assert.deepEqual(
      actions.map((a) => [a.kind, a.severity]),
      [
        ["store_rejected", "blocking"],
        ["store_documents_missing", "blocking"],
      ]
    );
  });

  it("counts rejected products with the latest note", () => {
    const [a] = buildMerchantRequiredActions(
      input({
        products: [
          product({ review_status: "rejected", review_note: "Old note", updated_at: "2026-09-01T00:00:00Z" }),
          product({ review_status: "rejected", review_note: "Blurry photo", updated_at: "2026-10-05T00:00:00Z" }),
          product(),
        ],
      })
    );
    assert.equal(a.kind, "products_rejected");
    assert.equal(a.status, "rejected");
    assert.deepEqual(a.params, { store_name: "Superette Hydra", count: 2, note: "Blurry photo" });
  });

  it("counts declined price suggestions and rejected packs as info", () => {
    const actions = buildMerchantRequiredActions(
      input({
        products: [product({ suggestion_status: "rejected", review_note: "Too high" })],
        packs: [
          { store_id: "s1", status: "inactive", review_note: "No margin" },
          { store_id: "s1", status: "inactive", review_note: null },
          { store_id: "s1", status: "active", review_note: null },
        ],
      })
    );
    assert.deepEqual(
      actions.map((a) => [a.kind, a.severity, a.params.count, a.params.note]),
      [
        ["price_suggestions_rejected", "info", 1, "Too high"],
        ["packs_rejected", "info", 1, "No margin"],
      ]
    );
  });

  it("counts only staff-held packs that are off: a note is mandatory on a staff rejection", () => {
    const actions = buildMerchantRequiredActions(
      input({
        packs: [
          // Rejected / deactivated by staff (note required) → to fix.
          { store_id: "s1", status: "inactive", review_note: "Blurry image", updated_at: "2026-10-02T00:00:00Z" },
          { store_id: "s1", status: "inactive", review_note: "No margin", updated_at: "2026-10-05T00:00:00Z" },
          // Paused by the merchant: no note → nothing to do.
          { store_id: "s1", status: "inactive", review_note: null },
          // Resubmitted (the staff note stays until approval) → waiting, not "rejected".
          { store_id: "s1", status: "under_review", review_note: "Old reason" },
          // Archived while on hold → out of the to-do list.
          { store_id: "s1", status: "archived", review_note: "Old reason" },
        ],
      })
    );
    assert.deepEqual(
      actions.map((a) => [a.kind, a.params.count, a.params.note]),
      [["packs_rejected", 2, "No margin"]]
    );
  });

  it("uses product counts when only flagged products are passed", () => {
    const counted = (n: number) =>
      buildMerchantRequiredActions(input({ products: [], productCounts: new Map([["s1", n]]) })).map((a) => a.kind);
    assert.deepEqual(counted(12), []);
    assert.deepEqual(counted(0), ["no_products"]);
  });

  it("asks for a PIN and reminds of dues", () => {
    const actions = buildMerchantRequiredActions(input({ pinSet: false, dues: new Map([["s1", 512.5]]) }));
    assert.deepEqual(
      actions.map((a) => [a.id, a.severity, a.params]),
      [
        ["dues_outstanding:s1", "warning", { store_name: "Superette Hydra", amount: 512.5 }],
        ["pin_not_set", "warning", {}],
      ]
    );
    assert.equal(actions[1].store_id, undefined);
  });

  it("evaluates every store and puts blocking items first", () => {
    const actions = buildMerchantRequiredActions(
      input({
        stores: [store(), store({ id: "s2", name: "Kouba", status: "under_review" })],
        products: [product(), product({ store_id: "s2" })],
        dues: new Map([["s1", 100]]),
      })
    );
    assert.deepEqual(
      actions.map((a) => a.id),
      ["store_under_review:s2", "dues_outstanding:s1"]
    );
    assert.equal(actions[0].params.store_name, "Kouba");
  });
});

describe("buildMerchantRequiredActions — Blink's document verification", () => {
  const rejected = (value: string, reason: string) => ({ ...verified(value), status: "rejected", reason });

  it("tells the merchant Blink is still checking documents they provided (info)", () => {
    for (const document_review of [undefined, {}, null, "garbage"]) {
      const actions = buildMerchantRequiredActions(input({ stores: [store({ document_review })] }));
      assert.deepEqual(actions, [
        {
          id: "store_documents_pending:s1",
          kind: "store_documents_pending",
          severity: "info",
          status: "in_review",
          params: {
            store_name: "Superette Hydra",
            documents: ["commercial_register_front", "commercial_register_back", "nif", "nis"],
          },
          store_id: "s1",
        },
      ]);
    }
  });

  it("puts a re-uploaded document back in Blink's queue", () => {
    const [a] = buildMerchantRequiredActions(
      input({ stores: [store({ documents: { ...DOCS, commercial_register_back_url: "back-v2.jpg" } })] })
    );
    assert.equal(a.kind, "store_documents_pending");
    assert.deepEqual(a.params.documents, ["commercial_register_back"]);
  });

  it("lists rejected documents with Blink's reasons — a warning on a live store", () => {
    const actions = buildMerchantRequiredActions(
      input({
        stores: [
          store({
            document_review: {
              ...REVIEW,
              nif: rejected(DOCS.nif, "Wrong number"),
              commercial_register_front: rejected(DOCS.commercial_register_front_url, "Blurry"),
            },
          }),
        ],
      })
    );
    assert.deepEqual(actions, [
      {
        id: "store_documents_rejected:s1",
        kind: "store_documents_rejected",
        severity: "warning",
        status: "rejected",
        params: {
          store_name: "Superette Hydra",
          documents: [
            { key: "commercial_register_front", reason: "Blurry" },
            { key: "nif", reason: "Wrong number" },
          ],
        },
        store_id: "s1",
      },
    ]);
  });

  it("makes rejected documents blocking on a store in review or rejected", () => {
    for (const over of [{ status: "under_review" }, { status: "inactive", review_note: "Fix the NIS" }]) {
      const actions = buildMerchantRequiredActions(
        input({ stores: [store({ ...over, document_review: { ...REVIEW, nis: rejected(DOCS.nis, "Expired") } })] })
      );
      const a = actions.find((x) => x.kind === "store_documents_rejected");
      assert.equal(a?.severity, "blocking", over.status);
    }
  });

  it("drops a rejection once the merchant replaces the document (pending again)", () => {
    const actions = buildMerchantRequiredActions(
      input({ stores: [store({ documents: { ...DOCS, nif: "789" }, document_review: { ...REVIEW, nif: rejected(DOCS.nif, "Wrong") } })] })
    );
    assert.deepEqual(
      actions.map((a) => [a.kind, a.params.documents]),
      [["store_documents_pending", ["nif"]]]
    );
  });

  it("keeps missing, rejected and pending documents apart", () => {
    const actions = buildMerchantRequiredActions(
      input({
        stores: [
          store({
            documents: { ...DOCS, nis: "", commercial_register_back_url: "back-v2.jpg" },
            document_review: { ...REVIEW, nif: rejected(DOCS.nif, "Wrong") },
          }),
        ],
      })
    );
    assert.deepEqual(
      actions.map((a) => [a.kind, a.severity, a.params.missing ?? a.params.documents]),
      [
        ["store_documents_missing", "warning", ["nis"]],
        ["store_documents_rejected", "warning", [{ key: "nif", reason: "Wrong" }]],
        ["store_documents_pending", "info", ["commercial_register_back"]],
      ]
    );
  });
});
