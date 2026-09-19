import { describe, expect, test } from "bun:test";
import {
  type DiscordMessage,
  isFinished,
  isStreaming,
  modelOf,
  SCENARIOS,
  snapshotKey,
  toReply,
} from "../../../scripts/e2e/scenarios";
import { EmbedColors } from "../../../src/types/embed";
import {
  buildErrorContainer,
  buildFinalContainer,
  buildStoppedContainer,
  buildStreamingContainer,
} from "../../../src/utils/chatContainerBuilder";

const USAGE =
  "Tokens: 1+2=3 | Cost: $0.000001 | Model: vendor/model-x | Latency: 10ms | Provider: P";
const STOPPED = "🛑 Stopped | 4.9s | 360字";

/** A page shaped the way the renderer shapes it: texts, then Separator + footer when there is one. */
function page(
  id: string,
  body: string[],
  footer?: string,
  extra: Partial<DiscordMessage> = {},
): DiscordMessage {
  const components: unknown[] = body.map((content) => ({ type: 10, content }));
  if (footer !== undefined) components.push({ type: 14 }, { type: 10, content: footer });
  return {
    id,
    content: "",
    author: { id: "bot", username: "bot" },
    components: [{ type: 17, accent_color: 0x123456, components }],
    ...extra,
  };
}

function streamingPage(id: string, body: string): DiscordMessage {
  return {
    ...page(id, [body]),
    components: [
      {
        type: 17,
        components: [
          { type: 10, content: body },
          {
            type: 9,
            components: [{ type: 10, content: "生成中..." }],
            accessory: { type: 2, label: "停止", custom_id: "stop_response_123" },
          },
        ],
      },
    ],
  };
}

function check(name: string, messages: DiscordMessage[]): string[] {
  const scenario = SCENARIOS.find((s) => s.name === name);
  if (!scenario) throw new Error(`no scenario ${name}`);
  return scenario.check(toReply(messages));
}

describe("e2e scenarios: レンダラの実出力との整合", () => {
  // フィクスチャの形が実装とずれると以下の判定テスト全体が無意味になるので、実際の builder の出力で確かめる。
  const base = { color: 0x123456, isFirst: true, isLast: true, modelName: "Model X" };

  function rendered(container: { toJSON: () => unknown }): DiscordMessage {
    return {
      id: "1",
      content: "",
      author: { id: "bot", username: "bot" },
      components: [container.toJSON()],
    };
  }

  test("final / stopped / error / streaming の各 container を正しく読み分ける", () => {
    const final = toReply([
      rendered(
        buildFinalContainer({
          ...base,
          text: "答え",
          metadata: {
            showDetails: true,
            model: "vendor/model-x",
            provider: "P",
            latency: 10,
            usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
          },
        }),
      ),
    ]);
    expect(isFinished(final)).toBe(true);
    expect(final.footers).toHaveLength(1);
    expect(final.body).toContain("答え");
    expect(final.body).not.toContain("Tokens:");
    expect(modelOf(final)).toBe("vendor/model-x");

    const stopped = toReply([
      rendered(
        buildStoppedContainer({
          ...base,
          text: "途中",
          elapsedSeconds: 4.9,
          receivedChars: 360,
        }),
      ),
    ]);
    expect(isFinished(stopped)).toBe(true);
    expect(check("stop", stopped.messages)).toEqual([]);

    const error = toReply([rendered(buildErrorContainer("失敗しました"))]);
    expect(error.isError).toBe(true);
    expect(isFinished(error)).toBe(true);

    const streaming = toReply([
      rendered(
        buildStreamingContainer({
          ...base,
          text: "書いている途中",
          triggerMessageId: "123",
        }),
      ),
    ]);
    expect(isStreaming(streaming)).toBe(true);
    expect(isFinished(streaming)).toBe(false);
  });
});

