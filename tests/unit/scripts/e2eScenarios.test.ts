import { describe, expect, test } from "bun:test";
import {
  type DiscordMessage,
  isFinished,
  isStreaming,
  SCENARIOS,
  snapshotKey,
  toReply,
} from "../../../scripts/e2e/scenarios";
import { STREAMING_LABEL } from "../../../src/utils/chatContainerBuilder";

const FOOTER = "Tokens: 1+2=3 | Cost: $0.000001 | Model: m | Latency: 10ms | Provider: P";

function message(id: string, texts: string[], extra: Partial<DiscordMessage> = {}): DiscordMessage {
  return {
    id,
    content: "",
    author: { id: "bot", username: "bot" },
    components: [{ type: 17, components: texts.map((content) => ({ type: 10, content })) }],
    ...extra,
  };
}

function check(name: string, messages: DiscordMessage[]): string[] {
  const scenario = SCENARIOS.find((s) => s.name === name);
  if (!scenario) throw new Error(`no scenario ${name}`);
  return scenario.check(toReply(messages));
}

describe("e2e scenarios: 完了判定の材料", () => {
  function streamingPage(id: string): DiscordMessage {
    const page = message(id, ["本文"]);
    page.components = [
      {
        type: 17,
        components: [
          { type: 10, content: "本文" },
          {
            type: 9,
            components: [{ type: 10, content: STREAMING_LABEL }],
            accessory: { type: 2, label: "停止", custom_id: "stop_response_123" },
          },
        ],
      },
    ];
    return page;
  }

  test("streaming は停止ボタンの component で判定し、本文が「生成中...」を引用していても完了した返信を streaming と見なさない", () => {
    expect(isStreaming(toReply([streamingPage("1")]))).toBe(true);
    const quoting = toReply([message("1", [`ラベルは「${STREAMING_LABEL}」です`, FOOTER])]);
    expect(isStreaming(quoting)).toBe(false);
    expect(isFinished(quoting)).toBe(true);
  });

  test("停止ボタンが消えただけの途中のページは完了と見なさない（次ページの送信が遅れている間の誤判定を防ぐ）", () => {
    // updater は前ページから streaming の Section を外してから次ページを送る。
    expect(isFinished(toReply([message("1", ["1 ページ目の本文"])]))).toBe(false);
    expect(isFinished(toReply([message("1", ["1 ページ目"]), streamingPage("2")]))).toBe(false);
    expect(isFinished(toReply([]))).toBe(false);
  });

  test("final の footer、停止 footer、エラー表示のいずれかがあれば完了と見なす", () => {
    expect(isFinished(toReply([message("1", ["本文", FOOTER])]))).toBe(true);
    expect(isFinished(toReply([message("1", ["本文", "🛑 Stopped | 4.9s | 360字"])]))).toBe(true);
    expect(isFinished(toReply([message("1", ["## ⚠️ エラー\n\n失敗しました"])]))).toBe(true);
  });

  test("snapshotKey はメッセージの追加と編集で変わる（ページ送信の合間を完了と誤認しないため）", () => {
    const first = toReply([message("1", ["a"])]);
    const edited = toReply([message("1", ["a"], { edited_timestamp: "2026-09-20T00:00:01Z" })]);
    const added = toReply([message("1", ["a"]), message("2", ["b"])]);
    expect(snapshotKey(edited)).not.toBe(snapshotKey(first));
    expect(snapshotKey(added)).not.toBe(snapshotKey(first));
    expect(snapshotKey(toReply([message("1", ["a"])]))).toBe(snapshotKey(first));
  });
});

describe("e2e scenarios: check", () => {
  test("image: 画像が渡っていない返答（'An image is required.'）では通らない", () => {
    expect(check("image", [message("1", ["An image is required.", FOOTER])])).not.toEqual([]);
    expect(check("image", [message("1", ["NO-IMAGE", FOOTER])])).not.toEqual([]);
    expect(
      check("image", [
        message("1", ["NO-IMAGE. If the image were red the answer would be COLOR-RED.", FOOTER]),
      ]),
    ).not.toEqual([]);
    expect(check("image", [message("1", ["COLOR-RED", FOOTER])])).toEqual([]);
  });

  test("stop: 本文に Stopped という語があるだけでは通らず、停止 footer を要求する", () => {
    expect(check("stop", [message("1", ["The river Stopped flowing.", FOOTER])])).not.toEqual([]);
    expect(check("stop", [message("1", ["ナイル川は", "🛑 Stopped | 4.9s | 360字"])])).toEqual([]);
  });

  test("long: 最終ページの footer が n/n で、メッセージ数と一致しなければ通らない", () => {
    const page = (n: number, total: number, last = false): DiscordMessage =>
      message(String(n), ["本文", `ページ ${n}/${total}${last ? ` | ${FOOTER}` : ""}`]);
    expect(check("long", [page(1, 3), page(2, 3), page(3, 3, true)])).toEqual([]);
    // 途中までしか届いていない
    expect(check("long", [page(1, 3), page(2, 3)])).not.toEqual([]);
    // メッセージ数と usage footer は揃っているが、最後のページ番号が n/n でない
    expect(check("long", [page(1, 3), page(2, 3), page(2, 3, true)])).not.toEqual([]);
    // footer の総数とメッセージ数が食い違う（他の返信が混入した）
    expect(check("long", [page(1, 2), page(2, 2, true), message("x", ["別の返信"])])).not.toEqual(
      [],
    );
    // 分割されていない
    expect(check("long", [message("1", ["本文", FOOTER])])).not.toEqual([]);
  });

  test("usage footer の無い返信は chat / pdf でも通らない（エラー表示や途中の表示を成功と見なさない）", () => {
    expect(check("chat", [message("1", ["接続確認OK"])])).not.toEqual([]);
    expect(check("pdf", [message("1", ["PINEAPPLE"])])).not.toEqual([]);
    expect(check("pdf", [message("1", ["PINEAPPLE", FOOTER])])).toEqual([]);
  });
});
