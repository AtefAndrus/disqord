import { describe, expect, test } from "bun:test";
import {
  costOf,
  type DiscordMessage,
  IMAGE_TOKEN,
  isFinished,
  isStreaming,
  LONG_NUMBER_COUNT,
  LONG_NUMBERS_PER_LINE,
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
  REASONING_COMPONENT_ID,
} from "../../../src/utils/chatContainerBuilder";

const USAGE = "Tokens: 1+2=3 | Cost: $0.000001 | Model: vendor/model-x | Time: 0.0s | Provider: P";
const STOPPED = "🛑 Stopped | 4.9s | 360字";

/** A page shaped the way the renderer shapes it: texts, then Separator + footer when there is one. */
function page(
  id: string,
  body: string[],
  footer?: string,
  extra: Partial<DiscordMessage> = {},
): DiscordMessage {
  const components: unknown[] = body.map((content) => ({ type: 10, content }));
  if (footer !== undefined)
    components.push({ type: 14, divider: false }, { type: 10, content: footer });
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

  test("途中まで出力したあとのエラー（部分ページ + 末尾のエラー container）は完了と見なす", () => {
    const errorPage: DiscordMessage = {
      id: "2",
      content: "",
      author: { id: "bot", username: "bot" },
      components: [buildErrorContainer("ストリームが途切れました").toJSON()],
    };
    const reply = toReply([page("1", ["途中までの本文"]), errorPage]);
    expect(reply.isError).toBe(true);
    expect(isFinished(reply)).toBe(true);
  });

  test("最終ページに usage footer があっても、停止ボタンの残るページがあれば完了と見なさない", () => {
    const reply = toReply([streamingPage("1", "1 ページ目"), page("2", ["2 ページ目"], USAGE)]);
    expect(isStreaming(reply)).toBe(true);
    expect(isFinished(reply)).toBe(false);
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
  test("separator: divider 付きの Separator があり、本文に --- が残っていないときだけ通る", () => {
    const withBreak = (divider: boolean, body = ["前半", "後半"]): DiscordMessage => {
      const base = page("1", [], USAGE);
      const [container] = (base.components ?? []) as { components: unknown[] }[];
      return {
        ...base,
        components: [
          {
            ...(container as object),
            components: [
              { type: 10, content: body[0] },
              { type: 14, divider },
              { type: 10, content: body[1] },
              ...(container?.components ?? []),
            ],
          },
        ],
      };
    };
    expect(check("separator", [withBreak(true)])).toEqual([]);
    expect(toReply([withBreak(true)]).body).toBe("前半\n---\n後半");
    expect(check("separator", [withBreak(false)])).not.toEqual([]);
    expect(check("separator", [page("1", ["前半\n---\n後半"], USAGE)])).not.toEqual([]);
  });

  test("image: 画像に描いた数字を答えたときだけ通る", () => {
    expect(check("image", [page("1", ["An image is required."], USAGE)])).not.toEqual([]);
    const wrong = IMAGE_TOKEN === "111111" ? "222222" : "111111";
    expect(check("image", [page("1", [`数字: ${wrong}`], USAGE)])).not.toEqual([]);
    expect(check("image", [page("1", [`数字: ${IMAGE_TOKEN}`], USAGE)])).toEqual([]);
  });

  test("search: footer に検索回数、本文に検索結果のリンクと「公開日: 2026-08-20」の行があるときだけ通る", () => {
    const searched = `${USAGE} | Searches: 1`;
    const links = "-# 検索結果\n- [Bun 1.4 (bun.com)](<https://bun.com/blog/bun-v1.4>)";
    const body = (answer: string): string[] => [`${answer}\n\n${links}`];
    expect(check("search", [page("1", body("公開日: 2026-08-20"), searched)])).toEqual([]);
    // 検索エンジン名つきのフッター（実際の表示）
    expect(
      check("search", [
        page("1", body("公開日: 2026-08-20"), `${USAGE} | Searches: 3 (perplexity) | TPS: 1.00`),
      ]),
    ).toEqual([]);
    // 太字や全角コロンで書かれても同じ行として読む
    expect(check("search", [page("1", body("**公開日：2026-08-20**"), searched)])).toEqual([]);
    // 検索していない、または本文だけが検索回数を名乗っている
    expect(check("search", [page("1", body("公開日: 2026-08-20"), USAGE)])).not.toEqual([]);
    expect(
      check("search", [page("1", body("公開日: 2026-08-20\nSearches: 1"), USAGE)]),
    ).not.toEqual([]);
    // 検索は要求されたが結果が返らなかった（リンクが無い）
    expect(check("search", [page("1", ["公開日: 2026-08-20"], searched)])).not.toEqual([]);
    // 日付違いと、指定の形になっていない回答
    expect(check("search", [page("1", body("公開日: 2026-08-21"), searched)])).not.toEqual([]);
    expect(check("search", [page("1", body("2026年8月20日です。"), searched)])).not.toEqual([]);
  });

  test("reasoning: モデル名の直後に spoiler の推論があるときだけ通り、本文には数えない", () => {
    const withReasoning = (
      reasoning: Record<string, unknown>,
      at = 1,
      extra: unknown[] = [],
    ): DiscordMessage => {
      const base = page("1", ["**Model:** m", "答え"], USAGE);
      const [container] = (base.components ?? []) as { components: unknown[] }[];
      const children = [...(container?.components ?? [])];
      children.splice(at, 0, { type: 10, ...reasoning }, ...extra);
      return { ...base, components: [{ ...(container as object), components: children }] };
    };
    const ok = { id: REASONING_COMPONENT_ID, content: "-# 推論\n||考えた||" };
    expect(check("reasoning", [withReasoning(ok)])).toEqual([]);
    expect(toReply([withReasoning(ok)]).body).not.toContain("考えた");
    expect(check("reasoning", [withReasoning(ok, 2)])).not.toEqual([]);
    expect(
      check("reasoning", [
        withReasoning({ id: REASONING_COMPONENT_ID, content: "-# 推論\n考えた" }),
      ]),
    ).not.toEqual([]);
    const cut = {
      id: REASONING_COMPONENT_ID,
      content: "-# 推論\n||考…||\n-# 全文は reasoning.md にあります。",
    };
    expect(check("reasoning", [withReasoning(cut)])).not.toEqual([]);
    expect(check("reasoning", [withReasoning(cut, 1, [{ type: 13 }])])).toEqual([]);
    expect(
      check("reasoning", [withReasoning({ id: 7, content: "-# 推論\n||考えた||" })]),
    ).not.toEqual([]);
  });

  test("stop: 本文が停止表示を丸ごと引用していても通らず、footer の component を要求する", () => {
    expect(check("stop", [page("1", [`川の話。${STOPPED}`], USAGE)])).not.toEqual([]);
    expect(check("stop", [page("1", ["ナイル川は"], STOPPED)])).toEqual([]);
  });

  test("long: 最終ページの footer が n/n で、メッセージ数と一致しなければ通らない", () => {
    const code = '```python\nprint("hello")\n```';
    const all = Array.from({ length: LONG_NUMBER_COUNT }, (_, i) => i + 1);
    const lines = (numbers: number[]): string => {
      const rows: string[] = [];
      for (let i = 0; i < numbers.length; i += LONG_NUMBERS_PER_LINE) {
        rows.push(numbers.slice(i, i + LONG_NUMBERS_PER_LINE).join(" "));
      }
      return rows.join("\n");
    };
    // 本文は通る内容にして、footer だけで落ちることを確かめる
    const pages = (footers: string[]): DiscordMessage[] =>
      footers.map((footer, i) =>
        page(String(i + 1), i === 0 ? [lines(all), code] : ["本文"], footer),
      );
    const numbered = (numbers: number[]): DiscordMessage[] => {
      const half = Math.floor(numbers.length / 2);
      return [
        page("1", [lines(numbers.slice(0, half)), code], "ページ 1/2"),
        page("2", [lines(numbers.slice(half))], `ページ 2/2 | ${USAGE}`),
      ];
    };
    expect(check("long", numbered(all))).toEqual([]);
    expect(check("long", pages(["ページ 1/3", "ページ 2/3", `ページ 3/3 | ${USAGE}`]))).toEqual([]);
    // ページの境目で 1 つ欠けた・重複した・途中で打ち切った
    expect(check("long", numbered(all.filter((n) => n !== LONG_NUMBER_COUNT / 2)))).not.toEqual([]);
    expect(check("long", numbered([...all, LONG_NUMBER_COUNT]))).not.toEqual([]);
    expect(check("long", numbered(all.slice(0, 800)))).not.toEqual([]);
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

describe("costOf", () => {
  test("実際の footer から、全ターン合算の Cost を最終ページで読む", () => {
    const container = buildFinalContainer({
      color: 0x123456,
      isFirst: true,
      isLast: true,
      modelName: "Model X",
      text: "答え",
      metadata: {
        showDetails: true,
        model: "vendor/model-x",
        provider: "P",
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3, cost: 0.0123456 },
      },
    });
    const reply = toReply([
      page("1", ["前半"], "ページ 1/2"),
      {
        id: "2",
        content: "",
        author: { id: "bot", username: "bot" },
        components: [container.toJSON()],
      },
    ]);

    expect(costOf(reply)).toBe(0.012346);
  });

  test("Cost の無い footer（停止、usage に cost が無い応答）では undefined を返す", () => {
    expect(costOf(toReply([page("1", ["途中"], STOPPED)]))).toBeUndefined();
    expect(costOf(toReply([page("1", ["答え"], "Tokens: 1+2=3 | Provider: P")]))).toBeUndefined();
  });
});
