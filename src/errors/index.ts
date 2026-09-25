/**
 * Application error classes for user-friendly error handling.
 *
 * Each error class provides:
 * - `message`: Technical message for logging
 * - `userMessage`: User-friendly message for display
 * - `statusCode`: HTTP status code (optional)
 */

export class AppError extends Error {
  constructor(
    message: string,
    public readonly userMessage: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class RateLimitError extends AppError {
  constructor(message: string, retryAfterSeconds?: number) {
    const userMessage =
      retryAfterSeconds !== undefined
        ? `リクエスト制限に達しました。${retryAfterSeconds}秒後に再度お試しください。`
        : "リクエスト制限に達しました。しばらくしてから再度お試しください。";
    super(message, userMessage, 429);
  }
}

export class InsufficientCreditsError extends AppError {
  constructor(message: string) {
    super(message, "API残高が不足しています。管理者にお問い合わせください。", 402);
  }
}

export class ModerationError extends AppError {
  constructor(message: string) {
    super(message, "入力内容が制限されました。表現を変えてお試しください。", 403);
  }
}

export class InvalidModelError extends AppError {
  constructor(message: string) {
    super(
      message,
      "指定されたモデルは存在しません。`/disqord model set`で有効なモデルを設定してください。",
      400,
    );
  }
}

export class ModelUnavailableError extends AppError {
  constructor(message: string, statusCode: 500 | 502 | 503 = 502) {
    super(
      message,
      "モデルが一時的に利用できません。しばらくしてから再度お試しください。",
      statusCode,
    );
  }
}

export class AuthenticationError extends AppError {
  constructor(message: string) {
    super(message, "Botの設定に問題があります。管理者にお問い合わせください。", 401);
  }
}

export class TimeoutError extends AppError {
  constructor(message: string) {
    super(message, "応答に時間がかかりすぎています。短いメッセージでお試しください。", 408);
  }
}

export class BadRequestError extends AppError {
  constructor(message: string) {
    super(message, "リクエストに問題があります。入力内容を確認してください。", 400);
  }
}

export class UnknownApiError extends AppError {
  constructor(message: string, statusCode?: number) {
    super(
      message,
      "予期しないエラーが発生しました。問題が続く場合は管理者にお問い合わせください。",
      statusCode,
    );
  }
}

/**
 * OpenRouter's `openrouter:web_search` server tool failed and ended the
 * stream. The query the model chose decides whether it happens, so it is
 * intermittent rather than a fault in the request as a whole.
 */
export class WebSearchFailedError extends AppError {
  constructor(message: string) {
    super(
      message,
      "Web 検索に失敗したため回答できませんでした。もう一度試すか、質問の書き方を変えてください。",
      502,
    );
  }
}

export class ConfigurationError extends AppError {
  constructor(message: string, configUrl?: string) {
    const userMessage = configUrl
      ? `OpenRouterの設定に問題があります。\n${configUrl}\nで設定を確認してください。`
      : "OpenRouterの設定に問題があります。管理者にお問い合わせください。";
    super(message, userMessage, 400);
  }
}

/**
 * Raised when the OpenRouter SSE stream violates the expected wire protocol:
 * malformed `data:` JSON, an oversized frame/carry buffer, a finish_reason
 * mismatch between choice and delta, or content/tool_call deltas received
 * after the terminal finish_reason has already been observed.
 */
export class StreamProtocolError extends AppError {
  constructor(message: string) {
    super(
      message,
      "応答ストリームの処理中にエラーが発生しました。しばらくしてから再度お試しください。",
    );
  }
}

/**
 * Raised by the client tool-calling loop (`runToolLoop`) when the model or
 * transport violates a client-tool-calling protocol invariant: all
 * accumulated tool calls were dropped for missing `function.name`, zero
 * calls survived normalization, tool_call fragments arrived alongside a
 * `stop`/`length`/`content_filter` finish_reason (preamble treated as
 * final), the last allowed turn produced `tool_calls` despite
 * `tool_choice:"none"`, the stream ended without a terminal finish_reason
 * (disconnect), the model returned an empty response (no content, no tool
 * calls), an unknown finish_reason was received, or a turn's accumulation
 * guardrails (distinct call count / byte budget) were exceeded.
 */
export class ToolProtocolError extends AppError {
  constructor(message: string) {
    super(
      message,
      "ツール呼び出しの処理中に問題が発生しました。しばらくしてから再度お試しください。",
    );
  }
}

/**
 * A settings change was validated against a model that another operation
 * replaced before the change was saved. Retrying against the current
 * settings is the fix, so the message asks for that.
 */
export class SettingsConflictError extends AppError {
  constructor(message: string) {
    super(
      message,
      "確認中に別の操作でモデルの設定が変わりました。現在の設定を確認して、もう一度操作してください。",
      409,
    );
  }
}

/**
 * A settings change breaks a rule against the settings as saved (a paid
 * model while free-only is on). Retrying does not help; `userMessage` says
 * what to change first.
 */
export class SettingsRuleError extends AppError {
  constructor(message: string, userMessage: string) {
    super(message, userMessage, 409);
  }
}

/**
 * A settings change the bot refused because of what the user asked for or a
 * concurrent edit, not because anything failed. Callers log it as a warning.
 */
export function isSettingsRejection(
  error: unknown,
): error is SettingsConflictError | SettingsRuleError {
  return error instanceof SettingsConflictError || error instanceof SettingsRuleError;
}
