import { describe, expect, it } from "bun:test";
import {
  AppError,
  AuthenticationError,
  BadRequestError,
  InsufficientCreditsError,
  InvalidModelError,
  ModelUnavailableError,
  ModerationError,
  RateLimitError,
  TimeoutError,
  UnknownApiError,
} from "../../src/errors";

describe("AppError", () => {
  it("should create an error with message and userMessage", () => {
    const error = new AppError("Technical error", "User friendly message", 500);

    expect(error.message).toBe("Technical error");
    expect(error.userMessage).toBe("User friendly message");
    expect(error.statusCode).toBe(500);
    expect(error.name).toBe("AppError");
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(AppError);
  });

  it("should work without statusCode", () => {
    const error = new AppError("Technical error", "User friendly message");

    expect(error.statusCode).toBeUndefined();
  });
});

describe("RateLimitError", () => {
  it("should include retry seconds in userMessage", () => {
    const error = new RateLimitError("Rate limited by API", 30);

    expect(error.message).toBe("Rate limited by API");
    expect(error.userMessage).toBe("リクエスト制限に達しました。30秒後に再度お試しください。");
    expect(error.statusCode).toBe(429);
    expect(error.name).toBe("RateLimitError");
    expect(error).toBeInstanceOf(AppError);
  });

  it("should use generic message when retry seconds not provided", () => {
    const error = new RateLimitError("Rate limited by API");

    expect(error.userMessage).toBe(
      "リクエスト制限に達しました。しばらくしてから再度お試しください。",
    );
  });

  it("should handle 0 seconds", () => {
    const error = new RateLimitError("Rate limited", 0);

    expect(error.userMessage).toBe("リクエスト制限に達しました。0秒後に再度お試しください。");
  });
});

describe("InsufficientCreditsError", () => {
  it("should have correct properties", () => {
    const error = new InsufficientCreditsError("No credits remaining");

    expect(error.message).toBe("No credits remaining");
    expect(error.userMessage).toBe("API残高が不足しています。管理者にお問い合わせください。");
    expect(error.statusCode).toBe(402);
    expect(error.name).toBe("InsufficientCreditsError");
    expect(error).toBeInstanceOf(AppError);
  });
});

describe("ModerationError", () => {
  it("should have correct properties", () => {
    const error = new ModerationError("Content flagged");

    expect(error.message).toBe("Content flagged");
    expect(error.userMessage).toBe("入力内容が制限されました。表現を変えてお試しください。");
    expect(error.statusCode).toBe(403);
    expect(error.name).toBe("ModerationError");
    expect(error).toBeInstanceOf(AppError);
  });
});

describe("InvalidModelError", () => {
  it("should have correct properties", () => {
    const error = new InvalidModelError("nonexistent/model is not a valid model ID");

    expect(error.message).toBe("nonexistent/model is not a valid model ID");
    expect(error.userMessage).toBe(
      "指定されたモデルは存在しません。`/disqord model set`で有効なモデルを設定してください。",
    );
    expect(error.statusCode).toBe(400);
    expect(error.name).toBe("InvalidModelError");
    expect(error).toBeInstanceOf(AppError);
  });
});

describe("ModelUnavailableError", () => {
  it("should default to 502 status code", () => {
    const error = new ModelUnavailableError("Model is down");

    expect(error.message).toBe("Model is down");
    expect(error.userMessage).toBe(
      "モデルが一時的に利用できません。しばらくしてから再度お試しください。",
    );
    expect(error.statusCode).toBe(502);
    expect(error.name).toBe("ModelUnavailableError");
    expect(error).toBeInstanceOf(AppError);
  });

  it("should accept 500 status code", () => {
    const error = new ModelUnavailableError("Internal Server Error", 500);

    expect(error.statusCode).toBe(500);
  });

  it("should accept 503 status code", () => {
    const error = new ModelUnavailableError("No provider available", 503);

    expect(error.statusCode).toBe(503);
  });
});

describe("AuthenticationError", () => {
  it("should have correct properties", () => {
    const error = new AuthenticationError("Invalid API key");

    expect(error.message).toBe("Invalid API key");
    expect(error.userMessage).toBe("Botの設定に問題があります。管理者にお問い合わせください。");
    expect(error.statusCode).toBe(401);
    expect(error.name).toBe("AuthenticationError");
    expect(error).toBeInstanceOf(AppError);
  });
});

describe("TimeoutError", () => {
  it("should have correct properties", () => {
    const error = new TimeoutError("Request timed out");

    expect(error.message).toBe("Request timed out");
    expect(error.userMessage).toBe(
      "応答に時間がかかりすぎています。短いメッセージでお試しください。",
    );
    expect(error.statusCode).toBe(408);
    expect(error.name).toBe("TimeoutError");
    expect(error).toBeInstanceOf(AppError);
  });
});

describe("BadRequestError", () => {
  it("should have correct properties", () => {
    const error = new BadRequestError("Invalid parameters");

    expect(error.message).toBe("Invalid parameters");
    expect(error.userMessage).toBe("リクエストに問題があります。入力内容を確認してください。");
    expect(error.statusCode).toBe(400);
    expect(error.name).toBe("BadRequestError");
    expect(error).toBeInstanceOf(AppError);
  });
});

describe("UnknownApiError", () => {
  it("should have correct properties with status code", () => {
    const error = new UnknownApiError("Unknown error occurred", 599);

    expect(error.message).toBe("Unknown error occurred");
    expect(error.userMessage).toBe(
      "予期しないエラーが発生しました。問題が続く場合は管理者にお問い合わせください。",
    );
    expect(error.statusCode).toBe(599);
    expect(error.name).toBe("UnknownApiError");
    expect(error).toBeInstanceOf(AppError);
  });

  it("should work without status code", () => {
    const error = new UnknownApiError("Unknown error");

    expect(error.statusCode).toBeUndefined();
  });
});
