// postgrest-js retries GET/HEAD through a network blip but never a write: a
// dropped INSERT/UPSERT comes back as `status: 0` with "TypeError: fetch
// failed". On a flaky link (common in dev) that silently kills sign-ups while
// the reads around them succeed. Pure for tests (db-retry.test.ts).

/**
 * Re-run `write` while it fails without reaching the database (`status: 0`).
 * Only for writes that are safe to replay: an upsert with `ignoreDuplicates`,
 * or an insert keyed by a fixed id whose duplicate-key error the caller treats
 * as "already done" — a lost response can still mean the first attempt landed.
 */
export async function retryOnNetworkError<T extends { status: number }>(
  write: () => PromiseLike<T>,
  { attempts = 3, delayMs = 300 }: { attempts?: number; delayMs?: number } = {},
): Promise<T> {
  let res = await write();
  for (let attempt = 1; attempt < attempts && res.status === 0; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
    res = await write();
  }
  return res;
}