describe("e2e scenarios: 完了判定", () => {
  test("本文が footer・停止表示・エラー見出し・生成中ラベルを引用していても、構造が伴わなければ完了と見なさない", () => {
    // 次ページの送信が遅れている間の 1 ページ目: 停止ボタンは消えているが footer の component は無い
    const quoting = toReply([page("1", [`${USAGE}\n${STOPPED}\n## ⚠️ エラー\n生成中...`])]);
    expect(isStreaming(quoting)).toBe(false);
    expect(isFinished(quoting)).toBe(false);
    expect(quoting.isError).toBe(false);
  });

  test("赤い container でも、本文ページ（複数メッセージや複数 component）はエラー表示と見なさない", () => {
    const red = page("1", ["## ⚠️ と始まる本文", "続き"]);
    (red.components?.[0] as Record<string, unknown>).accent_color = EmbedColors.RED;
    expect(toReply([red]).isError).toBe(false);
  });

  test("停止ボタンが残っているページが 1 つでもあれば完了と見なさない", () => {
    expect(isFinished(toReply([page("1", ["1 ページ目"]), streamingPage("2", "2 ページ目")]))).toBe(
      false,
    );
    expect(isFinished(toReply([]))).toBe(false);
  });

  test("最終ページの footer が usage か停止表示なら完了と見なす", () => {
    expect(isFinished(toReply([page("1", ["本文"], USAGE)]))).toBe(true);
    expect(isFinished(toReply([page("1", ["本文"], STOPPED)]))).toBe(true);
    // ページ番号だけの footer（非最終ページ）は完了の根拠にならない
    expect(isFinished(toReply([page("1", ["本文"], "ページ 1/2")]))).toBe(false);
  });

  test("snapshotKey はメッセージの追加と編集で変わる", () => {
    const first = toReply([page("1", ["a"])]);
    const edited = toReply([
      page("1", ["a"], undefined, { edited_timestamp: "2026-09-20T00:00:01Z" }),
    ]);
    const added = toReply([page("1", ["a"]), page("2", ["b"])]);
    expect(snapshotKey(edited)).not.toBe(snapshotKey(first));
    expect(snapshotKey(added)).not.toBe(snapshotKey(first));
    expect(snapshotKey(toReply([page("1", ["a"])]))).toBe(snapshotKey(first));
  });
});

describe("e2e scenarios: check", () => {
  test("image: 画像が渡っていない返答や、複数の答えを並べた返答では通らない", () => {
    expect(check("image", [page("1", ["An image is required."], USAGE)])).not.toEqual([]);
    expect(check("image", [page("1", ["NO-IMAGE"], USAGE)])).not.toEqual([]);
    expect(
      check("image", [
        page("1", ["NO-IMAGE. If the image were red the answer would be COLOR-RED."], USAGE),
      ]),
    ).not.toEqual([]);
    expect(check("image", [page("1", ["COLOR-RED"], USAGE)])).toEqual([]);
  });

  test("stop: 本文が停止表示を丸ごと引用していても通らず、footer の component を要求する", () => {
    expect(check("stop", [page("1", [`川の話。${STOPPED}`], USAGE)])).not.toEqual([]);
    expect(check("stop", [page("1", ["ナイル川は"], STOPPED)])).toEqual([]);
  });

  test("long: 最終ページの footer が n/n で、メッセージ数と一致しなければ通らない", () => {
    const pages = (footers: string[]): DiscordMessage[] =>
      footers.map((footer, i) => page(String(i + 1), ["本文"], footer));
    expect(check("long", pages(["ページ 1/3", "ページ 2/3", `ページ 3/3 | ${USAGE}`]))).toEqual([]);
    // メッセージ数と usage は揃っているが、最後のページ番号が n/n でない
    expect(check("long", pages(["ページ 1/3", "ページ 2/3", `ページ 2/3 | ${USAGE}`]))).not.toEqual(
      [],
    );
    // footer の総数とメッセージ数が食い違う（他の返信が混入した）
    expect(check("long", pages(["ページ 1/2", "別の返信", `ページ 2/2 | ${USAGE}`]))).not.toEqual(
      [],
    );
    // 分割されていない
    expect(check("long", [page("1", ["本文"], USAGE)])).not.toEqual([]);
  });

  test("答えの語が footer にしか無い場合や、usage footer が無い場合は通らない", () => {
    expect(check("pdf", [page("1", ["わかりません"], `PINEAPPLE | ${USAGE}`)])).not.toEqual([]);
    expect(check("pdf", [page("1", ["PINEAPPLE"])])).not.toEqual([]);
    expect(check("chat", [page("1", ["接続確認OK"])])).not.toEqual([]);
    expect(check("pdf", [page("1", ["PINEAPPLE"], USAGE)])).toEqual([]);
  });
});
