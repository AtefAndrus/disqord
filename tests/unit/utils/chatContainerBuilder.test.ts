import { describe, expect, test } from "bun:test";
import { MessageFlags } from "discord.js";
import { EmbedColors } from "../../../src/types/embed";
import {
  badgeText,
  buildErrorContainer,
  buildFinalContainer,
  buildFinalFooterText,
  buildStoppedContainer,
  buildStoppedFooterText,
  buildStreamingContainer,
  buildUsageDetailsText,
  estimateFinalFooterChars,
  type FinalMetadata,
  MAX_TOTAL_CHARS_PER_MESSAGE,
  STREAMING_LABEL,
  splitTextIntoMessages,
  toComponentsV2EditPayload,
  toComponentsV2Payload,
  toComponentsV2ReplyPayload,
} from "../../../src/utils/chatContainerBuilder";

interface ContainerComponentJSON {
  type: number;
  content?: string;
  divider?: boolean;
  spacing?: number;
  components?: ContainerComponentJSON[];
  accessory?: { type: number; custom_id?: string; label?: string; style?: number };
}

interface ContainerJSON {
  type: number;
  accent_color?: number | null;
  components: ContainerComponentJSON[];
}

function toJSON(container: { toJSON: () => ContainerJSON }): ContainerJSON {
  return container.toJSON();
}

function textContents(json: ContainerJSON): string[] {
  const out: string[] = [];
  for (const c of json.components) {
    if (c.type === 10 && c.content !== undefined) out.push(c.content);
    if (c.type === 9 && c.components) {
      for (const child of c.components) {
        if (child.type === 10 && child.content !== undefined) out.push(child.content);
      }
    }
  }
  return out;
}

function findSection(json: ContainerJSON): ContainerComponentJSON | undefined {
  return json.components.find((c) => c.type === 9);
}

const usage = {
  prompt_tokens: 100,
  completion_tokens: 200,
  total_tokens: 300,
  cost: 0.001234,
};

