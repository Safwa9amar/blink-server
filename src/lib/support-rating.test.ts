import { test } from "node:test";
import assert from "node:assert/strict";
import { rateConversationSchema } from "../validators/support-chat";

test("rating accepts 1-5 integers with optional comment", () => {
  assert.ok(rateConversationSchema.safeParse({ rating: 1 }).success);
  assert.ok(rateConversationSchema.safeParse({ rating: 5, comment: "great" }).success);
});

test("rating rejects out-of-range, non-integer and long comments", () => {
  assert.equal(rateConversationSchema.safeParse({ rating: 0 }).success, false);
  assert.equal(rateConversationSchema.safeParse({ rating: 6 }).success, false);
  assert.equal(rateConversationSchema.safeParse({ rating: 3.5 }).success, false);
  assert.equal(rateConversationSchema.safeParse({ rating: 3, comment: "x".repeat(501) }).success, false);
  assert.ok(rateConversationSchema.safeParse({ rating: 3, comment: "x".repeat(500) }).success);
});
