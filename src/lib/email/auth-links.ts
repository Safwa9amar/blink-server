// Pure helpers for the Supabase "Send Email" hook: link building + language pick.
export type AuthLang = "en" | "fr" | "ar";
const LANGS: readonly string[] = ["en", "fr", "ar"];
const asLang = (v: unknown): AuthLang | null =>
  typeof v === "string" && LANGS.includes(v) ? (v as AuthLang) : null;

function parseUrl(raw: string | undefined | null): URL | null {
  if (!raw) return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

// Dashboard contract: a redirect_to ending in /auth/confirm gets
// token_hash + type appended; anything else uses the Supabase verify URL.
export function buildAuthLink(opts: {
  redirectTo: string | undefined | null;
  tokenHash: string;
  type: string;
  supabaseUrl: string;
}): string {
  const url = parseUrl(opts.redirectTo);
  if (url && url.pathname.replace(/\/+$/, "").endsWith("/auth/confirm")) {
    url.searchParams.set("token_hash", opts.tokenHash);
    url.searchParams.set("type", opts.type);
    return url.toString();
  }
  const base = opts.supabaseUrl.replace(/\/+$/, "");
  const q = new URLSearchParams({ token: opts.tokenHash, type: opts.type });
  if (opts.redirectTo) q.set("redirect_to", opts.redirectTo);
  return `${base}/auth/v1/verify?${q.toString()}`;
}

// redirect_to ?lang= → user_metadata.locale|language|lang → "fr".
export function pickLang(redirectTo: string | undefined | null, userMetadata: unknown): AuthLang {
  const fromUrl = asLang(parseUrl(redirectTo)?.searchParams.get("lang"));
  if (fromUrl) return fromUrl;
  const meta = (userMetadata ?? {}) as Record<string, unknown>;
  for (const k of ["locale", "language", "lang"]) {
    const l = asLang(meta[k]);
    if (l) return l;
  }
  return "fr";
}
