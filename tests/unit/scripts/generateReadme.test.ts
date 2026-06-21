import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { RESTPostAPIChatInputApplicationCommandsJSONBody } from "discord.js";
import { ApplicationCommandOptionType } from "discord.js";
import type { ProgressEntry } from "../../../scripts/generate-readme";
import {
  generateCommandTable,
  generateDefaultModelLine,
  generateEnvExample,
  generateEnvVarsTable,
  generateProgressTable,
  parseFrontmatter,
  replaceMarkerSection,
  scanDesignDocs,
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
    const vars: EnvVarDefinition[] = [{ name: "OTHER", required: true, description: "other" }];
    expect(() => generateDefaultModelLine(vars)).toThrow("DEFAULT_MODEL definition");
  });

  test("DEFAULT_MODEL に default 値が無い場合もエラー", () => {
    const vars: EnvVarDefinition[] = [
      { name: "DEFAULT_MODEL", required: true, description: "デフォルトモデル" },
    ];
    expect(() => generateDefaultModelLine(vars)).toThrow("DEFAULT_MODEL definition");
  });
});

// --- parseFrontmatter ---

describe("parseFrontmatter", () => {
  test("全フィールドありで正常パース", () => {
    const content = `---
title: "テスト機能"
status: planned
priority: high
summary: "一行の概要"
---

# テスト機能`;
    const result = parseFrontmatter(content);
    expect(result).toEqual({
      title: "テスト機能",
      status: "planned",
      priority: "high",
      summary: "一行の概要",
    });
  });

  test("必須フィールドのみで summary は undefined", () => {
    const content = `---
title: "機能名"
status: in-progress
priority: medium
---

# 機能名`;
    const result = parseFrontmatter(content);
    expect(result.summary).toBeUndefined();
  });

  test("ダブルクォートを除去", () => {
    const content = `---
title: "クォート付き"
status: "implemented"
priority: "low"
---`;
    const result = parseFrontmatter(content);
    expect(result.title).toBe("クォート付き");
    expect(result.status).toBe("implemented");
  });

  test("シングルクォートを除去", () => {
    const content = `---
title: 'シングル'
status: 'planned'
priority: 'high'
---`;
    const result = parseFrontmatter(content);
    expect(result.title).toBe("シングル");
  });

  test("インラインコメントを除去", () => {
    const content = `---
title: テスト
status: planned # これはコメント
priority: high
---`;
    const result = parseFrontmatter(content);
    expect(result.status).toBe("planned");
  });

  test("クォート内の # は保持", () => {
    const content = `---
title: "A # B"
status: planned
priority: high
---`;
    const result = parseFrontmatter(content);
    expect(result.title).toBe("A # B");
  });

  test("コロンを含む value を正しく扱う", () => {
    const content = `---
title: テスト
status: planned
priority: high
summary: "Phase 2: ログ集約"
---`;
    const result = parseFrontmatter(content);
    expect(result.summary).toBe("Phase 2: ログ集約");
  });

  test("frontmatter なしで throw", () => {
    expect(() => parseFrontmatter("# ただの見出し\n本文")).toThrow("Frontmatter not found");
  });

  test("閉じ --- なしで throw", () => {
    const content = `---
title: テスト
status: planned
priority: high
# 閉じ忘れ`;
    expect(() => parseFrontmatter(content)).toThrow("Frontmatter not found");
  });

  test("必須フィールド title 欠落で throw", () => {
    const content = `---
status: planned
priority: high
---`;
    expect(() => parseFrontmatter(content)).toThrow("Missing required frontmatter field(s): title");
  });

  test("必須フィールド status 欠落で throw", () => {
    const content = `---
title: テスト
priority: high
---`;
    expect(() => parseFrontmatter(content)).toThrow("status");
  });

  test("必須フィールド priority 欠落で throw", () => {
    const content = `---
title: テスト
status: planned
---`;
    expect(() => parseFrontmatter(content)).toThrow("priority");
  });

  test("investigating を有効な status として受理", () => {
    const content = `---
title: テスト
status: investigating
priority: high
---`;
    const result = parseFrontmatter(content);
    expect(result.status).toBe("investigating");
  });

  test("不正な status で throw", () => {
    const content = `---
title: テスト
status: done
priority: high
---`;
    expect(() => parseFrontmatter(content)).toThrow('Invalid status: "done"');
  });

  test("不正な priority で throw", () => {
    const content = `---
title: テスト
status: planned
priority: critical
---`;
    expect(() => parseFrontmatter(content)).toThrow('Invalid priority: "critical"');
  });

  test("未知キーで throw", () => {
    const content = `---
title: テスト
status: planned
priority: high
summry: タイポ
---`;
    expect(() => parseFrontmatter(content)).toThrow('Unknown frontmatter key: "summry"');
  });

  test("重複キーで throw", () => {
    const content = `---
title: テスト
status: planned
priority: high
status: implemented
---`;
    expect(() => parseFrontmatter(content)).toThrow('Duplicate frontmatter key: "status"');
  });

  test("空 summary は undefined", () => {
    const content = `---
title: テスト
status: planned
priority: high
summary: ""
---`;
    const result = parseFrontmatter(content);
    expect(result.summary).toBeUndefined();
  });

  test("CRLF 入力で正常パース", () => {
    const content = "---\r\ntitle: テスト\r\nstatus: planned\r\npriority: high\r\n---\r\n";
    const result = parseFrontmatter(content);
    expect(result.title).toBe("テスト");
  });
});

// --- generateProgressTable ---

