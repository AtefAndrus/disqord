import { afterEach, describe, expect, mock, test } from "bun:test";
import { formatCostSummary, observeUsage, readKeyUsage } from "../../../scripts/e2e/cost";

/** Feeds `observeUsage` one scripted value per read. */
function scripted(values: number[]): {
  read: () => Promise<number>;
  pause: () => Promise<void>;
  reads: () => number;
} {
  let reads = 0;
  return {
    reads: () => reads,
    pause: async () => {},
    read: async () => {
      const value = values[Math.min(reads, values.length - 1)];
      reads++;
      return value as number;
    },
  };
}

describe("observeUsage", () => {
  test("返信が報告した額に届いた後、同じ値を 2 回続けて読んだら stable を返す", async () => {
    const io = scripted([1.0, 1.01, 1.02, 1.02, 1.02]);

    const result = await observeUsage(io, 1.02, 1);

    expect(result).toEqual({ usage: 1.02, state: "stable" });
    expect(io.reads()).toBe(4);
  });

  test("返信が報告した額に届く前に値が止まっても、stable とは見なさない", async () => {
    const io = scripted([1.0, 1.0, 1.0, 1.02, 1.02]);

    const result = await observeUsage(io, 1.02, 1);

    expect(result).toEqual({ usage: 1.02, state: "stable" });
    expect(io.reads()).toBe(5);
  });

  test("footer の 6 桁への丸めの分だけ下回っても、報告額に届いたと見なす", async () => {
    const io = scripted([1.0199996, 1.0199996]);

    expect((await observeUsage(io, 1.02, 1)).state).toBe("stable");
  });

  test("上限まで値が動き続けたら changing を返す", async () => {
    const io = scripted([1.0, 1.01, 1.02, 1.03]);

    expect(await observeUsage(io, 1.0, 0, 4)).toEqual({ usage: 1.03, state: "changing" });
  });

  test("上限まで報告額に届かなければ、値が動いていなくても below-reported を返す", async () => {
    const io = scripted([1.0]);

    expect(await observeUsage(io, 1.02, 1, 4)).toEqual({ usage: 1.0, state: "below-reported" });
  });

  test("何も課金されない実行（無料モデル）は、開始時の値のまま stable になる", async () => {
    const io = scripted([1.0, 1.0]);

    expect(await observeUsage(io, 1.0, 0)).toEqual({ usage: 1.0, state: "stable" });
  });
});

describe("readKeyUsage", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("GET /key の data.usage を返し、API キーを Bearer で送る", async () => {
    const fetchMock = mock(async () => Response.json({ data: { usage: 1.323106549 } }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    expect(await readKeyUsage("sk-test")).toBe(1.323106549);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/v1/key");
    expect(init.headers).toEqual({ Authorization: "Bearer sk-test" });
  });

  test("HTTP エラーと数値でない usage は例外にする", async () => {
    globalThis.fetch = mock(
      async () => new Response("", { status: 401 }),
    ) as unknown as typeof fetch;
    await expect(readKeyUsage("sk-test")).rejects.toThrow("HTTP 401");

    globalThis.fetch = mock(async () => Response.json({ data: {} })) as unknown as typeof fetch;
    await expect(readKeyUsage("sk-test")).rejects.toThrow("no numeric usage");
  });
});

describe("formatCostSummary", () => {
  test("キーの増分を観測値として出し、返信ごとの額と、どの footer にも無い差額を並べる", () => {
    const lines = formatCostSummary(
      [
        { name: "chat", cost: 0.00002 },
        { name: "long", cost: 0.02 },
      ],
      { amount: 0.0215, state: "stable" },
    );

    expect(lines).toEqual([
      "COST $0.021500 of OpenRouter credits observed on the key during this run",
      "     replies reported $0.020020: chat $0.000020, long $0.020000",
      "     $0.001480 of the key's change is not accounted for by the collected footers (source unknown)",
    ]);
  });

  test("差額が丸め誤差の範囲なら差額の行を出さない", () => {
    const lines = formatCostSummary([{ name: "chat", cost: 0.000021 }], {
      amount: 0.0000212,
      state: "stable",
    });

    expect(lines).toHaveLength(2);
  });

  test("観測の状態ごとに注記を変える", () => {
    const [changing] = formatCostSummary([], { amount: 0.1, state: "changing" });
    const [below] = formatCostSummary([], { amount: 0, state: "below-reported" });

    expect(changing).toContain("still changing");
    expect(below).toContain("less than the replies reported");
    expect(below).not.toContain("still changing");
  });

  test("額の無いシナリオは unknown と書き、後から課金されうることを注記する", () => {
    const lines = formatCostSummary(
      [
        { name: "chat", cost: 0.00002 },
        { name: "long", cost: undefined },
      ],
      { amount: 0.00002, state: "stable" },
    );

    expect(lines[1]).toContain("long unknown");
    expect(lines[2]).toContain("may still be billed after this run");
  });

  test("キーを読めなかったときは総額を unknown とし、返信の額だけを出す", () => {
    const lines = formatCostSummary([{ name: "chat", cost: 0.00002 }], undefined);

    expect(lines).toEqual([
      "COST unknown: the OpenRouter key's usage could not be read",
      "     replies reported $0.000020: chat $0.000020",
    ]);
  });
});
