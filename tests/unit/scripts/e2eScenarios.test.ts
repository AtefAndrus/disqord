import { Database } from "bun:sqlite";
import { describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionFlagsBits } from "discord.js";
import { cronPreconditions, isProposalCard, type ScenarioEnv } from "../../../scripts/e2e/cron";
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
  type ScenarioPost,
  snapshotKey,
  toReply,
} from "../../../scripts/e2e/scenarios";
import { sendScenario } from "../../../scripts/e2e/send";
import { applyMigrations } from "../../../src/db/schema";
import { WINDOW_RAW_MESSAGE_LIMIT } from "../../../src/services/conversationWindow";
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
const RESTART_STOPPED = "🛑 Stopped by restart | 4.9s | 360字";

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

const env: ScenarioEnv = { databasePath: ":memory:", testerBotId: "tester" };

test("cron e2e recognises approval cards with the shown search value", () => {
  expect(isProposalCard({ components: [{ custom_id: "cron:proposal:approve:17:1" }] })).toBe(true);
  expect(isProposalCard({ components: [{ custom_id: "cron:proposal:approve:17:0" }] })).toBe(true);
  expect(isProposalCard({ components: [{ custom_id: "cron:proposal:approve:17" }] })).toBe(false);
});

function check(name: string, messages: DiscordMessage[]): string[] {
  const scenario = SCENARIOS.find((s) => s.name === name);
  if (!scenario) throw new Error(`no scenario ${name}`);
  return scenario.check(toReply(messages));
}

test("discord-tools cleanup removes the thread and pin after a failed verification", async () => {
  const scenario = SCENARIOS.find((item) => item.name === "discord-tools");
  if (!scenario?.cleanup) throw new Error("discord-tools cleanup missing");
  const request = mock(async (path: string, init?: RequestInit) => {
    if (!init) return Response.json({ thread: { id: "thread" }, pinned: true });
    if (path === "/channels/thread") return new Response(null, { status: 403 });
    return new Response(null, { status: 204 });
  });
  expect(await scenario.cleanup("trigger", "channel", request, env, 0)).toEqual([
    "cannot delete thread: HTTP 403",
  ]);
  expect(request).toHaveBeenCalledWith("/channels/thread", { method: "DELETE" });
  expect(request).toHaveBeenCalledWith("/channels/channel/pins/trigger", { method: "DELETE" });
});

