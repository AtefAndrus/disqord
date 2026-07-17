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
  estimateFinalFooterBudget,
  type FinalMetadata,
  MAX_TOTAL_BYTES_PER_MESSAGE,
  MAX_TOTAL_CHARS_PER_MESSAGE,
  measureTextBudget,
  STREAMING_LABEL,
  splitTextByCharsAndBytes,
  splitTextIntoMessages,
  type TextBudget,
  toComponentsV2EditPayload,
  toComponentsV2Payload,
  toComponentsV2ReplyPayload,
  ZERO_TEXT_BUDGET,
} from "../../../src/utils/chatContainerBuilder";

const textEncoder = new TextEncoder();

function byteLength(text: string): number {
  return textEncoder.encode(text).length;
}

function budget(chars: number, bytes: number): TextBudget {
  return { chars, bytes };
}

/** chunk境界がサロゲートペアの途中（lone surrogate）で始まる/終わっていないかを調べる */
function hasLoneSurrogateAtBoundary(chunks: string[]): boolean {
  for (const chunk of chunks) {
    if (chunk.length === 0) continue;
    const firstCode = chunk.charCodeAt(0);
    const lastCode = chunk.charCodeAt(chunk.length - 1);
    // 低サロゲートで始まる = 直前の高サロゲートが別chunkに分断された
    if (firstCode >= 0xdc00 && firstCode <= 0xdfff) return true;
    // 高サロゲートで終わる = 後続の低サロゲートが別chunkに分断された
    if (lastCode >= 0xd800 && lastCode <= 0xdbff) return true;
  }
  return false;
}

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
      const chunks = splitTextIntoMessages(text, ZERO_TEXT_BUDGET, ZERO_TEXT_BUDGET);
      expect(chunks).toEqual([text]);
    });

    test("badge/footerの文字数・バイト数分だけ本文予算が減る", () => {
      const text = "a".repeat(MAX_TOTAL_CHARS_PER_MESSAGE); // 予算ちょうど
      const chunksNoBudgetCost = splitTextIntoMessages(text, ZERO_TEXT_BUDGET, ZERO_TEXT_BUDGET);
      // 合計100字/100バイト分の予算を消費
      const chunksWithBudgetCost = splitTextIntoMessages(text, budget(50, 50), budget(50, 50));
      expect(chunksNoBudgetCost.length).toBe(1);
      expect(chunksWithBudgetCost.length).toBeGreaterThan(1);
    });

    test("改行優先で分割される（改行位置が80%以降なら改行で切る）", () => {
      const bodyBudget = 50;
      // ちょうど bodyBudget を超える位置の少し手前に改行を置く
      const before = "a".repeat(45);
      const after = "b".repeat(45);
      const text = `${before}\n${after}`;
      const footerBudget = budget(
        MAX_TOTAL_CHARS_PER_MESSAGE - bodyBudget,
        MAX_TOTAL_BYTES_PER_MESSAGE - bodyBudget,
      );
      const chunks = splitTextIntoMessages(text, ZERO_TEXT_BUDGET, footerBudget);

      expect(chunks[0]).toBe(`${before}\n`);
      expect(chunks[1]).toBe(after);
    });

    test("ASCII長文（1万字超）は文字数上限(3800字)前後で分割され、結合すると元に一致する（バイト制限の影響を受けない）", () => {
      const text = "x".repeat(10000);
      const badgeBudget = budget(30, 30);
      const footerBudget = budget(80, 80);
      const chunks = splitTextIntoMessages(text, badgeBudget, footerBudget);

      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks.join("")).toBe(text);
      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(MAX_TOTAL_CHARS_PER_MESSAGE);
        expect(byteLength(chunk)).toBeLessThanOrEqual(MAX_TOTAL_BYTES_PER_MESSAGE);
      }

      // ASCII (1 byte/字) では byte 予算 (9000) は char 予算 (3800) より緩いはずなので、
      // byte 予算のせいで過度に保守的な分割にならないこと（最初のchunkが本文予算の8割以上を使う）を確認する
      const bodyBudgetChars = MAX_TOTAL_CHARS_PER_MESSAGE - badgeBudget.chars - footerBudget.chars;
      expect(chunks[0].length).toBeGreaterThanOrEqual(bodyBudgetChars * 0.8);
    });

    test("日本語長文（12000字）は各chunkが9000バイト以下になるよう分割される（文字数上限だけでは不十分）", () => {
      // 文字数上限(3800字)だけで分割すると、日本語(約3bytes/字)は1 chunk ≈ 11.4KBになり、
      // 実測されたDiscordのUTF-8バイト内部制限(≈10.17KB)を超えて HTTP 500 になる。
      const text = "あ".repeat(12000);
      const chunks = splitTextIntoMessages(text, ZERO_TEXT_BUDGET, ZERO_TEXT_BUDGET);

      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks.join("")).toBe(text);
      for (const chunk of chunks) {
        expect(byteLength(chunk)).toBeLessThanOrEqual(MAX_TOTAL_BYTES_PER_MESSAGE);
        expect(chunk.length).toBeLessThanOrEqual(MAX_TOTAL_CHARS_PER_MESSAGE);
      }
    });

    test("日本語/ASCII混在テキストも各chunkが文字数・バイト数の両上限を満たす", () => {
      const paragraph = "日本語のテキストとASCII textが混在する段落です。".repeat(300);
      const chunks = splitTextIntoMessages(paragraph, budget(30, 90), budget(80, 200));

      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks.join("")).toBe(paragraph);
      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(MAX_TOTAL_CHARS_PER_MESSAGE);
        expect(byteLength(chunk)).toBeLessThanOrEqual(MAX_TOTAL_BYTES_PER_MESSAGE);
      }
    });

    test("空文字列は1要素（空文字列）の配列になる", () => {
      expect(splitTextIntoMessages("", ZERO_TEXT_BUDGET, ZERO_TEXT_BUDGET)).toEqual([""]);
    });

    test("badge+footerが予算を大幅に超える場合でも本文予算を最低1（chars/bytes）に固定して前進する（無限ループしない）", () => {
      // splitTextIntoMessages の Math.max(1, ...) クランプにより bodyBudgetChars/Bytes は 1 になる
      const chunks = splitTextIntoMessages(
        "abcdef",
        budget(MAX_TOTAL_CHARS_PER_MESSAGE, MAX_TOTAL_BYTES_PER_MESSAGE),
        budget(500, 500),
      );
      expect(chunks.join("")).toBe("abcdef");
    });
  });

  describe("splitTextByCharsAndBytes", () => {
    test("絵文字（サロゲートペア）を跨いで切らない", () => {
      // "😀" (U+1F600) は UTF-16で2コードユニット（サロゲートペア）、UTF-8で4バイト
      const emoji = "😀";
      const text = "a".repeat(10) + emoji.repeat(5) + "b".repeat(10);
      // バイト予算を絵文字の境界付近に設定し、分割点が絵文字の途中に来やすい状況を作る
      const chunks = splitTextByCharsAndBytes(text, 1000, 17);

      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks.join("")).toBe(text); // 結合すると元に戻る（文字の消失・重複が無い）
      expect(hasLoneSurrogateAtBoundary(chunks)).toBe(false);
    });

    test("改行が予算超過の原因になった直後の1字である場合、改行優先ロジックが両予算を超過させない（レビュー指摘1・境界ケース）", () => {
      // "aaaa\nb" を maxChars=4, maxBytes=4 で分割すると、コードポイントループは
      // "aaaa"(4字/4byte)でcutIndex=4に止まる（次の"\n"を足すと5字で予算超過するため）。
      // ここで改行優先ロジックが lastIndexOf の検索範囲に cutIndex 自身（"\n"の位置）まで含めてしまうと、
      // 「まだ含めていないはずの直後の改行」を誤って見つけ、"aaaa\n"(5字/5byte)を返して両予算を
      // 1 超過するバグがあった。cutIndex-1 までの検索に修正済み。
      const chunks = splitTextByCharsAndBytes("aaaa\nb", 4, 4);

      expect(chunks.join("")).toBe("aaaa\nb");
      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(4);
        expect(byteLength(chunk)).toBeLessThanOrEqual(4);
      }
      expect(chunks[0]).toBe("aaaa");
    });

    test("契約: 1コードポイントも入らないほど予算が小さい場合でも前進し、予算超過を許容してコードポイント単位で丸ごと1chunkにする（throwしない）", () => {
      const emoji = "😀"; // 4バイト
      const chunks = splitTextByCharsAndBytes(emoji.repeat(3), 1000, 1); // 1バイトでは絵文字1個も入らない
      expect(chunks.join("")).toBe(emoji.repeat(3));
      expect(hasLoneSurrogateAtBoundary(chunks)).toBe(false);
      // 契約どおり、この極端なケースでは各chunkがmaxBytes(1)を超過することを許容する
      expect(byteLength(chunks[0])).toBeGreaterThan(1);
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

    test("showDetails=falseでも複数ページ時は「ページ n/N」のみのfooterを表示する（旧embed挙動の復元）", () => {
      const metadata: FinalMetadata = { showDetails: false };
      expect(buildFinalFooterText(metadata, { page: 1, total: 3 })).toBe("ページ 1/3");
    });

    test("usage未取得でも複数ページ時は「ページ n/N」のみのfooterを表示する", () => {
      const metadata: FinalMetadata = { showDetails: true };
      expect(buildFinalFooterText(metadata, { page: 2, total: 3 })).toBe("ページ 2/3");
    });
  });

  describe("buildStoppedFooterText", () => {
    test("受信文字数0のときはTokensを含まず経過秒数のみ表示する", () => {
      expect(buildStoppedFooterText(12.34, 0)).toBe("🛑 Stopped | 12.3s");
      expect(buildStoppedFooterText(12.34, 0)).not.toContain("Tokens");
    });

    test("受信文字数がある場合は末尾に「NNN字」を追加する", () => {
      expect(buildStoppedFooterText(12.34, 840)).toBe("🛑 Stopped | 12.3s | 840字");
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

    test("複数message時は全messageにページ番号footerを表示し、最終messageのみLLM詳細を追加する（旧embed挙動の復元）", () => {
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

      // 非最終messageにも「ページ n/N」footerが付くが、LLM詳細は含まない
      expect(textContents(firstJson)).toEqual(["**Model:** gpt-5-mini", "part 1", "ページ 1/2"]);
      // 最終messageは「ページ n/N | <details>」
      expect(textContents(lastJson).at(-1)).toBe(`ページ 2/2 | ${buildUsageDetailsText(metadata)}`);
    });

    test("showLlmDetails=falseでも複数message時はページ番号のみのfooterを全messageに表示する", () => {
      const metadata: FinalMetadata = { showDetails: false };
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
      expect(textContents(firstJson).at(-1)).toBe("ページ 1/2");
      expect(textContents(lastJson).at(-1)).toBe("ページ 2/2");
    });

    test("単一message時にshowLlmDetails=falseだとfooterを表示しない", () => {
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
    test("isLastのときSectionを使わず `🛑 Stopped | xx.xs` のfooterを表示する（受信文字数0）", () => {
      const json = toJSON(
        buildStoppedContainer({
          text: "partial text",
          modelName: "gpt-5-mini",
          color: 0xff0000,
          isFirst: true,
          isLast: true,
          elapsedSeconds: 5.6,
          receivedChars: 0,
        }),
      );
      expect(findSection(json)).toBeUndefined();
      const contents = textContents(json);
      expect(contents.at(-1)).toBe("🛑 Stopped | 5.6s");
      expect(contents.at(-1)).not.toContain("Tokens");
    });

    test("受信文字数がある場合はfooterに「NNN字」を含める", () => {
      const json = toJSON(
        buildStoppedContainer({
          text: "partial text",
          modelName: "gpt-5-mini",
          color: 0xff0000,
          isFirst: true,
          isLast: true,
          elapsedSeconds: 5.6,
          receivedChars: 840,
        }),
      );
      expect(textContents(json).at(-1)).toBe("🛑 Stopped | 5.6s | 840字");
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
          receivedChars: 840,
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

  describe("estimateFinalFooterBudget", () => {
    test("detailsが無くても、複数message時のページ番号表示に備え常にページprefixマージンを確保する", () => {
      expect(estimateFinalFooterBudget({ showDetails: false })).toEqual(budget(20, 30));
      expect(estimateFinalFooterBudget({ showDetails: true })).toEqual(budget(20, 30));
    });

    test("detailsがある場合はdetailsの文字数・バイト数 + ページprefixマージン", () => {
      const metadata: FinalMetadata = { showDetails: true, usage };
      const details = buildUsageDetailsText(metadata) ?? "";
      const detailsBudget = measureTextBudget(details);
      expect(estimateFinalFooterBudget(metadata)).toEqual(
        budget(detailsBudget.chars + 20, detailsBudget.bytes + 30),
      );
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
