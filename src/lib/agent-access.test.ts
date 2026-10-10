import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AGENT_ACCESS_CODES,
  AGENT_ACCESS_MESSAGE,
  canAgentProcess,
  type AccessShop,
  type AccessTx,
} from "./agent-access";

const ME = "65881329-6f7c-4a4d-ae85-da016d823ec9";
const OTHER = "97d0d98e-db57-4809-ba99-276a9ec2f081";
const MY_SHOP = "d85ddfda-e069-4be2-819f-121372c0df65";
const OTHER_SHOP = "bd435b1e-95c8-4a73-a2fe-cde65dee8942";

const shop = (over: Partial<AccessShop> = {}): AccessShop => ({
  id: MY_SHOP,
  user_id: ME,
  review_status: "active",
  ...over,
});
const tx = (over: Partial<AccessTx> = {}): AccessTx => ({
  agent_id: null,
  shop_id: null,
  ...over,
});

const OK = { ok: true };
const NOT_APPROVED = { ok: false, code: "shop_not_approved" };
const NOT_YOURS = { ok: false, code: "not_your_transaction" };

describe("canAgentProcess — the agent's shop", () => {
  it("refuses an agent without a shop", () => {
    assert.deepEqual(
      canAgentProcess({ shop: null, tx: tx({ agent_id: ME }), agentId: ME }),
      NOT_APPROVED
    );
  });

  it("refuses a shop still under review", () => {
    assert.deepEqual(
      canAgentProcess({
        shop: shop({ review_status: "under_review" }),
        tx: tx({ agent_id: ME }),
        agentId: ME,
      }),
      NOT_APPROVED
    );
  });

  it("refuses a rejected shop", () => {
    assert.deepEqual(
      canAgentProcess({
        shop: shop({ review_status: "rejected" }),
        tx: tx({ agent_id: ME }),
        agentId: ME,
      }),
      NOT_APPROVED
    );
  });

  it("refuses a shop owned by someone else", () => {
    assert.deepEqual(
      canAgentProcess({ shop: shop({ user_id: OTHER }), tx: tx(), agentId: ME }),
      NOT_APPROVED
    );
  });

  it("checks the shop before the operation", () => {
    assert.deepEqual(
      canAgentProcess({
        shop: shop({ review_status: "under_review" }),
        tx: tx({ agent_id: OTHER, shop_id: OTHER_SHOP }),
        agentId: ME,
      }),
      NOT_APPROVED
    );
  });

  it("refuses a shop with no review status", () => {
    assert.deepEqual(
      canAgentProcess({
        shop: shop({ review_status: null }),
        tx: tx({ agent_id: ME }),
        agentId: ME,
      }),
      NOT_APPROVED
    );
  });

  it("refuses an unknown review status", () => {
    assert.deepEqual(
      canAgentProcess({
        shop: shop({ review_status: "suspended" }),
        tx: tx({ agent_id: ME }),
        agentId: ME,
      }),
      NOT_APPROVED
    );
  });

  it("refuses a walk-in through a shop that is not approved", () => {
    assert.deepEqual(
      canAgentProcess({
        shop: shop({ review_status: "under_review" }),
        tx: tx(),
        agentId: ME,
      }),
      NOT_APPROVED
    );
  });
});

describe("canAgentProcess — whose operation", () => {
  it("allows an operation assigned to the agent", () => {
    assert.deepEqual(
      canAgentProcess({ shop: shop(), tx: tx({ agent_id: ME, shop_id: MY_SHOP }), agentId: ME }),
      OK
    );
  });

  it("allows an operation sent to the agent's shop", () => {
    assert.deepEqual(
      canAgentProcess({ shop: shop(), tx: tx({ shop_id: MY_SHOP }), agentId: ME }),
      OK
    );
  });

  it("allows a walk-in (no agent or shop picked yet)", () => {
    assert.deepEqual(canAgentProcess({ shop: shop(), tx: tx(), agentId: ME }), OK);
  });

  it("refuses another agent's operation", () => {
    assert.deepEqual(
      canAgentProcess({
        shop: shop(),
        tx: tx({ agent_id: OTHER, shop_id: OTHER_SHOP }),
        agentId: ME,
      }),
      NOT_YOURS
    );
  });

  it("refuses an operation assigned to another agent without a shop (older app builds)", () => {
    assert.deepEqual(
      canAgentProcess({ shop: shop(), tx: tx({ agent_id: OTHER }), agentId: ME }),
      NOT_YOURS
    );
  });

  it("refuses an operation sent to another agent's shop", () => {
    assert.deepEqual(
      canAgentProcess({ shop: shop(), tx: tx({ shop_id: OTHER_SHOP }), agentId: ME }),
      NOT_YOURS
    );
  });

  it("compares ids case-insensitively", () => {
    assert.deepEqual(
      canAgentProcess({
        shop: shop({ user_id: ME.toUpperCase() }),
        tx: tx({ agent_id: ME.toUpperCase() }),
        agentId: ME,
      }),
      OK
    );
  });

  it("compares the shop id case-insensitively", () => {
    assert.deepEqual(
      canAgentProcess({ shop: shop(), tx: tx({ shop_id: MY_SHOP.toUpperCase() }), agentId: ME }),
      OK
    );
  });

  it("a row without agent_id is not a walk-in", () => {
    const untyped = { shop_id: null } as unknown as AccessTx;
    assert.deepEqual(canAgentProcess({ shop: shop(), tx: untyped, agentId: ME }), NOT_YOURS);
  });

  it("a row without shop_id is not a walk-in", () => {
    const untyped = { agent_id: null } as unknown as AccessTx;
    assert.deepEqual(canAgentProcess({ shop: shop(), tx: untyped, agentId: ME }), NOT_YOURS);
  });
});

describe("AGENT_ACCESS_MESSAGE", () => {
  it("has an error text for every code", () => {
    for (const code of AGENT_ACCESS_CODES) {
      assert.ok(AGENT_ACCESS_MESSAGE[code].length > 0, code);
    }
  });
});