describe("generateProgressTable", () => {
  const makeEntry = (
    folder: string,
    priority: "high" | "medium" | "low",
    status: "planned" | "in-progress" | "implemented" = "planned",
    summary?: string,
  ): ProgressEntry => ({
    folder,
    frontmatter: { title: `${folder} 機能`, status, priority, summary },
  });

  test("priority → フォルダ名アルファベット順でソート", () => {
    const entries = [
      makeEntry("zebra", "low"),
      makeEntry("beta", "high"),
      makeEntry("alpha", "high"),
      makeEntry("gamma", "medium"),
    ];
    const result = generateProgressTable(entries);
    const rows = result.split("\n").slice(2);
    expect(rows[0]).toContain("alpha");
    expect(rows[1]).toContain("beta");
    expect(rows[2]).toContain("gamma");
    expect(rows[3]).toContain("zebra");
  });

  test("priority の日本語表示", () => {
    const entries = [makeEntry("a", "high"), makeEntry("b", "medium"), makeEntry("c", "low")];
    const result = generateProgressTable(entries);
    expect(result).toContain("| 高 |");
    expect(result).toContain("| 中 |");
    expect(result).toContain("| 低 |");
  });

  test("リンク形式が正しい", () => {
    const entries = [makeEntry("my-feature", "high")];
    const result = generateProgressTable(entries);
    expect(result).toContain("[my-feature 機能](changes/my-feature/design.md)");
  });

  test("summary 空は空セル", () => {
    const entries = [makeEntry("feat", "high", "planned")];
    const result = generateProgressTable(entries);
    expect(result).toContain("|  |");
  });

  test("summary ありはセルに表示", () => {
    const entries = [makeEntry("feat", "high", "planned", "概要テキスト")];
    const result = generateProgressTable(entries);
    expect(result).toContain("| 概要テキスト |");
  });

  test("テーブルヘッダが正しい", () => {
    const entries = [makeEntry("a", "high")];
    const result = generateProgressTable(entries);
    expect(result).toStartWith(
      "| 機能 | 優先度 | ステータス | 概要 |\n| ---- | ------ | ---------- | ---- |",
    );
  });

  test("パイプ文字をエスケープ", () => {
    const entries: ProgressEntry[] = [
      {
        folder: "test",
        frontmatter: {
          title: "A | B",
          status: "planned",
          priority: "high",
          summary: "X | Y",
        },
      },
    ];
    const result = generateProgressTable(entries);
    expect(result).toContain("A \\| B");
    expect(result).toContain("X \\| Y");
  });

  test("リンクテキスト内の [ ] \\ をエスケープ", () => {
    const entries: ProgressEntry[] = [
      {
        folder: "test",
        frontmatter: { title: "A [B] C\\D", status: "planned", priority: "high" },
      },
    ];
    const result = generateProgressTable(entries);
    expect(result).toContain("A \\[B\\] C\\\\D");
  });

  test("空配列はヘッダのみ", () => {
    const result = generateProgressTable([]);
    const lines = result.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("機能");
  });
});

// --- scanDesignDocs ---

describe("scanDesignDocs", () => {
  const tmpBase = resolve(tmpdir(), "disqord-test-scan");

  beforeAll(() => {
    rmSync(tmpBase, { recursive: true, force: true });
    mkdirSync(tmpBase, { recursive: true });
  });

  afterAll(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  const validFrontmatter = (title: string) => `---
title: "${title}"
status: planned
priority: medium
---

# ${title}`;

  test("正常系: 複数フォルダを読み取りフォルダ名順で返す", () => {
    const dir = resolve(tmpBase, "normal");
    mkdirSync(dir, { recursive: true });
    for (const name of ["beta", "alpha"]) {
      const sub = resolve(dir, name);
      mkdirSync(sub, { recursive: true });
      writeFileSync(resolve(sub, "design.md"), validFrontmatter(`${name} 機能`));
    }
    const entries = scanDesignDocs(dir);
    expect(entries).toHaveLength(2);
    expect(entries[0].folder).toBe("alpha");
    expect(entries[1].folder).toBe("beta");
  });

  test("TEMPLATE.md ファイルを除外（ディレクトリではない）", () => {
    const dir = resolve(tmpBase, "template-test");
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, "TEMPLATE.md"), "# テンプレート");
    const sub = resolve(dir, "feat");
    mkdirSync(sub, { recursive: true });
    writeFileSync(resolve(sub, "design.md"), validFrontmatter("機能"));
    const entries = scanDesignDocs(dir);
    expect(entries).toHaveLength(1);
    expect(entries[0].folder).toBe("feat");
  });

  test("design.md の無い change フォルダで throw", () => {
    const dir = resolve(tmpBase, "missing-design");
    mkdirSync(dir, { recursive: true });
    mkdirSync(resolve(dir, "empty-folder"), { recursive: true });
    expect(() => scanDesignDocs(dir)).toThrow("Missing design.md in change folder: empty-folder");
  });

  test("design.subfeature.md は無視して design.md のみ読む", () => {
    const dir = resolve(tmpBase, "subfeature-test");
    const sub = resolve(dir, "feat");
    mkdirSync(sub, { recursive: true });
    writeFileSync(resolve(sub, "design.md"), validFrontmatter("メイン"));
    writeFileSync(resolve(sub, "design.sub.md"), "# サブ機能");
    const entries = scanDesignDocs(dir);
    expect(entries).toHaveLength(1);
    expect(entries[0].frontmatter.title).toBe("メイン");
  });
});
