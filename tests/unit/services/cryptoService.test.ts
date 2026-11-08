import { describe, expect, test } from "bun:test";
import { CryptoService } from "../../../src/services/cryptoService";

describe("CryptoService", () => {
  test("round trips with a fresh IV and authenticates owner and scope", () => {
    const crypto = new CryptoService("12".repeat(32));
    const a = crypto.encrypt("fixture", "user:one");
    const b = crypto.encrypt("fixture", "user:one");
    expect(a.iv).not.toBe(b.iv);
    expect(Buffer.from(a.iv, "base64")).toHaveLength(12);
    expect(crypto.decrypt(a.ciphertext, a.iv, a.authTag, "user:one")).toBe("fixture");
    for (const aad of ["user:two", "guild:one"])
      expect(() => crypto.decrypt(a.ciphertext, a.iv, a.authTag, aad)).toThrow();
    expect(() =>
      new CryptoService("34".repeat(32)).decrypt(a.ciphertext, a.iv, a.authTag, "user:one"),
    ).toThrow();
    expect(() => crypto.decrypt(b.ciphertext, b.iv, a.authTag, "user:one")).toThrow();
  });
  test.each(["", "12", "gg".repeat(32)])("rejects malformed encryption key %s", (key) => {
    expect(() => new CryptoService(key)).toThrow("ENCRYPTION_KEY");
  });
});
