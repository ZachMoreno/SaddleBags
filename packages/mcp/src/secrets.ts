import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Encrypts MCP credentials at rest with AES-256-GCM.
 *
 * The key comes from `SADDLEBAGS_SECRET_KEY`: 32 bytes as 64 hex characters
 * or base64 (`openssl rand -hex 32`). Each ciphertext is bound to its
 * connection through additional authenticated data, so a ciphertext copied
 * to another connection's row fails to decrypt.
 */
export class Secrets {
  private key: Buffer;

  constructor(key: string) {
    this.key = parseKey(key);
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): Secrets | undefined {
    const key = env.SADDLEBAGS_SECRET_KEY;
    return key ? new Secrets(key) : undefined;
  }

  encrypt(plaintext: string, aad: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), ct.toString("base64")].join(":");
  }

  decrypt(sealed: string, aad: string): string {
    const [version, iv, tag, ct] = sealed.split(":");
    if (version !== "v1" || !iv || !tag || ct === undefined) throw new Error("Unrecognized credential format");
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64"));
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    try {
      return Buffer.concat([decipher.update(Buffer.from(ct, "base64")), decipher.final()]).toString("utf8");
    } catch {
      throw new Error("Credential could not be decrypted (wrong SADDLEBAGS_SECRET_KEY, or the row was altered)");
    }
  }
}

function parseKey(key: string): Buffer {
  const k = key.trim();
  const buf = /^[0-9a-f]{64}$/i.test(k) ? Buffer.from(k, "hex") : Buffer.from(k, "base64");
  if (buf.length !== 32) {
    throw new Error("SADDLEBAGS_SECRET_KEY must be 32 bytes, as 64 hex characters or base64 (openssl rand -hex 32)");
  }
  return buf;
}

/** sha256 of canonical JSON (object keys sorted), hex. */
export function hashJson(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => x !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}
