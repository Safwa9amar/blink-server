// scripts/test-support-prompt.ts — run with: npx tsx scripts/test-support-prompt.ts
import assert from "node:assert/strict";
import { parseEscalation, buildSupportSystemPrompt } from "../src/lib/ai/support-prompt";

// parseEscalation
{
  const r = parseEscalation("Sure, here is the answer.");
  assert.equal(r.escalate, false, "plain reply should not escalate");
  assert.equal(r.clean, "Sure, here is the answer.");
}
{
  const r = parseEscalation("<<ESCALATE: needs order lookup>>");
  assert.equal(r.escalate, true, "token should escalate");
  assert.equal(r.reason, "needs order lookup");
  assert.equal(r.clean, "", "token-only reply has empty clean text");
}
{
  const r = parseEscalation("Let me get a human. <<ESCALATE>>");
  assert.equal(r.escalate, true);
  assert.equal(r.reason, "needs a human", "missing reason falls back");
  assert.equal(r.clean, "Let me get a human.");
}

// buildSupportSystemPrompt
{
  const p = buildSupportSystemPrompt(
    "customer",
    "fr",
    "Q: Order Tracking\nA: Track from Activities."
  );
  assert.ok(p.includes("French"), "locale name injected");
  assert.ok(p.includes("<<ESCALATE"), "escalation rule present");
  assert.ok(p.includes("Order Tracking"), "kbText injected");
}

console.log("OK: support-prompt tests passed");
