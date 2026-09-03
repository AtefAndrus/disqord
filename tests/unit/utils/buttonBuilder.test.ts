import { describe, expect, it } from "bun:test";
import { ButtonStyle } from "discord.js";
import { createStopButton } from "../../../src/utils/buttonBuilder";

describe("createStopButton", () => {
  it("messageIdを含むcustomIdを設定する", () => {
    const button = createStopButton("message-123");

    expect("custom_id" in button.data && button.data.custom_id).toBe("stop_response_message-123");
  });

  it("ラベルに「停止」を設定する", () => {
    const button = createStopButton("message-123");

    expect("label" in button.data && button.data.label).toBe("停止");
  });

  it("Dangerスタイルを設定する", () => {
    const button = createStopButton("message-123");

    expect(button.data.style).toBe(ButtonStyle.Danger);
  });

  it("停止を表す絵文字を設定する", () => {
    const button = createStopButton("message-123");

    expect("emoji" in button.data && button.data.emoji?.name).toBe("🛑");
  });
});
