import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { logger } from "../../../src/utils/logger";

class DiscordApiError extends Error {
  readonly code = 50035;
  readonly status = 400;
  readonly requestBody = { json: { components: ["SECRET-REPLY-TEXT"] } };
  readonly rawError = { message: "raw error" };
  readonly stack = "secret stack";
  readonly url = "https://discord.example.invalid";
  readonly method = "POST";
  readonly cause = new Error("secret cause");

  constructor() {
    super("invalid form body");
    this.name = "DiscordAPIError";
  }
}

describe("logger", () => {
  let debugSpy: ReturnType<typeof spyOn>;
  let infoSpy: ReturnType<typeof spyOn>;
  let warnSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    debugSpy = spyOn(console, "debug").mockImplementation(() => {});
    infoSpy = spyOn(console, "info").mockImplementation(() => {});
    warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    debugSpy.mockRestore();
    infoSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  describe("debug", () => {
    test("メッセージのみでconsole.debugを呼び出す", () => {
      logger.debug("Test debug message");

      expect(debugSpy).toHaveBeenCalledTimes(1);
      const logOutput = debugSpy.mock.calls[0][0] as string;
      expect(logOutput).toContain("[DEBUG]");
      expect(logOutput).toContain("Test debug message");
    });

    test("メタデータ付きでJSON形式で出力する", () => {
      logger.debug("Debug with meta", { key: "value" });

      expect(debugSpy).toHaveBeenCalledTimes(1);
      const logOutput = debugSpy.mock.calls[0][0] as string;
      expect(logOutput).toContain('{"key":"value"}');
    });
  });

  describe("info", () => {
    test("INFOレベルでconsole.infoを呼び出す", () => {
      logger.info("Test info message");

      expect(infoSpy).toHaveBeenCalledTimes(1);
      const logOutput = infoSpy.mock.calls[0][0] as string;
      expect(logOutput).toContain("[INFO]");
      expect(logOutput).toContain("Test info message");
    });
  });

  describe("warn", () => {
    test("WARNレベルでconsole.warnを呼び出す", () => {
      logger.warn("Test warn message");

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const logOutput = warnSpy.mock.calls[0][0] as string;
      expect(logOutput).toContain("[WARN]");
      expect(logOutput).toContain("Test warn message");
    });
  });

  describe("error", () => {
    test("ERRORレベルでconsole.errorを呼び出す", () => {
      logger.error("Test error message");

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const logOutput = errorSpy.mock.calls[0][0] as string;
      expect(logOutput).toContain("[ERROR]");
      expect(logOutput).toContain("Test error message");
    });

    test("Errorオブジェクトをメタデータとして渡せる", () => {
      const error = new Error("Something went wrong");
      logger.error("An error occurred", error);

      expect(errorSpy).toHaveBeenCalledTimes(1);
    });

    test("Errorのメタデータは安全なフィールドだけをトップレベルとネスト先で出力する", () => {
      const error = new DiscordApiError();
      logger.warn("Warning with error", { error });
      logger.error("Error with nested error", { details: { error } });

      const outputs = [warnSpy.mock.calls[0][0], errorSpy.mock.calls[0][0]] as string[];
      for (const output of outputs) {
        expect(output).toContain("DiscordAPIError");
        expect(output).toContain("invalid form body");
        expect(output).toContain("50035");
        expect(output).toContain("400");
        expect(output).not.toContain("SECRET-REPLY-TEXT");
      }
      expect(outputs.join("\n")).not.toContain("secret stack");
      expect(outputs.join("\n")).not.toContain("secret cause");
      expect(outputs.join("\n")).not.toContain("discord.example.invalid");
      expect(outputs.join("\n")).not.toContain("POST");
    });

    test("Error以外のメタデータはそのままJSON化する", () => {
      logger.error("Structured metadata", { nested: { value: "kept" }, list: [1, 2] });

      const logOutput = errorSpy.mock.calls[0][0] as string;
      expect(logOutput).toContain('{"nested":{"value":"kept"},"list":[1,2]}');
    });
  });

  describe("timestamp format", () => {
    test("ISO 8601形式のタイムスタンプを含む", () => {
      logger.info("Timestamp test");

      const logOutput = infoSpy.mock.calls[0][0] as string;
      const iso8601Regex = /\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z\]/;
      expect(logOutput).toMatch(iso8601Regex);
    });
  });
});
