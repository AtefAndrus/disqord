import { describe, expect, it } from "bun:test";
import { hmacSha256Hex, timingSafeEqualHex } from "../../src/http/hmac";

describe("hmac", () => {
  describe("hmacSha256Hex", () => {
    it("matches a known RFC 4231 test vector (key='Jefe', data='what do ya want for nothing?')", async () => {
      const result = await hmacSha256Hex("Jefe", "what do ya want for nothing?");
      expect(result).toBe("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
    });

    it("returns 64 lowercase hex characters", async () => {
      const result = await hmacSha256Hex("secret", "payload");
      expect(result).toMatch(/^[0-9a-f]{64}$/);
    });

    it("produces a different digest for a different message", async () => {
      const a = await hmacSha256Hex("secret", "a");
      const b = await hmacSha256Hex("secret", "b");
      expect(a).not.toBe(b);
    });

    it("produces a different digest for a different key", async () => {
      const a = await hmacSha256Hex("k1", "msg");
      const b = await hmacSha256Hex("k2", "msg");
      expect(a).not.toBe(b);
    });
  });

  describe("timingSafeEqualHex", () => {
    it("returns true for identical hex strings", () => {
      const hex = "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843";
      expect(timingSafeEqualHex(hex, hex)).toBe(true);
    });

    it("returns false for differing hex strings of equal length", () => {
      const a = "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843";
      const b = "0000000000000000000000000000000000000000000000000000000000000000";
      expect(timingSafeEqualHex(a, b)).toBe(false);
    });

    it("returns false when lengths differ", () => {
      expect(timingSafeEqualHex("abcd", "abcdef")).toBe(false);
    });

    it("returns false for empty strings", () => {
      expect(timingSafeEqualHex("", "")).toBe(false);
    });

    it("returns false for invalid hex without throwing", () => {
      expect(timingSafeEqualHex("zzzz", "zzzz")).toBe(false);
    });
  });
});
