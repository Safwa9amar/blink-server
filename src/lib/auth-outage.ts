// Tells a Supabase Auth outage (network blip, 5xx) apart from a rejected
// token. The auth middleware answers the first with 503 and the second with
// 401: the app treats a 401 as an expired session and signs the user out, so
// a passing network hiccup must never look like one. Pure for tests
// (auth-outage.test.ts).

export function isAuthOutage(error: { name?: string; status?: number } | null | undefined): boolean {
  if (!error) return false;
  if (error.name === "AuthRetryableFetchError") return true;
  return !error.status || error.status >= 500;
}