describe("chatContainerBuilder", () => {
  describe("splitTextIntoMessages", () => {
    test("予算内のテキストは1チャンクになる", () => {
      const text = "a".repeat(100);
      const chunks = splitTextIntoMessages(text, 0, 0);
      expect(chunks).toEqual([text]);
    });

    test("badgeChars/footerChars分だけ本文予算が減る", () => {
      const text = "a".repeat(MAX_TOTAL_CHARS_PER_MESSAGE); // 予算ちょうど
      const chunksNoBudgetCost = splitTextIntoMessages(text, 0, 0);
      const chunksWithBudgetCost = splitTextIntoMessages(text, 50, 50); // 合計100字分の予算を消費
      expect(chunksNoBudgetCost.length).toBe(1);
      expect(chunksWithBudgetCost.length).toBeGreaterThan(1);
    });

    test("改行優先で分割される（改行位置が80%以降なら改行で切る）", () => {
      const bodyBudget = 50;
      // ちょうど bodyBudget を超える位置の少し手前に改行を置く
      const before = "a".repeat(45);
      const after = "b".repeat(45);
      const text = `${before}\n${after}`;
      const chunks = splitTextIntoMessages(text, 0, MAX_TOTAL_CHARS_PER_MESSAGE - bodyBudget);

      expect(chunks[0]).toBe(`${before}\n`);
      expect(chunks[1]).toBe(after);
    });

    test("長文（1万字超）は複数チャンクに分割され、結合すると元のテキストに一致する", () => {
      const text = "x".repeat(10000);
      const chunks = splitTextIntoMessages(text, 30, 80);

      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks.join("")).toBe(text);
      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(MAX_TOTAL_CHARS_PER_MESSAGE);
      }
    });

    test("空文字列は1要素（空文字列）の配列になる", () => {
      expect(splitTextIntoMessages("", 0, 0)).toEqual([""]);
    });

    test("badge+footerが予算を超える場合でも最低1文字は確保する（無限ループしない）", () => {
      const chunks = splitTextIntoMessages("abcdef", MAX_TOTAL_CHARS_PER_MESSAGE, 500);
      expect(chunks.join("")).toBe("abcdef");
    });
  });

  describe("badgeText", () => {
    test("Model badgeのMarkdown文言を生成する", () => {
      expect(badgeText("GPT-5-mini")).toBe("**Model:** GPT-5-mini");
    });
  });

  describe("buildUsageDetailsText / buildFinalFooterText", () => {
    test("showDetails=falseの場合はundefined", () => {
      const metadata: FinalMetadata = { showDetails: false, usage };
      expect(buildUsageDetailsText(metadata)).toBeUndefined();
      expect(buildFinalFooterText(metadata)).toBeUndefined();
    });

    test("usage未取得の場合はundefined", () => {
      const metadata: FinalMetadata = { showDetails: true };
      expect(buildUsageDetailsText(metadata)).toBeUndefined();
    });

    test("Tokens/Cost/Model/Latency/Provider/TPSを ` | ` 区切りで含む", () => {
      const metadata: FinalMetadata = {
        showDetails: true,
        model: "gpt-5-mini",
        provider: "OpenAI",
        latency: 2000,
        usage,
      };
      const text = buildUsageDetailsText(metadata);
      expect(text).toBe(
        "Tokens: 100+200=300 | Cost: $0.001234 | Model: gpt-5-mini | Latency: 2000ms | Provider: OpenAI | TPS: 100.00",
      );
    });

    test("Cached/Reasoningはusage detailsにある場合のみ含む", () => {
      const metadata: FinalMetadata = {
        showDetails: true,
        usage: {
          ...usage,
          prompt_tokens_details: { cached_tokens: 10 },
          completion_tokens_details: { reasoning_tokens: 20 },
        },
      };
      const text = buildUsageDetailsText(metadata);
      expect(text).toContain("Cached: 10");
      expect(text).toContain("Reasoning: 20");
    });

    test("pageInfo.total>1のときページ番号をprefixする", () => {
      const metadata: FinalMetadata = { showDetails: true, usage };
      const text = buildFinalFooterText(metadata, { page: 2, total: 3 });
      expect(text?.startsWith("ページ 2/3 | ")).toBe(true);
    });

    test("pageInfo.total===1のときページ番号は付かない", () => {
      const metadata: FinalMetadata = { showDetails: true, usage };
      const text = buildFinalFooterText(metadata, { page: 1, total: 1 });
      expect(text?.startsWith("ページ")).toBe(false);
    });

    test("showDetails=falseかつ複数ページでもfooter自体を出さない（ページ番号のみの表示はしない）", () => {
      const metadata: FinalMetadata = { showDetails: false };
      expect(buildFinalFooterText(metadata, { page: 1, total: 3 })).toBeUndefined();
    });
  });

  describe("buildStoppedFooterText", () => {
    test("Tokensを含まず経過秒数のみ表示する", () => {
      expect(buildStoppedFooterText(12.34)).toBe("🛑 Stopped | 12.3s");
      expect(buildStoppedFooterText(12.34)).not.toContain("Tokens");
    });
  });

  describe("buildStreamingContainer", () => {
    test("isFirst=trueのときModel badgeを含む", () => {
      const json = toJSON(
        buildStreamingContainer({
          text: "hello",
          modelName: "gpt-5-mini",
          color: 0x123456,
          isFirst: true,
          isLast: false,
          triggerMessageId: "msg-1",
        }),
      );
      expect(json.accent_color).toBe(0x123456);
      expect(textContents(json)[0]).toBe("**Model:** gpt-5-mini");
      expect(textContents(json)).toContain("hello");
    });

    test("isFirst=falseのときModel badgeを含まない", () => {
      const json = toJSON(
        buildStreamingContainer({
          text: "hello",
          modelName: "gpt-5-mini",
          color: 0x123456,
          isFirst: false,
          isLast: false,
          triggerMessageId: "msg-1",
        }),
      );
      expect(textContents(json)).toEqual(["hello"]);
    });

    test("isLast=trueのときSection + 停止ボタンaccessoryを含む（custom_idにtriggerMessageId）", () => {
      const json = toJSON(
        buildStreamingContainer({
          text: "hello",
          modelName: "gpt-5-mini",
          color: 0x123456,
          isFirst: true,
          isLast: true,
          triggerMessageId: "trigger-42",
        }),
      );
      const section = findSection(json);
      expect(section).toBeDefined();
      expect(section?.accessory?.custom_id).toBe("stop_response_trigger-42");
      expect(section?.accessory?.style).toBe(4); // Danger
      expect(section?.components?.[0]?.content).toBe(STREAMING_LABEL);
    });

    test("isLast=falseのときSectionを含まない（停止ボタンは最新messageのみ）", () => {
      const json = toJSON(
        buildStreamingContainer({
          text: "hello",
          modelName: "gpt-5-mini",
          color: 0x123456,
          isFirst: false,
          isLast: false,
          triggerMessageId: "trigger-42",
        }),
      );
      expect(findSection(json)).toBeUndefined();
    });
  });

  describe("buildFinalContainer", () => {
    test("showLlmDetails=true かつ usage ありのとき、isLastでfooter（ページ番号なし・単一message）を表示する", () => {
      const metadata: FinalMetadata = { showDetails: true, usage, latency: 1000 };
      const json = toJSON(
        buildFinalContainer({
          text: "response body",
          modelName: "gpt-5-mini",
          color: 0x00ff00,
          isFirst: true,
          isLast: true,
          metadata,
          pageInfo: { page: 1, total: 1 },
        }),
      );
      const contents = textContents(json);
      expect(contents).toContain("response body");
      expect(contents.at(-1)).toContain("Tokens: 100+200=300");
      expect(contents.at(-1)).not.toContain("ページ");
      expect(findSection(json)).toBeUndefined(); // Sectionは使わない
    });

    test("複数messageの最終messageにのみ `ページ n/N` 付きfooterを表示する", () => {
      const metadata: FinalMetadata = { showDetails: true, usage };
      const firstJson = toJSON(
        buildFinalContainer({
          text: "part 1",
          modelName: "gpt-5-mini",
          color: 0x00ff00,
          isFirst: true,
          isLast: false,
          metadata,
          pageInfo: { page: 1, total: 2 },
        }),
      );
      const lastJson = toJSON(
        buildFinalContainer({
          text: "part 2",
          modelName: "gpt-5-mini",
          color: 0x00ff00,
          isFirst: false,
          isLast: true,
          metadata,
          pageInfo: { page: 2, total: 2 },
        }),
      );

      // 非最終message（先頭なのでbadgeは付くが）にはfooterが無い
      expect(textContents(firstJson)).toEqual(["**Model:** gpt-5-mini", "part 1"]);
      // 最終messageにのみページ番号付きfooter
      expect(textContents(lastJson).at(-1)).toBe(`ページ 2/2 | ${buildUsageDetailsText(metadata)}`);
    });

    test("showLlmDetails=falseのときfooterを表示しない", () => {
      const metadata: FinalMetadata = { showDetails: false, usage };
      const json = toJSON(
        buildFinalContainer({
          text: "response body",
          modelName: "gpt-5-mini",
          color: 0x00ff00,
          isFirst: true,
          isLast: true,
          metadata,
          pageInfo: { page: 1, total: 1 },
        }),
      );
      expect(textContents(json)).toEqual(["**Model:** gpt-5-mini", "response body"]);
    });

    test("usage未取得のときfooterを表示しない", () => {
      const metadata: FinalMetadata = { showDetails: true };
      const json = toJSON(
        buildFinalContainer({
          text: "response body",
          modelName: "gpt-5-mini",
          color: 0x00ff00,
          isFirst: true,
          isLast: true,
          metadata,
        }),
      );
      expect(textContents(json)).toEqual(["**Model:** gpt-5-mini", "response body"]);
    });
  });

  describe("buildStoppedContainer", () => {
    test("isLastのときSectionを使わず `🛑 Stopped | xx.xs` のfooterを表示する", () => {
      const json = toJSON(
        buildStoppedContainer({
          text: "partial text",
          modelName: "gpt-5-mini",
          color: 0xff0000,
          isFirst: true,
          isLast: true,
          elapsedSeconds: 5.6,
        }),
      );
      expect(findSection(json)).toBeUndefined();
      const contents = textContents(json);
      expect(contents.at(-1)).toBe("🛑 Stopped | 5.6s");
      expect(contents.at(-1)).not.toContain("Tokens");
    });

    test("isLast=falseのときfooterを表示しない", () => {
      const json = toJSON(
        buildStoppedContainer({
          text: "partial text",
          modelName: "gpt-5-mini",
          color: 0xff0000,
          isFirst: false,
          isLast: false,
          elapsedSeconds: 5.6,
        }),
      );
      expect(textContents(json)).toEqual(["partial text"]);
    });
  });

  describe("buildErrorContainer", () => {
    test("accent color が RED で、タイトル+メッセージのTextDisplayを持つ", () => {
      const json = toJSON(buildErrorContainer("何か問題が発生しました。", "カスタムエラー"));
      expect(json.accent_color).toBe(EmbedColors.RED);
      expect(textContents(json)).toEqual(["## ⚠️ カスタムエラー\n\n何か問題が発生しました。"]);
    });

    test("titleを省略すると既定値「エラー」を使う", () => {
      const json = toJSON(buildErrorContainer("問題発生"));
      expect(textContents(json)[0]).toContain("## ⚠️ エラー");
    });
  });

  describe("estimateFinalFooterChars", () => {
    test("footerが無い場合は0", () => {
      expect(estimateFinalFooterChars({ showDetails: false })).toBe(0);
      expect(estimateFinalFooterChars({ showDetails: true })).toBe(0);
    });

    test("footerがある場合はdetails文字数 + ページprefixマージン", () => {
      const metadata: FinalMetadata = { showDetails: true, usage };
      const details = buildUsageDetailsText(metadata) ?? "";
      expect(estimateFinalFooterChars(metadata)).toBe(details.length + 20);
    });
  });

  describe("送信payloadヘルパ（mention safety強制）", () => {
    const container = buildErrorContainer("test");

    test("toComponentsV2Payload: IsComponentsV2フラグとparse:[]を強制する", () => {
      const payload = toComponentsV2Payload(container);
      expect(payload.flags).toBe(MessageFlags.IsComponentsV2);
      expect(payload.allowedMentions).toEqual({ parse: [] });
      expect(payload.components).toEqual([container]);
    });

    test("toComponentsV2EditPayload: IsComponentsV2フラグとparse:[]を強制する", () => {
      const payload = toComponentsV2EditPayload(container);
      expect(payload.flags).toBe(MessageFlags.IsComponentsV2);
      expect(payload.allowedMentions).toEqual({ parse: [] });
    });

    test("toComponentsV2ReplyPayload: parse:[] と repliedUser:false を強制する", () => {
      const payload = toComponentsV2ReplyPayload(container);
      expect(payload.flags).toBe(MessageFlags.IsComponentsV2);
      expect(payload.allowedMentions).toEqual({ parse: [], repliedUser: false });
    });

    test("送信payloadヘルパは引数を1つしか取らず、allowedMentions/flagsを外部から上書きできない", () => {
      // toComponentsV2Payload(container) はcontainer以外の引数を受け付けない型シグネチャであり、
      // 呼び出し側から allowedMentions / flags を注入する経路が存在しない。
      expect(toComponentsV2Payload.length).toBe(1);
      expect(toComponentsV2EditPayload.length).toBe(1);
      expect(toComponentsV2ReplyPayload.length).toBe(1);
    });
  });
});
