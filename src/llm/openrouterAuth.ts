import { AppError } from "../errors";
import { logger } from "../utils/logger";
import { OPENROUTER_APP_TITLE, OPENROUTER_APP_URL, OPENROUTER_BASE_URL } from "./openrouter";

export class OAuthError extends AppError {
  constructor(status?: number) {
    super(
      "OpenRouter connection failed",
      "接続できませんでした。`/connect` からやり直してください。",
      status,
    );
  }
}
export interface KeyInfo {
  limit_remaining: number | null;
  expires_at?: string | null;
}
const HEADERS = { "HTTP-Referer": OPENROUTER_APP_URL, "X-OpenRouter-Title": OPENROUTER_APP_TITLE };

export function buildAuthorizationUrl(
  challenge: string,
  callbackUrl?: string,
  state?: string,
): string {
  const url = new URL("https://openrouter.ai/auth");
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("key_label", "DisQord");
  if (callbackUrl) url.searchParams.set("callback_url", callbackUrl);
  if (state) url.searchParams.set("state", state);
  return url.toString();
}
export async function exchangeCode(code: string, verifier: string): Promise<string> {
  try {
    const response = await fetch(`${OPENROUTER_BASE_URL}/auth/keys`, {
      method: "POST",
      headers: { ...HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: "S256" }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new OAuthError(response.status);
    }
    const body: unknown = await response.json();
    if (
      typeof body !== "object" ||
      body === null ||
      !("key" in body) ||
      typeof body.key !== "string" ||
      !body.key
    )
      throw new OAuthError();
    return body.key;
  } catch (error) {
    logger.warn("OpenRouter connection request failed", {
      stage: "exchange",
      status: error instanceof OAuthError ? error.statusCode : undefined,
      errorType:
        error instanceof OAuthError
          ? "OAuthError"
          : error instanceof Error
            ? "Error"
            : typeof error,
    });
    throw error instanceof OAuthError ? error : new OAuthError();
  }
}
export async function getKeyInfo(key: string): Promise<KeyInfo> {
  try {
    const response = await fetch(`${OPENROUTER_BASE_URL}/key`, {
      headers: { ...HEADERS, Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new OAuthError(response.status);
    const body: unknown = await response.json();
    if (
      typeof body !== "object" ||
      body === null ||
      !("data" in body) ||
      typeof body.data !== "object" ||
      body.data === null ||
      !("limit_remaining" in body.data) ||
      (body.data.limit_remaining !== null && typeof body.data.limit_remaining !== "number")
    )
      throw new OAuthError();
    return body.data as KeyInfo;
  } catch (error) {
    logger.warn("OpenRouter connection request failed", {
      stage: "key_info",
      status: error instanceof OAuthError ? error.statusCode : undefined,
      errorType:
        error instanceof OAuthError
          ? "OAuthError"
          : error instanceof Error
            ? "Error"
            : typeof error,
    });
    throw error instanceof OAuthError ? error : new OAuthError();
  }
}
export function formatKeyBalance(info: KeyInfo | null): string {
  if (!info) return "取得できません";
  return info.limit_remaining === null
    ? "上限なし（アカウントのクレジットは OpenRouter で確認してください）"
    : `キーの上限までの残額 $${info.limit_remaining.toFixed(2)}`;
}
