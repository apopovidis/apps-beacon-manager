import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/** scrypt with a fresh random salt per password — a recognized password
 * hashing KDF, avoids adding bcrypt as a new dependency. Stored format is
 * "saltHex.hashHex" so verification never needs a second input to know the
 * salt used. */
export function hashPassword(plain: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(plain, salt, 64);
  return `${salt.toString("hex")}.${hash.toString("hex")}`;
}

export function verifyPassword(plain: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(".");
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(plain, salt, 64);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
