import type { GitHubReleasePayload } from "../types/github";
import { logger } from "../utils/logger";
import { hmacSha256Hex, timingSafeEqualHex } from "./hmac";

/**
 * Verify GitHub Webhook signature using HMAC-SHA256.
 * Delegates the HMAC computation and timing-safe comparison to the shared
 * helper in `./hmac` so the same primitive is reused by the admin API.
 */
export async function verifyGitHubSignature(
  payload: string,
  signature: string,
  secret: string,
): Promise<boolean> {
  if (!signature.startsWith("sha256=")) {
    return false;
  }

  const expectedSignature = signature.slice(7);

  try {
    const computedSignature = await hmacSha256Hex(secret, payload);
    return timingSafeEqualHex(expectedSignature, computedSignature);
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
