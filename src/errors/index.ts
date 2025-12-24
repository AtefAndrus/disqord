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
