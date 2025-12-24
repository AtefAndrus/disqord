import { timingSafeEqual } from "node:crypto";
import type { GitHubReleasePayload } from "../types/github";
import { logger } from "../utils/logger";

/**
 * Verify GitHub Webhook signature using HMAC-SHA256.
 * Uses Web Crypto API for compatibility with Bun runtime.
 */
export async function verifyGitHubSignature(
  payload: string,
  signature: string,
  secret: string,
): Promise<boolean> {
  if (!signature.startsWith("sha256=")) {
    return false;
  }

  const expectedSignature = signature.slice(7); // Remove "sha256=" prefix

  try {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );

    const signatureBuffer = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));

    const computedSignature = Array.from(new Uint8Array(signatureBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    // Use timing-safe comparison to prevent timing attacks
    const expected = Buffer.from(expectedSignature, "hex");
    const computed = Buffer.from(computedSignature, "hex");

    if (expected.length !== computed.length) {
      return false;
    }

    return timingSafeEqual(expected, computed);
  } catch (error) {
    logger.error("Signature verification failed", { error });
    return false;
  }
}

/**
 * Parse and validate GitHub release webhook payload.
 */
export function parseReleasePayload(body: unknown): GitHubReleasePayload | null {
  if (!body || typeof body !== "object") {
    return null;
  }

  const payload = body as Record<string, unknown>;

  // Validate required fields
  if (typeof payload.action !== "string") {
    return null;
  }

  if (!payload.release || typeof payload.release !== "object") {
    return null;
  }

  if (!payload.repository || typeof payload.repository !== "object") {
    return null;
  }

  return payload as unknown as GitHubReleasePayload;
}
