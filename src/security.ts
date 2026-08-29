import { randomBytes, createCipheriv, createDecipheriv, createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import path from "node:path";

const AAD = Buffer.from("scholarship-agent-app:v1");

export function loadOrCreateLocalKey(baseDir: string): Buffer {
  const localDir = path.join(baseDir, ".local");
  const keyPath = path.join(localDir, "secret.key");
  if (!existsSync(localDir)) {
    mkdirSync(localDir, { recursive: true });
  }

  if (!existsSync(keyPath)) {
    const key = randomBytes(32).toString("base64");
    writeFileSync(keyPath, key, { encoding: "utf8", mode: 0o600 });
    try {
      chmodSync(keyPath, 0o600);
    } catch {
      // Best-effort on file systems that do not support chmod.
    }
  }

  const encoded = readFileSync(keyPath, "utf8").trim();
  const raw = Buffer.from(encoded, "base64");
  if (raw.length === 32) return raw;

  return createHash("sha256").update(encoded).digest();
}

export function encryptJson(value: unknown, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(AAD);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    v: 1,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    data: ciphertext.toString("base64")
  });
}

export function decryptJson<T>(payload: string, key: Buffer): T {
  const parsed = JSON.parse(payload);
  const iv = Buffer.from(parsed.iv, "base64");
  const tag = Buffer.from(parsed.tag, "base64");
  const ciphertext = Buffer.from(parsed.data, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(AAD);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8")) as T;
}
