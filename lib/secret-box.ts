import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ensureDataDir } from "./paths";

const SALT = "newapi-login-token-v1";

function loadKey(): Buffer {
  const fromEnv = process.env.TOKEN_ENCRYPTION_KEY?.trim();
  if (fromEnv) return scryptSync(fromEnv, SALT, 32);
  const file = path.join(ensureDataDir(), "token.key");
  if (existsSync(file)) return scryptSync(readFileSync(file, "utf8").trim(), SALT, 32);
  const created = randomBytes(32).toString("base64url");
  writeFileSync(file, created, { mode: 0o600 });
  return scryptSync(created, SALT, 32);
}

let cached: Buffer | null = null;

function key(): Buffer {
  if (!cached) cached = loadKey();
  return cached;
}

/** AES-256-GCM ciphertext. The plaintext token is never written to the database. */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), data.toString("base64url")].join(".");
}

export function decryptSecret(packed: string): string {
  const [version, ivPart, tagPart, dataPart] = packed.split(".");
  if (version !== "v1" || !ivPart || !tagPart || !dataPart) throw new Error("密钥格式无法识别");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(ivPart, "base64url"));
  decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
  const plain = Buffer.concat([decipher.update(Buffer.from(dataPart, "base64url")), decipher.final()]);
  return plain.toString("utf8");
}

export function resetSecretKeyForTests(): void {
  cached = null;
}
