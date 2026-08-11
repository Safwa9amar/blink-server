export interface KbEntry {
  q: string;
  a: string;
}

// Source of truth (English) for the bot. Ported from the mobile app's
// data/support/<role>-support.ts FAQ. The bot answers ONLY from this content
// and replies in the user's locale (the model translates as needed).
export const SUPPORT_KB: Record<string, KbEntry[]> = {
  customer: [
    {
      q: "Account Issues",
      a: "If you are experiencing issues with your account, such as login problems, profile updates, or security concerns, please ensure you are using the latest version of the app. You can manage your account settings directly from the Profile tab.",
    },
    {
      q: "Payment & Refunds",
      a: "We support multiple payment methods including credit cards and mobile wallets. If you have been charged incorrectly or need to request a refund for a canceled order, the process typically takes 3-5 business days to reflect on your bank statement.",
    },
    {
      q: "Order Tracking",
      a: "You can track your active orders directly from the Home or Activities tab. Our real-time map displays the courier's location alongside the estimated time of arrival (ETA).",
    },
    {
      q: "Promo Codes",
      a: "Promo codes can be applied during the checkout process. Ensure your cart meets the minimum requirement for the promotion. Some promo codes may be restricted to specific restaurants or first-time users.",
    },
    {
      q: "How do I reset my password?",
      a: 'To reset your password, go to the login screen and tap on "Forgot Password". We will send you an OTP to your registered phone number to verify and set a new password.',
    },
    {
      q: "Is my personal data safe?",
      a: "Yes, your data is fully encrypted and stored securely. We follow strict data protection guidelines to ensure your privacy is always protected.",
    },
    {
      q: "How can I track my delivery?",
      a: 'You can track your order in real-time through the "Activities" tab. Once a rider is assigned, you will see their live location on the map.',
    },
    {
      q: "What if my order is delayed?",
      a: "In case of a delay, you can contact the rider directly via chat or call. You can also reach out to our support team through the Support Center for immediate assistance.",
    },
  ],
  rider: [
    {
      q: "Account & Verification",
      a: "Keep your rider profile, documents, and bank info up to date. Verification can take up to 48 hours after submitting new documents. You can check the status anytime from your Profile.",
    },
    {
      q: "Trip Acceptance & Cancellations",
      a: "Your acceptance and cancellation rates affect tier progress. Aim for an acceptance rate above 80% and a cancellation rate below 5% to qualify for Diamond tier bonuses.",
    },
    {
      q: "Earnings & Payouts",
      a: "Earnings are calculated daily and paid out weekly to your registered bank account. You can request an instant withdrawal from Blink Cash subject to a small processing fee.",
    },
    {
      q: "Vehicle & Documents",
      a: "Make sure your vehicle inspection certificate and insurance documents are valid. The app will lock new trips if any required document is expired.",
    },
    {
      q: "How do I move up to Diamond tier?",
      a: "Tiers are based on trip volume, acceptance rate, and customer rating over a rolling 30-day window. Complete 200+ trips with a 4.8+ rating to qualify for Diamond.",
    },
  ],
  merchant: [
    {
      q: "Merchant Account",
      a: "Keep your merchant profile and store documents up to date. Verification typically takes 24-48 hours for new stores or document changes.",
    },
    {
      q: "Managing your store",
      a: "You can manage multiple stores under one account. Edit hours, address, and menu from Profile → My Stores. Each store has its own ratings and sales data.",
    },
    {
      q: "Running promotions",
      a: "Use the in-app Promotions builder to schedule discounts, bundles, or flash sales. Approved promotions go live within minutes.",
    },
    {
      q: "Payouts & dues",
      a: "Sales are settled weekly, minus the platform commission. Outstanding dues to Blink can be paid from the Blink Cash tab.",
    },
    {
      q: "How do I improve my store's ranking?",
      a: "Store ranking is based on rating, prep time, and acceptance rate. Maintaining a 4.5+ rating and a prep time under 12 minutes puts you in the top tier.",
    },
  ],
  agent: [
    {
      q: "Agent Verification",
      a: "Make sure your shop documents and ID are uploaded and current. Verification can take up to 48 hours after submitting new documents.",
    },
    {
      q: "How deposits work",
      a: "When a rider scans your deposit QR, the amount is added to their wallet and a corresponding due is credited to your shop. Settle dues from Blink Cash before the weekly cutoff.",
    },
    {
      q: "How withdrawals work",
      a: "Riders can withdraw cash from your shop using a one-time QR. The withdrawn amount is deducted from their wallet and credited to your dues balance.",
    },
    {
      q: "Updating shop info",
      a: "Address, opening hours, and contact number can be edited from Profile → My Shop. Changes are reviewed and published within 24 hours.",
    },
    {
      q: "What happens if I miss a dues payment?",
      a: "If a dues payment is missed, your shop is paused for new deposit and withdrawal traffic until the balance is settled. Late fees may apply.",
    },
  ],
};

// A formatted Q/A block for the system prompt. Falls back to the customer KB
// for unknown roles.
export function kbForRole(role: string): string {
  const entries = SUPPORT_KB[role]?.length ? SUPPORT_KB[role] : SUPPORT_KB.customer;
  return entries.map((e, i) => `Q${i + 1}: ${e.q}\nA${i + 1}: ${e.a}`).join("\n\n");
}
