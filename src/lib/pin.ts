// PIN hashing, verification and lockout.
//
// New hashes are `scrypt$<salt hex>$<hash hex>`. Legacy accounts hold an
// unsalted SHA-256 hex digest: it still verifies, and checkPin rehashes it on
// the next successful check. 5 wrong PINs lock the PIN for 15 minutes.
import { createHash, randomBytes, scrypt, timingSafeEqual } from "crypto";
import { supabaseAdmin } from "./supabase";

const SCRYPT_PREFIX = "scrypt$";
const KEY_LEN = 32;
const SALT_LEN = 16;

export const PIN_MAX_ATTEMPTS = 5;
export const PIN_LOCK_MS = 15 * 60 * 1000;

function scryptKey(pin: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(pin, salt, KEY_LEN, (err, key) => (err ? reject(err) : resolve(key)))
  );
}

const equalHex = (a: string, b: string) => {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length > 0 && x.length === y.length && timingSafeEqual(x, y);
};

export async function hashPin(pin: string): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const key = await scryptKey(pin, salt);
  return `${SCRYPT_PREFIX}${salt.toString("hex")}$${key.toString("hex")}`;
}

/** A hash that predates scrypt (and should be upgraded on the next success). */
export const isLegacyPinHash = (hash: string) => !hash.startsWith(SCRYPT_PREFIX);

export async function verifyPin(pin: string, hash: string): Promise<boolean> {
  if (isLegacyPinHash(hash)) {
    return equalHex(createHash("sha256").update(pin).digest("hex"), hash);
  }
  const [, saltHex, keyHex] = hash.split("$");
  if (!saltHex || !keyHex) return false;
  const key = await scryptKey(pin, Buffer.from(saltHex, "hex"));
  return equalHex(key.toString("hex"), keyHex);
}

// ─── Lockout ─────────────────────────────────────────────────────────

/** Seconds left on a lock, or 0 when not locked. */
export function lockRemainingSeconds(lockedUntil: string | null | undefined, now: Date = new Date()) {
  if (!lockedUntil) return 0;
  const ms = Date.parse(lockedUntil) - now.getTime();
  return ms > 0 ? Math.ceil(ms / 1000) : 0;
}

/** Counter state after a wrong PIN: locks (and restarts the count) on the 5th. */
export function afterFailure(failed: number, now: Date = new Date()) {
  const next = failed + 1;
  if (next >= PIN_MAX_ATTEMPTS) {
    return {
      pin_failed_attempts: 0,
      pin_locked_until: new Date(now.getTime() + PIN_LOCK_MS).toISOString(),
      locked: true as const,
    };
  }
  return { pin_failed_attempts: next, pin_locked_until: null, locked: false as const };
}

export interface PinUser {
  id: string;
  pin_hash?: string | null;
}

export type PinResult =
  | { ok: true }
  | { ok: false; reason: "not_set" }
  | { ok: false; reason: "invalid"; attempts_left: number }
  | { ok: false; reason: "locked"; retry_after: number };

/**
 * Check `pin` against the user's stored PIN, with lockout. Reads the counters
 * fresh (the auth middleware's user row may be stale). A wrong PIN is a 403
 * for the caller, never 401 (the app's 401 backstop signs the user out).
 */
export async function checkPin(user: PinUser, pin: string): Promise<PinResult> {
  const { data } = await supabaseAdmin
    .from("users")
    .select("pin_hash, pin_failed_attempts, pin_locked_until")
    .eq("id", user.id)
    .maybeSingle();
  const hash = data?.pin_hash ?? user.pin_hash;
  if (!hash) return { ok: false, reason: "not_set" };

  const now = new Date();
  const retry = lockRemainingSeconds(data?.pin_locked_until, now);
  if (retry > 0) return { ok: false, reason: "locked", retry_after: retry };

  const failed = Number(data?.pin_failed_attempts ?? 0);
  if (await verifyPin(pin, hash)) {
    const patch: Record<string, unknown> = {};
    if (failed > 0 || data?.pin_locked_until) {
      patch.pin_failed_attempts = 0;
      patch.pin_locked_until = null;
    }
    if (isLegacyPinHash(hash)) patch.pin_hash = await hashPin(pin);
    if (Object.keys(patch).length) {
      const { error } = await supabaseAdmin.from("users").update(patch).eq("id", user.id);
      if (error) console.error("[pin] counter/rehash update failed", error.message);
    }
    return { ok: true };
  }

  const next = afterFailure(failed, now);
  const { error } = await supabaseAdmin
    .from("users")
    .update({ pin_failed_attempts: next.pin_failed_attempts, pin_locked_until: next.pin_locked_until })
    .eq("id", user.id);
  if (error) console.error("[pin] failure counter update failed", error.message);
  if (next.locked) return { ok: false, reason: "locked", retry_after: Math.ceil(PIN_LOCK_MS / 1000) };
  return { ok: false, reason: "invalid", attempts_left: PIN_MAX_ATTEMPTS - next.pin_failed_attempts };
}

/** Clear the lockout (PIN setup replaces the PIN). */
export const PIN_UNLOCKED = { pin_failed_attempts: 0, pin_locked_until: null } as const;

/**
 * The 403 / 400 body for a failed check. A wrong PIN is 403, not 401: the app's
 * 401 backstop signs the user out. `invalid` carries no `code` (apps treat a
 * codeless 403 as a wrong PIN); a lock adds `code: pin_locked` and `retry_after`.
 */
export function pinFailureBody(r: Exclude<PinResult, { ok: true }>) {
  switch (r.reason) {
    case "not_set":
      return { status: 400 as const, body: { error: "PIN not set up" } };
    case "locked":
      return {
        status: 403 as const,
        body: { error: "PIN locked, try again later", code: "pin_locked" as const, retry_after: r.retry_after },
      };
    default:
      return { status: 403 as const, body: { error: "Invalid PIN" } };
  }
}
