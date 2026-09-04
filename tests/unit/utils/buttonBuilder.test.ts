import { describe, expect, it } from "bun:test";
import { ButtonStyle, ComponentType } from "discord.js";
import { createStopButton } from "../../../src/utils/buttonBuilder";

// Discord から実際に渡る messageId は snowflake なので、フィクスチャも snowflake 形式にする。
const MESSAGE_ID = "1234567890123456789";

describe("createStopButton", () => {
  // toJSON() は discord.js の妥当性検証を通るため、内部状態の data ではなくこちらを検証する。
  // 全体一致にすることで、意図しないフィールドの追加や絵文字のカスタム絵文字への差し替えも検出できる。
  // customId の復元側 (src/bot/events/interactionCreate.ts) は本テストの対象外で、生成側の構造のみを固定する。
  it("Section accessory として使える停止ボタンのJSONを生成する", () => {
    const button = createStopButton(MESSAGE_ID);

    expect(button.toJSON()).toEqual({
      type: ComponentType.Button,
      custom_id: `stop_response_${MESSAGE_ID}`,
      label: "停止",
      style: ButtonStyle.Danger,
      emoji: { name: "🛑", animated: false },
    });
  });
});
