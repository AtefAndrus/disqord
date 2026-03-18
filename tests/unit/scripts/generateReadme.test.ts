import { describe, expect, test } from "bun:test";
import type { RESTPostAPIChatInputApplicationCommandsJSONBody } from "discord.js";
import { ApplicationCommandOptionType } from "discord.js";
import {
  generateCommandTable,
  generateRequirements,
  replaceMarkerSection,
} from "../../../scripts/generate-readme";

describe("generateCommandTable", () => {
  test("サブコマンドなしのコマンド", () => {
    const commands: RESTPostAPIChatInputApplicationCommandsJSONBody[] = [
      { name: "help", description: "ヘルプを表示" },
    ];
    const result = generateCommandTable(commands);
    expect(result).toContain("| `/help` | ヘルプを表示 |");
  });

  test("サブコマンド付きのコマンド", () => {
    const commands: RESTPostAPIChatInputApplicationCommandsJSONBody[] = [
      {
        name: "model",
        description: "モデル管理",
        options: [
          {
            type: ApplicationCommandOptionType.Subcommand,
            name: "current",
            description: "現在のモデルを表示",
          },
          {
            type: ApplicationCommandOptionType.Subcommand,
            name: "set",
            description: "モデルを変更",
            options: [
              {
                type: ApplicationCommandOptionType.String,
                name: "model",
                description: "モデルID",
                required: true,
              },
            ],
          },
        ],
      },
    ];
    const result = generateCommandTable(commands);
    expect(result).toContain("| `/model current` | 現在のモデルを表示 |");
    expect(result).toContain("| `/model set <model>` | モデルを変更 |");
  });

  test("サブコマンドグループ付きのコマンド", () => {
    const commands: RESTPostAPIChatInputApplicationCommandsJSONBody[] = [
      {
        name: "config",
        description: "設定管理",
        options: [
          {
            type: ApplicationCommandOptionType.SubcommandGroup,
            name: "auto-reply",
            description: "自動応答設定",
            options: [
              {
                type: ApplicationCommandOptionType.Subcommand,
                name: "add",
                description: "チャンネルを追加",
                options: [
                  {
                    type: ApplicationCommandOptionType.Channel,
                    name: "channel",
                    description: "チャンネル",
                    required: true,
                  },
                ],
              },
              {
                type: ApplicationCommandOptionType.Subcommand,
                name: "list",
                description: "一覧を表示",
              },
            ],
          },
        ],
      },
    ];
    const result = generateCommandTable(commands);
    expect(result).toContain("| `/config auto-reply add <channel>` | チャンネルを追加 |");
    expect(result).toContain("| `/config auto-reply list` | 一覧を表示 |");
  });

  test("オプションが任意の場合は角括弧で表示", () => {
    const commands: RESTPostAPIChatInputApplicationCommandsJSONBody[] = [
      {
        name: "config",
        description: "設定",
        options: [
          {
            type: ApplicationCommandOptionType.Subcommand,
            name: "release-channel",
            description: "通知チャンネルを設定",
            options: [
              {
                type: ApplicationCommandOptionType.Channel,
                name: "channel",
                description: "チャンネル",
                required: false,
              },
            ],
          },
        ],
      },
    ];
    const result = generateCommandTable(commands);
    expect(result).toContain("| `/config release-channel [channel]` | 通知チャンネルを設定 |");
  });

  test("テーブルヘッダーが含まれる", () => {
    const commands: RESTPostAPIChatInputApplicationCommandsJSONBody[] = [
      { name: "help", description: "ヘルプ" },
    ];
    const result = generateCommandTable(commands);
    expect(result).toStartWith("| コマンド | 説明 |\n| -------- | ---- |");
  });

  test("複数コマンドの順序が保持される", () => {
    const commands: RESTPostAPIChatInputApplicationCommandsJSONBody[] = [
      { name: "help", description: "ヘルプ" },
      { name: "status", description: "ステータス" },
    ];
    const result = generateCommandTable(commands);
    const helpIdx = result.indexOf("/help");
    const statusIdx = result.indexOf("/status");
    expect(helpIdx).toBeLessThan(statusIdx);
  });
});

describe("generateRequirements", () => {
  test("Bunバージョンを含む", () => {
    const result = generateRequirements({ bun: ">=1.3" });
    expect(result).toContain("- [Bun](https://bun.sh/) >=1.3");
    expect(result).toContain("- Discord Bot Token");
    expect(result).toContain("- OpenRouter API Key");
  });

  test("enginesが空でもトークン情報は含む", () => {
    const result = generateRequirements({});
    expect(result).toContain("- Discord Bot Token");
    expect(result).toContain("- OpenRouter API Key");
    expect(result).not.toContain("Bun");
  });

  test("Nodeバージョンがある場合も対応", () => {
    const result = generateRequirements({ node: ">=18" });
    expect(result).toContain("- [Node.js](https://nodejs.org/) >=18");
  });
});

describe("replaceMarkerSection", () => {
  const template = [
    "before",
    "<!-- AUTO:TEST:START -->",
    "old content",
    "<!-- AUTO:TEST:END -->",
    "after",
  ].join("\n");

  test("マーカー間のテキストを置換する", () => {
    const result = replaceMarkerSection(template, "TEST", "new content");
    expect(result).toContain("<!-- AUTO:TEST:START -->\nnew content\n<!-- AUTO:TEST:END -->");
    expect(result).toContain("before");
    expect(result).toContain("after");
    expect(result).not.toContain("old content");
  });

  test("マーカーが見つからない場合はエラー", () => {
    expect(() => replaceMarkerSection(template, "MISSING", "content")).toThrow(
      "Marker not found: MISSING",
    );
  });

  test("開始マーカーのみの場合もエラー", () => {
    const partial = "<!-- AUTO:HALF:START -->\ncontent";
    expect(() => replaceMarkerSection(partial, "HALF", "new")).toThrow("Marker not found: HALF");
  });
});
