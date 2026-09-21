import { afterEach, describe, expect, mock, test } from "bun:test";
import { formatCostSummary, readKeyUsage, settledUsage } from "../../../scripts/e2e/cost";

/** Feeds `settledUsage` one scripted value per read. */
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

describe("settledUsage", () => {
  test("返信が報告した額に届いた後、同じ値を 2 回続けて読んだら確定する", async () => {
    const io = scripted([1.0, 1.01, 1.02, 1.02, 1.02]);

    const result = await settledUsage(io, 1.02, 1);

    expect(result).toEqual({ usage: 1.02, settled: true });
    expect(io.reads()).toBe(4);
  });

  test("返信が報告した額に届く前に値が止まっても、確定とは見なさない", async () => {
    const io = scripted([1.0, 1.0, 1.0, 1.02, 1.02]);

    const result = await settledUsage(io, 1.02, 1);

    expect(result).toEqual({ usage: 1.02, settled: true });
    expect(io.reads()).toBe(5);
  });

  test("footer の 6 桁への丸めの分だけ下回っても、報告額に届いたと見なす", async () => {
    const io = scripted([1.0199996, 1.0199996]);

    const result = await settledUsage(io, 1.02, 1);

    expect(result.settled).toBe(true);
  });

  test("読み取り回数の上限まで確定しなければ、最後の値を未確定として返す", async () => {
    const io = scripted([1.0, 1.01, 1.02, 1.03]);

    const result = await settledUsage(io, 1.0, 0, 4);

    expect(result).toEqual({ usage: 1.03, settled: false });
  });

  test("何も課金されない実行（無料モデル）は、開始時の値のまま確定する", async () => {
    const io = scripted([1.0, 1.0]);

    expect(await settledUsage(io, 1.0, 0)).toEqual({ usage: 1.0, settled: true });
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
  test("キーの増分を総額として出し、返信ごとの額と、どの返信にも出ていない差額を並べる", () => {
    const lines = formatCostSummary(
      [
        { name: "chat", cost: 0.00002 },
        { name: "long", cost: 0.02 },
      ],
      { amount: 0.0215, settled: true },
    );

    expect(lines[0]).toStartWith("COST $0.021500 billed to the OpenRouter key");
    expect(lines[0]).not.toContain("still changing");
    expect(lines[1]).toBe("     replies reported $0.020020: chat $0.000020, long $0.020000");
    expect(lines[2]).toContain("the other $0.001480 is in no reply's footer");
  });

  test("差額が丸め誤差の範囲なら差額の行を出さない", () => {
    const lines = formatCostSummary([{ name: "chat", cost: 0.000021 }], {
      amount: 0.0000212,
      settled: true,
    });

    expect(lines).toHaveLength(2);
  });

  test("確定しなかった増分には注記を付け、額の無いシナリオは unknown と書く", () => {
    const lines = formatCostSummary(
      [
        { name: "chat", cost: 0.00002 },
        { name: "long", cost: undefined },
      ],
      { amount: 0.00002, settled: false },
    );

    expect(lines[0]).toContain("still changing");
    expect(lines[1]).toContain("long unknown");
  });

  test("キーを読めなかったときは総額を unknown とし、返信の額だけを出す", () => {
    const lines = formatCostSummary([{ name: "chat", cost: 0.00002 }], undefined);

    expect(lines[0]).toBe("COST unknown: the OpenRouter key's usage could not be read");
    expect(lines[1]).toBe("     replies reported $0.000020: chat $0.000020");
  });
});
