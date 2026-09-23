import { describe, expect, mock, test } from "bun:test";
import { createStopper, DeadlineError, waitForReply } from "../../../scripts/e2e/runner";
import { type DiscordMessage, type Reply, toReply } from "../../../scripts/e2e/scenarios";

const USAGE = "Tokens: 1+2=3 | Model: m | Provider: P";

function page(id: string, body: string, footer?: string): DiscordMessage {
  const components: unknown[] = [{ type: 10, content: body }];
  if (footer !== undefined)
    components.push({ type: 14, divider: false }, { type: 10, content: footer });
  return {
    id,
    content: "",
    author: { id: "bot", username: "bot" },
    components: [{ type: 17, components }],
  };
}

/** Feeds `waitForReply` one scripted read per poll; the deadline passes when the script runs out. */
function scripted(reads: (Reply | Error)[]): {
  read: () => Promise<Reply>;
  pause: () => Promise<void>;
  polls: () => number;
} {
  let polls = 0;
  return {
    polls: () => polls,
    pause: async () => {
      if (polls >= reads.length) throw new DeadlineError("deadline");
    },
    read: async () => {
      const next = reads[polls++];
      if (next instanceof Error) throw next;
      return next as Reply;
    },
  };
}

describe("waitForReply", () => {
  const unfinishedFirstPage = toReply([page("1", "1 ページ目")]);
  const finished = toReply([
    page("1", "1 ページ目", "ページ 1/2"),
    page("2", "2 ページ目", `ページ 2/2 | ${USAGE}`),
  ]);

  test("次ページの送信が何ポーリング遅れても、停止ボタンの無い途中のページを完了と見なさない", async () => {
    const io = scripted([
      ...Array.from({ length: 6 }, () => unfinishedFirstPage),
      finished,
      finished,
      finished,
    ]);

    const reply = await waitForReply(io);

    expect(reply.messages).toHaveLength(2);
    expect(io.polls()).toBe(9);
  });

  test("終端状態になっても、表示が変化しなくなるまでは返さない", async () => {
    const stillEditing = toReply([{ ...page("1", "本文", USAGE), edited_timestamp: "t1" }]);
    const settled = toReply([{ ...page("1", "本文", USAGE), edited_timestamp: "t2" }]);
    const io = scripted([stillEditing, settled, settled, settled]);

    await waitForReply(io);

    expect(io.polls()).toBe(4);
  });

  test("読み取りの失敗では諦めず、期限までポーリングを続ける", async () => {
    const io = scripted([new Error("HTTP 500"), new Error("reset"), finished, finished, finished]);

    const reply = await waitForReply(io);

    expect(reply.messages).toHaveLength(2);
  });

  test("期限までに終端状態にならなければ DeadlineError にする（返信が無い場合と途中の場合で文言を分ける）", async () => {
    await expect(
      waitForReply(scripted([unfinishedFirstPage, unfinishedFirstPage])),
    ).rejects.toThrow(/llm-details/);
    const never = waitForReply(scripted([toReply([]), toReply([])]));
    await expect(never).rejects.toBeInstanceOf(DeadlineError);
    await expect(waitForReply(scripted([toReply([])]))).rejects.toThrow("never replied");
  });
});

describe("createStopper", () => {
  function fakeChild(): { kill: ReturnType<typeof mock>; exited: Promise<void>; exit: () => void } {
    let exit: () => void = () => {};
    const exited = new Promise<void>((resolve) => {
      exit = resolve;
    });
    return { kill: mock(() => {}), exited, exit };
  }

  test("停止の途中でもう一度呼ばれても同じ完了を待ち、子プロセスの終了前には解決しない（割り込みで SIGKILL の予備が飛ばされない）", async () => {
    const child = fakeChild();
    let releaseGrace: () => void = () => {};
    const stop = createStopper(
      child,
      5_000,
      () => new Promise<void>((resolve) => (releaseGrace = resolve)),
    );

    const first = stop();
    const second = stop(); // the interrupt handler, while `finally` is already stopping
    let secondSettled = false;
    void second.then(() => {
      secondSettled = true;
    });
    await Bun.sleep(0);
    expect(second).toBe(first);
    expect(secondSettled).toBe(false);

    releaseGrace(); // the child ignored the first signal
    await Bun.sleep(0);
    expect(child.kill).toHaveBeenCalledTimes(2);
    expect(child.kill.mock.calls[1]).toEqual(["SIGKILL"]);
    expect(secondSettled).toBe(false);

    child.exit();
    await second;
    expect(secondSettled).toBe(true);
  });

  test("猶予内に終了した子プロセスには SIGKILL を送らない", async () => {
    const child = fakeChild();
    const stop = createStopper(child, 5_000, () => new Promise<void>(() => {}));

    const stopping = stop();
    child.exit();
    await stopping;

    expect(child.kill).toHaveBeenCalledTimes(1);
  });
});
