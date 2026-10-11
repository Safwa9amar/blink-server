// A token Supabase Auth rejects is usually just expired — except in dev, where
// the app and this server can point at different Supabase projects (online vs
// the self-hosted `arch` stack: `npm run dev` vs `npm run dev:arch`, and the
// app's `.env.development.local`). Every token names its project in `iss`
// (`<SUPABASE_URL>/auth/v1`), so the 401 says "mismatch" instead of a
// misleading "expired". Pure for tests (token-issuer.test.ts).

const DEFAULT_MESSAGE = "Invalid or expired token";

function tokenIssuerHost(token: string): string | null {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"),
    );
    return typeof payload.iss === "string" ? new URL(payload.iss).host : null;
  } catch {
    return null;
  }
}

export function rejectedTokenMessage(token: string, supabaseUrl: string): string {
  const issuer = tokenIssuerHost(token);
  const own = new URL(supabaseUrl).host;
  if (!issuer || issuer === own) return DEFAULT_MESSAGE;
  return `Supabase mismatch: token is from ${issuer}, this server uses ${own}`;
}
