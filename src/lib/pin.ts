import { createHash } from "crypto";

export async function hashPin(pin: string): Promise<string> {
  return createHash("sha256").update(pin).digest("hex");
}

export async function verifyPin(pin: string, hash: string): Promise<boolean> {
  const inputHash = await hashPin(pin);
  return inputHash === hash;
}
