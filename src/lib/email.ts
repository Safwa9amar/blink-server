// Email helpers. Pure for tests (email.test.ts).

/**
 * ILIKE pattern that matches `email` exactly, ignoring case (Ali@x.com and
 * ali@x.com are the same inbox). LIKE's wildcards are escaped: "_" is legal in
 * an address and would otherwise match any character.
 */
export function emailLikePattern(email: string): string {
  return email.trim().replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
