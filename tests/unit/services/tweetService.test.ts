import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { getEventListeners } from "node:events";
import {
  extractTweetIds,
  formatTweetBlock,
  MAX_TWEET_IMAGES,
  parseTweetRecord,
  sanitizeTweetField,
  selectTweetImageUrls,
  TWEET_FETCH_DEADLINE_MS,
  TweetRequestLimiter,
  TweetService,
  type TweetStatus,
} from "../../../src/services/tweetService";

function status(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "status",
    text: "hello",
    created_timestamp: 0,
    likes: 1,
    reposts: 2,
    replies: 3,
    author: { name: "Alice", screen_name: "alice" },
    ...overrides,
  };
}

function jsonResponse(body: unknown, statusCode = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), { status: statusCode, headers });
}

describe("tweetService", () => {
  let originalFetch: typeof globalThis.fetch;
  let mockFetch: ReturnType<typeof mock>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    mockFetch = mock();
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test.each([
    "twitter.com",
    "www.twitter.com",
    "mobile.twitter.com",
    "x.com",
    "www.x.com",
    "fxtwitter.com",
    "fixupx.com",
    "vxtwitter.com",
  ])("accepted host を個別に抽出する: %s", (host) => {
    expect(extractTweetIds(`https://${host}/a/status/20`)).toEqual(["20"]);
  });

  test.each(["status", "statuses"])("accepted path を個別に抽出する: /%s/", (path) => {
    expect(extractTweetIds(`https://x.com/a/${path}/20`)).toEqual(["20"]);
  });

  test("/i/web/status/ の path を抽出する", () => {
    expect(extractTweetIds("https://x.com/i/web/status/20")).toEqual(["20"]);
  });

  test("ID の形式が不正な URL は除外する", () => {
    expect(
      extractTweetIds(
        [
          "https://x.com/a/status/1",
          "https://x.com/a/status/123456789012345678901",
          "https://x.com/a/status/not-number",
          "https://x.com/a/status/20",
        ].join(" "),
      ),
    ).toEqual(["20"]);
  });

  test("山括弧で囲まれた URL を抽出する", () => {
    expect(extractTweetIds("<https://x.com/a/status/20>")).toEqual(["20"]);
  });

  test.each([
    "[投稿](https://x.com/a/status/20)",
    "https://x.com/a/status/20。",
    "https://x.com/a/status/20、",
  ])("markdown link と URL 末尾の句読点から ID を抽出する: %s", (text) => {
    expect(extractTweetIds(text)).toEqual(["20"]);
  });

  test.each([
    "https://x.com/a/status/20abc",
    "https://x.com/a/status/20_1",
    "https://x.com/a/status/20%22evil",
  ])(
    "ID の直後に英数字、アンダースコア、パーセント記号が続く URL は先頭の数字に切り詰めず除外する: %s",
    (text) => {
      expect(extractTweetIds(text)).toEqual([]);
    },
  );

  test("続けて書かれた Markdown リンクをそれぞれ抽出する", () => {
    expect(extractTweetIds("[a](https://x.com/a/status/20)[b](https://x.com/b/status/21)")).toEqual(
      ["20", "21"],
    );
  });

  test.each([
    "https://evil.x.com/a/status/20",
    "https://x.com.evil.test/a/status/20",
    "https://x.com@evil.test/a/status/20",
  ])("対象ホストではない URL は除外する: %s", (text) => {
    expect(extractTweetIds(text)).toEqual([]);
  });

  test("同じ ID を重複排除する", () => {
    expect(
      extractTweetIds(
        "https://x.com/a/status/20 https://twitter.com/b/statuses/20 https://x.com/c/status/21",
      ),
    ).toEqual(["20", "21"]);
  });

  test("出現順で最大3件に制限する", () => {
    expect(
      extractTweetIds(
        [
          "https://x.com/a/status/20",
          "https://x.com/a/status/21",
          "https://x.com/a/status/22",
          "https://x.com/a/status/23",
        ].join(" "),
      ),
    ).toEqual(["20", "21", "22"]);
  });

  test("成功、tombstone、404をそれぞれ展開する", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ code: 200, status: status({ text: "ok" }) }))
      .mockResolvedValueOnce(
        jsonResponse({
          code: 200,
          status: { type: "tombstone", reason: "deleted" },
        }),
      )
      .mockResolvedValueOnce(new Response("", { status: 404 }));

    const result = await new TweetService("https://api.fxtwitter.test", "1.5.0").expandTweets(
      "https://x.com/a/status/20 https://x.com/a/status/21 https://x.com/a/status/22",
      new AbortController().signal,
    );

    expect(result.status).toBe("expanded");
    expect(result.textParts).toHaveLength(3);
    expect(result.textParts[0]?.text).toContain("本文:\nok");
    expect(result.textParts[1]?.text).toContain("取得できないポスト（理由: deleted）");
    expect(result.textParts[2]?.text).toContain("取得できないポスト（理由: 見つからない）");
    expect(mockFetch).toHaveBeenCalledTimes(3);
    const firstCall = mockFetch.mock.calls.find(([input]) => String(input).endsWith("/20")) as
      | [RequestInfo | URL, RequestInit]
      | undefined;
    expect(firstCall?.[1]?.headers).toEqual({ "User-Agent": "DisQord/1.5.0" });
  });

  test("400と非JSONは注入せず、警告に本文を含めない", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ code: 400, message: "bad" }, 400))
      .mockResolvedValueOnce(new Response("not json", { status: 200 }));

    const result = await new TweetService("https://api.fxtwitter.test", "1.5.0").expandTweets(
      "https://x.com/a/status/20 https://x.com/a/status/21",
      new AbortController().signal,
    );

    expect(result.status).toBe("none");
    expect(result.parts).toEqual([]);
    expect(console.warn).toHaveBeenCalledTimes(2);
    expect(console.warn).not.toHaveBeenCalledWith(expect.stringContaining("bad"));
  });

  test("HTTP 200 の body 読み取りネットワークエラーは1回だけ再試行する", async () => {
    const brokenResponse = new Response("", { status: 200 });
    brokenResponse.json = (): Promise<unknown> =>
      Promise.reject(new TypeError("connection reset while reading body"));
    mockFetch
      .mockResolvedValueOnce(brokenResponse)
      .mockResolvedValueOnce(jsonResponse({ code: 200, status: status({ text: "retried" }) }));

    const result = await new TweetService("https://api.fxtwitter.test", "1.5.0").expandTweets(
      "https://x.com/a/status/20",
      new AbortController().signal,
    );

    expect(result.textParts[0]?.text).toContain("retried");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  test("未読の body の cancel を始め、signal を abort してから、cancel の完了を待たずに枠を返す", async () => {
    const limiter = new TweetRequestLimiter(1);
    // Never settles: releasing the slot must not depend on it.
    const cancelBody = mock(() => new Promise<void>(() => {}));
    const response = new Response(new ReadableStream<Uint8Array>({ cancel: cancelBody }), {
      status: 404,
    });
    let firstSignal: AbortSignal | undefined;
    mockFetch.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/20")) {
        firstSignal = init?.signal ?? undefined;
        return Promise.resolve(response);
      }
      return Promise.resolve(jsonResponse({ code: 200, status: status({ text: "next" }) }));
    });

    const result = await new TweetService(
      "https://api.fxtwitter.test",
      "1.5.0",
      limiter,
    ).expandTweets(
      "https://x.com/a/status/20 https://x.com/a/status/21",
      new AbortController().signal,
    );

    expect(cancelBody).toHaveBeenCalledTimes(1);
    expect(firstSignal?.aborted).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ status: "expanded" });
  });

  test("429、5xx、ネットワークエラーは1回だけ再試行する", async () => {
    const attempts = new Map<string, number>();
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const id = String(input).split("/").at(-1) ?? "";
      const attempt = (attempts.get(id) ?? 0) + 1;
      attempts.set(id, attempt);
      if (id === "20" && attempt === 1) {
        return Promise.resolve(new Response("", { status: 429, headers: { "Retry-After": "0" } }));
      }
      if (id === "21" && attempt === 1) return Promise.resolve(new Response("", { status: 503 }));
      if (id === "22" && attempt === 1) return Promise.reject(new Error("network"));
      return Promise.resolve(jsonResponse({ code: 200, status: status({ text: `retry${id}` }) }));
    });

    const result = await new TweetService("https://api.fxtwitter.test", "1.5.0").expandTweets(
      "https://x.com/a/status/20 https://x.com/a/status/21 https://x.com/a/status/22",
      new AbortController().signal,
    );

    expect(result.textParts).toHaveLength(3);
    expect(result.textParts.every((part) => part.text.includes("retry"))).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(6);
  });

  test("2回連続で失敗したリクエストは3回目を送らない", async () => {
    mockFetch.mockRejectedValue(new Error("network"));

    const result = await new TweetService("https://api.fxtwitter.test", "1.5.0").expandTweets(
      "https://x.com/a/status/20",
      new AbortController().signal,
    );

    expect(result.status).toBe("none");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  test("既定の約500ms待機が終わるまで再試行を送らない", async () => {
    const requestTimes: number[] = [];
    mockFetch.mockImplementation(() => {
      requestTimes.push(performance.now());
      return requestTimes.length === 1
        ? Promise.resolve(new Response("", { status: 503 }))
        : Promise.resolve(jsonResponse({ code: 200, status: status({ text: "retried" }) }));
    });

    const result = await new TweetService("https://api.fxtwitter.test", "1.5.0").expandTweets(
      "https://x.com/a/status/20",
      new AbortController().signal,
    );

    expect(result.status).toBe("expanded");
    expect(requestTimes).toHaveLength(2);
    const firstRequestTime = requestTimes[0];
    const secondRequestTime = requestTimes[1];
    if (firstRequestTime === undefined || secondRequestTime === undefined) {
      throw new Error("expected two request timestamps");
    }
    expect(secondRequestTime - firstRequestTime).toBeGreaterThanOrEqual(450);
  });

  test("Retry-After が残りの総期限より大きければ再試行しない", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response("", { status: 429, headers: { "Retry-After": "6" } }),
    );

    const startedAt = performance.now();
    const result = await new TweetService("https://api.fxtwitter.test", "1.5.0").expandTweets(
      "https://x.com/a/status/20",
      new AbortController().signal,
    );

    expect(performance.now() - startedAt).toBeLessThan(1_000);
    expect(result.status).toBe("none");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test("Retry-Afterが無い429は既定の待ち時間で再試行する", async () => {
    mockFetch
      .mockResolvedValueOnce(new Response("", { status: 429 }))
      .mockResolvedValueOnce(jsonResponse({ code: 200, status: status({ text: "retried" }) }));

    const resultPromise = new TweetService("https://api.fxtwitter.test", "1.5.0").expandTweets(
      "https://x.com/a/status/20",
      new AbortController().signal,
    );
    const result = await resultPromise;

    expect(result.textParts[0]?.text).toContain("retried");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  test("HTTP-date形式の Retry-After は再試行しない", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response("", {
        status: 429,
        headers: { "Retry-After": "Wed, 21 Oct 2015 07:28:00 GMT" },
      }),
    );

    const result = await new TweetService("https://api.fxtwitter.test", "1.5.0").expandTweets(
      "https://x.com/a/status/20",
      new AbortController().signal,
    );

    expect(result.status).toBe("none");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test("不正な Retry-After は再試行しない", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response("", { status: 429, headers: { "Retry-After": "not-a-number" } }),
    );

    const result = await new TweetService("https://api.fxtwitter.test", "1.5.0").expandTweets(
      "https://x.com/a/status/20",
      new AbortController().signal,
    );

    expect(result.status).toBe("none");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test("引用、カード、ノート、投票、メディアを指定順で整形する", () => {
    const parsed = parseTweetRecord(
      status({
        text: "本文",
        quote: status({ text: "引用本文", author: { name: "Bob", screen_name: "bob" } }),
        card: { title: "タイトル", description: "説明", domain: "example.com" },
        community_note: { text: "注記" },
        poll: {
          choices: [
            { label: "はい", percentage: 60 },
            { label: "いいえ", percentage: 40 },
          ],
          total_votes: 10,
        },
        media: {
          photos: [{ url: "https://pbs.twimg.com/photo.jpg" }],
          videos: [{ thumbnail_url: "https://video.twimg.com/video.jpg" }],
        },
      }),
    );
    if (parsed?.type !== "status") throw new Error("expected status");

    expect(formatTweetBlock("20", parsed)).toBe(
      [
        '<untrusted-tweet url="https://x.com/i/status/20">',
        "投稿者: Alice (@alice)",
        "日時: 1970-01-01 09:00",
        "いいね 1 / リポスト 2 / 返信 3",
        "本文:",
        "本文",
        "引用元: Bob (@bob) 1970-01-01 09:00",
        "引用本文",
        "リンクカード: タイトル (example.com)",
        "説明",
        "コミュニティノート:",
        "注記",
        "投票: はい 60% / いいえ 40%（総投票数 10）",
        "メディア: 画像 1 枚、動画 1 本",
        "</untrusted-tweet>",
      ].join("\n"),
    );
  });

  test("引用元がtombstoneなら理由だけを引用元として整形する", () => {
    const parsed = parseTweetRecord(status({ quote: { type: "tombstone", reason: "private" } }));
    if (parsed?.type !== "status") throw new Error("expected status");

    expect(formatTweetBlock("20", parsed)).toContain("引用元: 取得できないポスト（理由: private）");
  });

  test("壊れた任意フィールドだけを捨てて本文は展開する", () => {
    const parsed = parseTweetRecord(
      status({
        text: "本文",
        quote: { type: "status", text: 123 },
        card: { title: 123 },
        community_note: { text: 123 },
        poll: { choices: [{ label: "ok", percentage: "bad" }], total_votes: 1 },
        media: { photos: [{ url: 123 }], videos: [] },
      }),
    );
    if (parsed?.type !== "status") throw new Error("expected status");

    expect(parsed.quote).toBeUndefined();
    expect(parsed.card).toBeUndefined();
    expect(parsed.communityNote).toBeUndefined();
    expect(parsed.poll).toBeUndefined();
    expect(parsed.media).toBeUndefined();
    expect(formatTweetBlock("20", parsed)).toContain("本文:\n本文");
  });

  test("Cf、改行、山括弧を無害化し、制限をコードポイントで適用する", () => {
    expect(sanitizeTweetField("na\u200bme\uFEFF\u2028x", 100, true)).toBe("name x");
    expect(sanitizeTweetField("<close>\nnext", 100)).toBe("＜close＞\nnext");
    expect(sanitizeTweetField("x".repeat(2_001), 2_000)).toBe(`${"x".repeat(1_993)}…（以下省略）`);
    expect(sanitizeTweetField("x".repeat(101), 100, true)).toBe(`${"x".repeat(99)}…`);
  });

  test("画像はhttpsかつ許可ホストだけを、写真、動画、引用の順で最大4枚選ぶ", () => {
    const record: TweetStatus = {
      type: "status",
      text: "x",
      author: { name: "a", screenName: "a" },
      createdTimestamp: 0,
      likes: 0,
      reposts: 0,
      replies: 0,
      media: {
        photos: [
          { url: "https://pbs.twimg.com/1" },
          { url: "http://pbs.twimg.com/2" },
          { url: "https://pbs.twimg.com.evil/3" },
        ],
        videos: [
          { thumbnailUrl: "https://video.twimg.com/4" },
          { thumbnailUrl: "https://not-video.twimg.com/5" },
        ],
      },
      quote: {
        type: "status",
        text: "q",
        author: { name: "q", screenName: "q" },
        createdTimestamp: 0,
        likes: 0,
        reposts: 0,
        replies: 0,
        media: {
          photos: [{ url: "https://pbs.twimg.com/6" }, { url: "https://pbs.twimg.com/7" }],
          videos: [],
        },
      },
    };

    expect(selectTweetImageUrls([record])).toEqual([
      "https://pbs.twimg.com/1",
      "https://video.twimg.com/4",
      "https://pbs.twimg.com/6",
      "https://pbs.twimg.com/7",
    ]);
  });

  test.each([false, null])("画像対応が %p のとき画像を追加しない", async (capable) => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        code: 200,
        status: status({ media: { photos: [{ url: "https://pbs.twimg.com/a" }], videos: [] } }),
      }),
    );
    const result = await new TweetService("https://api.fxtwitter.test", "1.5.0").expandTweets(
      "https://x.com/a/status/20",
      new AbortController().signal,
      async () => capable,
    );
    expect(result.imageParts).toEqual([]);
  });

  test("画像対応がtrueなら写真と動画サムネイルをツイート順に最大4枚追加する", async () => {
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const id = String(input).split("/").at(-1);
      const media =
        id === "20"
          ? {
              photos: [
                { url: "https://pbs.twimg.com/20-photo-1" },
                { url: "https://pbs.twimg.com/20-photo-2" },
              ],
              videos: [{ thumbnail_url: "https://video.twimg.com/20-video-1" }],
            }
          : {
              photos: [{ url: "https://pbs.twimg.com/21-photo-1" }],
              videos: [{ thumbnail_url: "https://video.twimg.com/21-video-1" }],
            };
      return Promise.resolve(jsonResponse({ code: 200, status: status({ media }) }));
    });

    const result = await new TweetService("https://api.fxtwitter.test", "1.5.0").expandTweets(
      "https://x.com/a/status/20 https://x.com/a/status/21",
      new AbortController().signal,
      async () => true,
    );

    expect(result.imageParts.map((part) => part.image_url.url)).toEqual([
      "https://pbs.twimg.com/20-photo-1",
      "https://pbs.twimg.com/20-photo-2",
      "https://video.twimg.com/20-video-1",
      "https://pbs.twimg.com/21-photo-1",
    ]);
    expect(result.imageParts).toHaveLength(MAX_TWEET_IMAGES);
  });

  test("画像対応判定の例外は画像なしとして扱う", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        code: 200,
        status: status({ media: { photos: [{ url: "https://pbs.twimg.com/a" }], videos: [] } }),
      }),
    );
    const result = await new TweetService("https://api.fxtwitter.test", "1.5.0").expandTweets(
      "https://x.com/a/status/20",
      new AbortController().signal,
      async () => {
        throw new Error("models unavailable");
      },
    );
    expect(result.imageParts).toEqual([]);
  });

  test("画像対応判定が総期限を超えたら、画像なしで本文だけを返す", async () => {
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((...args: Parameters<typeof originalSetTimeout>) => {
      const [handler, delay, ...rest] = args;
      return originalSetTimeout(handler, delay === TWEET_FETCH_DEADLINE_MS ? 0 : delay, ...rest);
    }) as typeof globalThis.setTimeout;
    mockFetch.mockResolvedValue(
      jsonResponse({
        code: 200,
        status: status({ media: { photos: [{ url: "https://pbs.twimg.com/a" }], videos: [] } }),
      }),
    );

    try {
      const result = await new TweetService("https://api.fxtwitter.test", "1.5.0").expandTweets(
        "https://x.com/a/status/20",
        new AbortController().signal,
        async () => new Promise<boolean | null>(() => {}),
      );

      expect(result.status).toBe("expanded");
      expect(result.imageParts).toEqual([]);
      expect(result.textParts).toHaveLength(1);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  test("body 読み取り中に総期限が切れても即座に返り、body・timer・listenerを残さない", async () => {
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    let scheduledTimers = 0;
    let clearedTimers = 0;
    globalThis.setTimeout = ((...args: Parameters<typeof originalSetTimeout>) => {
      const [handler, delay, ...rest] = args;
      scheduledTimers++;
      return originalSetTimeout(handler, delay === TWEET_FETCH_DEADLINE_MS ? 0 : delay, ...rest);
    }) as typeof globalThis.setTimeout;
    globalThis.clearTimeout = ((...args: Parameters<typeof originalClearTimeout>) => {
      clearedTimers++;
      return originalClearTimeout(...args);
    }) as typeof globalThis.clearTimeout;

    let bodyCancelled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        cancel: () => {
          bodyCancelled = true;
        },
      }),
      { status: 200 },
    );
    response.json = (): Promise<unknown> => new Promise<unknown>(() => {});
    mockFetch.mockResolvedValue(response);
    const controller = new AbortController();

    try {
      const startedAt = performance.now();
      const result = await new TweetService("https://api.fxtwitter.test", "1.5.0").expandTweets(
        "https://x.com/a/status/20",
        controller.signal,
      );

      expect(performance.now() - startedAt).toBeLessThan(1_000);
      expect(result.status).toBe("none");
      expect(bodyCancelled).toBe(true);
      expect(scheduledTimers).toBe(1);
      expect(clearedTimers).toBe(1);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  });

  test("スロット待ちの中断済み waiter は枠を取らず、次の FIFO waiter を通す", async () => {
    const limiter = new TweetRequestLimiter(1);
    const first = await limiter.acquire(new AbortController().signal);
    if (!first) throw new Error("first acquire failed");
    const abortedController = new AbortController();
    const aborted = limiter.acquire(abortedController.signal);
    const next = limiter.acquire(new AbortController().signal);
    abortedController.abort();
    expect(await aborted).toBeUndefined();
    first();
    const releaseNext = await next;
    expect(releaseNext).toBeFunction();
    releaseNext?.();
    expect(limiter.activeCount).toBe(0);
  });

  test("複数の待機 waiter に枠を FIFO 順で渡す", async () => {
    const limiter = new TweetRequestLimiter(1);
    const first = await limiter.acquire(new AbortController().signal);
    if (!first) throw new Error("first acquire failed");

    const order: string[] = [];
    const waiters = ["first", "second", "third"].map((label) =>
      (async (): Promise<(() => void) | undefined> => {
        const release = await limiter.acquire(new AbortController().signal);
        order.push(label);
        return release;
      })(),
    );

    first();
    const releaseFirst = await waiters[0];
    releaseFirst?.();
    const releaseSecond = await waiters[1];
    releaseSecond?.();
    const releaseThird = await waiters[2];
    releaseThird?.();

    expect(order).toEqual(["first", "second", "third"]);
    expect(limiter.activeCount).toBe(0);
  });

  test("4枠の上限を複数の expandTweets 呼び出しにまたがって守る", async () => {
    const limiter = new TweetRequestLimiter(4);
    let active = 0;
    let maximumActive = 0;
    let started = 0;
    let resolveFirstBatch!: () => void;
    let resolveSecondBatch!: () => void;
    const firstBatch = new Promise<void>((resolve) => {
      resolveFirstBatch = resolve;
    });
    const secondBatch = new Promise<void>((resolve) => {
      resolveSecondBatch = resolve;
    });
    const pending: Array<() => void> = [];
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const id = String(input).split("/").at(-1) ?? "";
      started++;
      active++;
      maximumActive = Math.max(maximumActive, active);
      if (started === 4) resolveFirstBatch();
      if (started === 8) resolveSecondBatch();
      return new Promise<Response>((resolve) => {
        pending.push(() => {
          active--;
          resolve(jsonResponse({ code: 200, status: status({ text: id }) }));
        });
      });
    });

    const service = new TweetService("https://api.fxtwitter.test", "1.5.0", limiter);
    const signal = new AbortController().signal;
    const expansions = Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        service.expandTweets(`https://x.com/a/status/${index + 20}`, signal),
      ),
    );

    await firstBatch;
    expect(active).toBe(4);
    expect(maximumActive).toBe(4);
    const firstPending = pending.splice(0);
    firstPending.forEach((resolve) => {
      resolve();
    });

    await secondBatch;
    expect(active).toBe(4);
    expect(maximumActive).toBe(4);
    const secondPending = pending.splice(0);
    secondPending.forEach((resolve) => {
      resolve();
    });

    const results = await expansions;
    expect(results.every((result) => result.status === "expanded")).toBe(true);
    expect(maximumActive).toBe(4);
    expect(limiter.activeCount).toBe(0);
  });

  test("枠を渡した直後の abort と二重 release でも枠を漏らさない", async () => {
    const limiter = new TweetRequestLimiter(1);
    const controller = new AbortController();
    const release = await limiter.acquire(controller.signal);
    if (!release) throw new Error("acquire failed");
    const queued = limiter.acquire(new AbortController().signal);

    controller.abort();
    release();
    release();

    const releaseQueued = await queued;
    expect(releaseQueued).toBeFunction();
    releaseQueued?.();
    expect(limiter.activeCount).toBe(0);
  });

  test("5秒の総期限で保留中の取得を打ち切り、取得済みのポストだけ返す", async () => {
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((...args: Parameters<typeof originalSetTimeout>) => {
      const [handler, delay, ...rest] = args;
      return originalSetTimeout(handler, delay === TWEET_FETCH_DEADLINE_MS ? 0 : delay, ...rest);
    }) as typeof globalThis.setTimeout;
    mockFetch.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const id = String(input).split("/").at(-1);
      if (id === "20") {
        return Promise.resolve(jsonResponse({ code: 200, status: status({ text: "ready" }) }));
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("deadline")), {
          once: true,
        });
      });
    });

    try {
      const result = await new TweetService("https://api.fxtwitter.test", "1.5.0").expandTweets(
        "https://x.com/a/status/20 https://x.com/a/status/21",
        new AbortController().signal,
      );

      expect(result.status).toBe("expanded");
      expect(result.textParts).toHaveLength(1);
      expect(result.textParts[0]?.text).toContain("ready");
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining("tweet 21: deadline exceeded"),
      );
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  test("fetch中のabortは cancelled を返す", async () => {
    mockFetch.mockImplementation(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    );
    const controller = new AbortController();
    const promise = new TweetService("https://api.fxtwitter.test", "1.5.0").expandTweets(
      "https://x.com/a/status/20",
      controller.signal,
    );
    await Promise.resolve();
    controller.abort();
    await expect(promise).resolves.toMatchObject({ status: "cancelled" });
  });
});
