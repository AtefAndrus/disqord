import { describe, expect, test } from "bun:test";
import type { RESTPostAPIChatInputApplicationCommandsJSONBody } from "discord.js";
import { ApplicationCommandOptionType } from "discord.js";
import {
  generateCommandTable,
  generateDefaultModelLine,
  generateEnvExample,
  generateEnvVarsTable,
  replaceMarkerSection,
} from "../../../scripts/generate-readme";
import type { EnvVarDefinition } from "../../../src/config/envVars";

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

describe("generateEnvVarsTable", () => {
  test("必須変数はYes、任意変数はNoで表示", () => {
    const vars: EnvVarDefinition[] = [
      { name: "TOKEN", required: true, description: "トークン" },
      { name: "PORT", required: false, description: "ポート" },
    ];
    const result = generateEnvVarsTable(vars);
    expect(result).toContain("| TOKEN | Yes | トークン |");
    expect(result).toContain("| PORT | No | ポート |");
  });

  test("デフォルト値がある場合は説明に含まれる", () => {
    const vars: EnvVarDefinition[] = [
      { name: "PORT", required: false, description: "ポート", default: "3000" },
    ];
    const result = generateEnvVarsTable(vars);
    expect(result).toContain("| PORT | No | ポート（デフォルト: `3000`） |");
  });

  test("デフォルト値がない場合は説明のみ", () => {
    const vars: EnvVarDefinition[] = [
      { name: "SECRET", required: false, description: "シークレット" },
    ];
    const result = generateEnvVarsTable(vars);
    expect(result).toContain("| SECRET | No | シークレット |");
    expect(result).not.toContain("デフォルト");
  });

  test("テーブルヘッダーが含まれる", () => {
    const vars: EnvVarDefinition[] = [{ name: "TOKEN", required: true, description: "トークン" }];
    const result = generateEnvVarsTable(vars);
    expect(result).toStartWith("| 変数名 | 必須 | 説明 |\n| ------ | ---- | ---- |");
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

describe("generateEnvExample", () => {
  test("デフォルト値ありは NAME=value、なしは NAME= で出力", () => {
    const vars: EnvVarDefinition[] = [
      { name: "TOKEN", required: true, description: "トークン" },
      { name: "PORT", required: false, description: "ポート", default: "3000" },
    ];
    const result = generateEnvExample(vars);
    expect(result).toContain("TOKEN=\n");
    expect(result).toContain("PORT=3000\n");
  });

  test("末尾改行が含まれる", () => {
    const vars: EnvVarDefinition[] = [{ name: "TOKEN", required: true, description: "トークン" }];
    const result = generateEnvExample(vars);
    expect(result.endsWith("\n")).toBe(true);
  });

  test("envVarDefinitions の順序を保持する", () => {
    const vars: EnvVarDefinition[] = [
      { name: "A", required: true, description: "a" },
      { name: "B", required: true, description: "b" },
      { name: "C", required: true, description: "c" },
    ];
    const result = generateEnvExample(vars);
    const aIdx = result.indexOf("A=");
    const bIdx = result.indexOf("B=");
    const cIdx = result.indexOf("C=");
    expect(aIdx).toBeLessThan(bIdx);
    expect(bIdx).toBeLessThan(cIdx);
  });
});

describe("generateDefaultModelLine", () => {
  test("DEFAULT_MODEL エントリから行を生成", () => {
    const vars: EnvVarDefinition[] = [
      { name: "DEFAULT_MODEL", required: false, description: "デフォルトモデル", default: "x/y:z" },
    ];
    expect(generateDefaultModelLine(vars)).toBe("- Default model: `x/y:z`");
  });

  test("DEFAULT_MODEL エントリが無い場合はエラー", () => {
    const vars: EnvVarDefinition[] = [
      { name: "OTHER", required: true, description: "other" },
    ];
    expect(() => generateDefaultModelLine(vars)).toThrow("DEFAULT_MODEL definition");
  });

  test("DEFAULT_MODEL に default 値が無い場合もエラー", () => {
    const vars: EnvVarDefinition[] = [
      { name: "DEFAULT_MODEL", required: true, description: "デフォルトモデル" },
    ];
    expect(() => generateDefaultModelLine(vars)).toThrow("DEFAULT_MODEL definition");
  });
});
