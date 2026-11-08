import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export interface ICryptoService {
  encrypt(plaintext: string, aad: string): { ciphertext: string; iv: string; authTag: string };
  decrypt(ciphertext: string, iv: string, authTag: string, aad: string): string;
}

export class CryptoService implements ICryptoService {
  private readonly key: Buffer;
  constructor(hexKey: string) {
    if (!/^[a-fA-F0-9]{64}$/.test(hexKey))
      throw new Error("ENCRYPTION_KEY must be 64 hex characters");
    this.key = Buffer.from(hexKey, "hex");
  }
  encrypt(plaintext: string, aad: string): { ciphertext: string; iv: string; authTag: string } {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(aad));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return {
      ciphertext: ciphertext.toString("base64"),
      iv: iv.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
    };
  }
  decrypt(ciphertext: string, iv: string, authTag: string, aad: string): string {
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64"));
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(Buffer.from(authTag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
  }
}