describe("cron scenario preconditions", () => {
  function setup(
    cronEnabled: number,
    adminRoleId: string | null,
  ): { dir: string; env: ScenarioEnv } {
    const dir = mkdtempSync(join(tmpdir(), "disqord-e2e-"));
    const databasePath = join(dir, "bot.db");
    const db = new Database(databasePath);
    // The scenario code opens the database by path, so these tests cannot use
    // :memory:. Each commit to a file fsyncs, and on a slow disk (WSL) the
    // migrations alone took seconds and pushed tests past the 5s timeout. A
    // throwaway file needs no durability.
    db.run("PRAGMA synchronous = OFF");
    applyMigrations(db);
    db.query(
      "INSERT INTO guild_settings (guild_id, default_model, cron_enabled, admin_role_id) VALUES ('guild', 'm', ?, ?)",
    ).run(cronEnabled, adminRoleId);
    db.close();
    return { dir, env: { databasePath, testerBotId: "tester" } };
  }
  function discord(testerRoles: string[], rolePermissions: Record<string, bigint>) {
    return mock(async (path: string) => {
      if (path === "/channels/channel") return Response.json({ guild_id: "guild" });
      if (path === "/guilds/guild/members/tester") return Response.json({ roles: testerRoles });
      if (path === "/guilds/guild/roles")
        return Response.json(
          Object.entries(rolePermissions).map(([id, bits]) => ({ id, permissions: String(bits) })),
        );
      return new Response(null, { status: 404 });
    });
  }

  test("passes with the setting on and a tester holding the admin role", async () => {
    const { dir, env } = setup(1, "admin");
    try {
      expect(
        await cronPreconditions("channel", discord(["admin"], { guild: 0n, admin: 0n }), env),
      ).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("reports the setting and a tester without ManageGuild or the admin role", async () => {
    const { dir, env } = setup(0, null);
    try {
      const problems = await cronPreconditions(
        "channel",
        discord(["member"], { guild: 0n, member: PermissionFlagsBits.SendMessages }),
        env,
      );
      expect(problems).toHaveLength(2);
      expect(problems[0]).toContain("定期実行 is off");
      expect(problems[1]).toContain("cannot propose");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("cleanup removes the tester's rows in the channel created since the start, without a trigger", async () => {
    const { dir, env } = setup(1, null);
    try {
      const db = new Database(env.databasePath);
      db.run("PRAGMA synchronous = OFF");
      const job = (user: string, channel: string, createdAt: number): void => {
        db.query(`INSERT INTO cron_jobs
          (guild_id,channel_id,user_id,name,prompt,kind,expr,status,next_run_at,created_at,updated_at)
          VALUES ('guild',?,?,'e2e-x','p','once','2026-10-01T00:00:00.000Z','active',1,?,?)`).run(
          channel,
          user,
          createdAt,
          createdAt,
        );
        db.query(`INSERT INTO cron_proposals
          (guild_id,channel_id,user_id,name,prompt,kind,expr,silent,expires_at,created_at)
          VALUES ('guild',?,?,'n','p','interval','1800000',0,9999999999999,?)`).run(
          channel,
          user,
          createdAt,
        );
      };
      job("tester", "channel", 2_000);
      job("tester", "channel", 500);
      job("tester", "other", 2_000);
      job("someone", "channel", 2_000);
      db.close();
      const scenario = SCENARIOS.find((item) => item.name === "cron");
      if (!scenario?.cleanup) throw new Error("cron cleanup missing");
      expect(await scenario.cleanup(undefined, "channel", mock(), env, 1_000)).toEqual([]);
      const check = new Database(env.databasePath, { readonly: true });
      try {
        for (const table of ["cron_jobs", "cron_proposals"]) {
          const rows = check
            .query<{ user: string; channel: string; createdAt: number }, []>(
              `SELECT user_id AS user, channel_id AS channel, created_at AS createdAt FROM ${table} ORDER BY id`,
            )
            .all();
          expect(rows).toEqual([
            { user: "tester", channel: "channel", createdAt: 500 },
            { user: "tester", channel: "other", createdAt: 2_000 },
            { user: "someone", channel: "channel", createdAt: 2_000 },
          ]);
        }
      } finally {
        check.close();
      }
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("accepts ManageGuild from a role", async () => {
    const { dir, env } = setup(1, null);
    try {
      expect(
        await cronPreconditions(
          "channel",
          discord(["mod"], { guild: 0n, mod: PermissionFlagsBits.ManageGuild }),
          env,
        ),
      ).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

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
    expect(check("stop", [page("1", ["ナイル川は"], RESTART_STOPPED)])).not.toEqual([]);
  });

  test("shutdown: restart footer is terminal and required on the last page", () => {
    const messages = [page("1", ["ナイル川は"], RESTART_STOPPED)];
    expect(isFinished(toReply(messages))).toBe(true);
    expect(check("shutdown", messages)).toEqual([]);
    expect(check("shutdown", [page("1", ["ナイル川は"], STOPPED)])).not.toEqual([]);
    expect(check("shutdown", [page("1", [RESTART_STOPPED], USAGE)])).not.toEqual([]);
    expect(isFinished(toReply([page("1", [RESTART_STOPPED])]))).toBe(false);
    const scenario = SCENARIOS.find((item) => item.name === "shutdown");
    expect(scenario?.manual).toBe(true);
    expect(scenario?.stopBotWhileStreaming).toBe(true);
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

test("discord-info is named-only, checks history, pins its fixture and cleans up", async () => {
  const scenario = SCENARIOS.find((item) => item.name === "discord-info");
  if (!scenario?.before || !scenario.cleanup) throw new Error("missing discord-info scenario");
  expect(scenario.manual).toBe(true);
  expect(scenario.toolName).toBe("list_pins");
  const directory = mkdtempSync(join(tmpdir(), "disqord-info-"));
  const databasePath = join(directory, "settings.db");
  const db = new Database(databasePath);
  db.run(
    "CREATE TABLE guild_settings (guild_id TEXT, history_enabled INTEGER, twitter_expand_enabled INTEGER, show_llm_details INTEGER)",
  );
  db.run("INSERT INTO guild_settings VALUES ('guild', 0, 0, 1)");
  const requests: Array<{ path: string; method?: string }> = [];
  let fixtureContent = "";
  const request = mock(async (path: string, init?: RequestInit): Promise<Response> => {
    requests.push({ path, method: init?.method });
    if (init?.method === "POST") {
      expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
      fixtureContent = (JSON.parse(init.body as string) as { content: string }).content;
      return Response.json({ id: "fixture" });
    }
    if (init?.method === "PUT" || init?.method === "DELETE")
      return new Response(null, { status: 204 });
    if (path === "/channels/channel/messages?after=fixture&limit=100")
      return Response.json([
        { id: "unrelated-notice", type: 6, message_reference: { message_id: "other" } },
        { id: "pin-notice", type: 6, message_reference: { message_id: "fixture" } },
      ]);
    return Response.json({ guild_id: "guild", name: "channel-name" });
  });
  const infoEnv = { databasePath, testerBotId: "tester" };
  try {
    expect(await scenario.before("channel", request, infoEnv)).toEqual([
      expect.stringContaining("会話履歴 is off"),
    ]);
    expect(requests.some((call) => call.method === "POST")).toBe(false);
    db.run("UPDATE guild_settings SET history_enabled=1");
    expect(await scenario.before("channel", request, infoEnv)).toEqual([]);
    expect(requests).toContainEqual({ path: "/channels/channel/pins/fixture", method: "PUT" });
    expect(
      scenario.check(toReply([page("reply", [fixtureContent, "channel-name"], USAGE)])),
    ).toEqual([]);
    expect(scenario.check(toReply([page("reply", ["channel-name"], USAGE)]))).toContain(
      "the reply does not contain the pinned secret",
    );
    const secret = fixtureContent.split("合言葉: ")[1];
    expect(secret).toBeDefined();
    expect(scenario.prompt).not.toContain(secret as string);
    const posts: ScenarioPost[] = [];
    await sendScenario(
      scenario,
      async (message): Promise<DiscordMessage> => {
        posts.push(message);
        return {
          id: String(posts.length),
          content: message.prompt,
          author: { id: "tester", username: "tester", bot: true },
        };
      },
      async () => {},
    );
    expect(posts.slice(0, -1).length).toBeGreaterThanOrEqual(WINDOW_RAW_MESSAGE_LIMIT);
    expect(posts.slice(0, -1).every((post) => post.mention === false)).toBe(true);
    expect(posts.every((post) => !post.prompt.includes(secret as string))).toBe(true);
    expect(posts.at(-1)?.prompt).toBe(scenario.prompt);
    expect(
      scenario.check(toReply([page("reply", [scenario.prompt, "channel-name"], USAGE)])),
    ).toContain("the reply does not contain the pinned secret");
    expect(scenario.check(toReply([page("reply", [fixtureContent], USAGE)]))).toContain(
      "the reply does not contain the channel name",
    );
    expect(await scenario.cleanup(undefined, "channel", request, infoEnv, Date.now())).toEqual([]);
    expect(requests).toContainEqual({ path: "/channels/channel/pins/fixture", method: "DELETE" });
    expect(requests).toContainEqual({
      path: "/channels/channel/messages/fixture",
      method: "DELETE",
    });
    expect(requests).toContainEqual({
      path: "/channels/channel/messages/pin-notice",
      method: "DELETE",
    });
    expect(requests).not.toContainEqual({
      path: "/channels/channel/messages/unrelated-notice",
      method: "DELETE",
    });
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
