import { describe, expect, it } from "bun:test";
import { parseReleasePayload, verifyGitHubSignature } from "../../src/http/webhookHandler";

describe("webhookHandler", () => {
  describe("verifyGitHubSignature", () => {
    const secret = "test-secret";

    it("should return true for valid signature", async () => {
      const payload = '{"action":"released"}';

      // Compute HMAC-SHA256 signature
      const encoder = new TextEncoder();
      const key = await crypto.subtle.importKey(
        "raw",
        encoder.encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const signatureBuffer = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
      const computedSignature =
        "sha256=" +
        Array.from(new Uint8Array(signatureBuffer))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");

      const result = await verifyGitHubSignature(payload, computedSignature, secret);
      expect(result).toBe(true);
    });

    it("should return false for invalid signature", async () => {
      const payload = '{"action":"released"}';
      const invalidSignature =
        "sha256=0000000000000000000000000000000000000000000000000000000000000000";

      const result = await verifyGitHubSignature(payload, invalidSignature, secret);
      expect(result).toBe(false);
    });

    it("should return false for signature without sha256= prefix", async () => {
      const payload = '{"action":"released"}';
      const noPrefix = "abc123";

      const result = await verifyGitHubSignature(payload, noPrefix, secret);
      expect(result).toBe(false);
    });

    it("should return false for tampered payload", async () => {
      const originalPayload = '{"action":"released"}';
      const tamperedPayload = '{"action":"published"}';

      // Compute signature for original payload
      const encoder = new TextEncoder();
      const key = await crypto.subtle.importKey(
        "raw",
        encoder.encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const signatureBuffer = await crypto.subtle.sign(
        "HMAC",
        key,
        encoder.encode(originalPayload),
      );
      const signature =
        "sha256=" +
        Array.from(new Uint8Array(signatureBuffer))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");

      // Verify with tampered payload - should fail
      const result = await verifyGitHubSignature(tamperedPayload, signature, secret);
      expect(result).toBe(false);
    });
  });

  describe("parseReleasePayload", () => {
    it("should parse valid release payload", () => {
      const payload = {
        action: "released",
        release: {
          id: 123,
          tag_name: "v1.0.0",
          name: "Release 1.0.0",
          body: "Release notes",
          html_url: "https://github.com/test/repo/releases/tag/v1.0.0",
          prerelease: false,
          draft: false,
          created_at: "2025-01-01T00:00:00Z",
          published_at: "2025-01-01T00:00:00Z",
          author: {
            login: "testuser",
            avatar_url: "https://example.com/avatar.png",
          },
        },
        repository: {
          id: 456,
          name: "repo",
          full_name: "test/repo",
          html_url: "https://github.com/test/repo",
        },
        sender: {
          login: "testuser",
          avatar_url: "https://example.com/avatar.png",
        },
      };

      const result = parseReleasePayload(payload);
      expect(result).not.toBeNull();
      expect(result?.action).toBe("released");
      expect(result?.release.tag_name).toBe("v1.0.0");
      expect(result?.repository.full_name).toBe("test/repo");
    });

    it("should return null for null input", () => {
      const result = parseReleasePayload(null);
      expect(result).toBeNull();
    });

    it("should return null for non-object input", () => {
      const result = parseReleasePayload("string");
      expect(result).toBeNull();
    });

    it("should return null for missing action", () => {
      const payload = {
        release: { tag_name: "v1.0.0" },
        repository: { full_name: "test/repo" },
      };
      const result = parseReleasePayload(payload);
      expect(result).toBeNull();
    });

    it("should return null for missing release", () => {
      const payload = {
        action: "released",
        repository: { full_name: "test/repo" },
      };
      const result = parseReleasePayload(payload);
      expect(result).toBeNull();
    });

    it("should return null for missing repository", () => {
      const payload = {
        action: "released",
        release: { tag_name: "v1.0.0" },
      };
      const result = parseReleasePayload(payload);
      expect(result).toBeNull();
    });
  });
});
