import type { CallbackOutcome, IApiKeyService } from "../services/apiKeyService";

const TEXT: Record<CallbackOutcome, string> = {
  connected: "OpenRouter アカウントを接続しました。Discord に戻ってください。",
  invalid: "接続の要求を確認できません。Discord の /connect からやり直してください。",
  already_used: "この接続の要求は処理済みです。Discord で結果を確認してください。",
  failed: "接続できませんでした。Discord の /connect からやり直してください。",
};
export function createOAuthCallbackHandler(
  service: IApiKeyService,
): (request: Request) => Promise<Response> {
  return async (request): Promise<Response> => {
    const url = new URL(request.url);
    const outcome = await service.completeCallback(
      url.searchParams.get("state"),
      url.searchParams.get("code"),
    );
    return new Response(
      `<!doctype html><html lang="ja"><meta charset="utf-8"><title>OpenRouter 接続</title><p>${TEXT[outcome]}</p></html>`,
      {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
          "Content-Security-Policy": "default-src 'none'",
        },
      },
    );
  };
}
