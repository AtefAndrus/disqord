/**
 * プレビュー対象の代表的な Bot UI 状態（fixture）。
 *
 * 重要: ここでは「実際の Bot UI 生成関数」をそのまま呼び出してペイロードを
 * 得る。プレビューが本物のコードを反映するため、UI 関数を改修すれば
 * `bun run preview` の出力に即反映される。
 */

import type { ActionRowBuilder, ButtonBuilder, EmbedBuilder } from "discord.js";
import type { GuildSettings } from "../../src/types";
import { createStopButton } from "../../src/utils/buttonBuilder";
import {
  createEmbed,
  createErrorEmbed,
  createStreamingEmbed,
  createSuccessEmbed,
  getColorForModel,
  splitTextToMultipleMessages,
} from "../../src/utils/embedBuilder";
import { buildStatusMessage } from "../../src/utils/statusMessage";
import type { IRenderMessage } from "./payloadToMarkup";

export interface IFixture {
  id: string;
  title: string;
  note: string;
  messages: IRenderMessage[];
}

function pack(
  embeds: EmbedBuilder[],
  components: ActionRowBuilder<ButtonBuilder>[] = [],
): IRenderMessage {
  return {
    embeds: embeds.map((e) => e.toJSON()),
    components: components.map((c) => c.toJSON()),
  };
}

const DEMO_MODEL = "deepseek/deepseek-v4-flash:free";

const settings: GuildSettings = {
  guildId: "100000000000000000",
  defaultModel: DEMO_MODEL,
  freeModelsOnly: true,
  releaseChannelId: "200000000000000000",
  showLlmDetails: false,
  autoReplyChannels: ["300000000000000000"],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const HELP_TEXT = [
  "DisQord は OpenRouter 経由で LLM と会話する Discord Bot です。",
  "",
  "**スラッシュコマンド**",
  "`/help` — このヘルプを表示",
  "`/status` — Bot の状態・設定を表示",
  "`/model current` — 現在のモデルを表示",
  "`/model set <model>` — デフォルトモデルを変更",
  "`/model list` — 利用可能なモデル一覧",
  "`/config free-only <bool>` — 無料モデル限定の切替",
  "",
  "メンションするか、自動応答チャンネルで話しかけると返信します。",
].join("\n");

const LONG_ANSWER = (() => {
  const para =
    "OpenRouter は複数の LLM プロバイダを単一 API で扱えるルーティング層です。" +
    "モデル ID を切り替えるだけで DeepSeek・Llama・GPT 系などへリクエストを振り分けられます。\n";
  const code =
    '```ts\nconst res = await client.chat({\n  model: "deepseek/deepseek-v4-flash:free",\n  messages,\n});\n```\n';
  let body = "## 長文応答の分割プレビュー\n\n";
  for (let i = 0; i < 28; i++) {
    body += `${i + 1}. ${para}`;
    if (i === 6) body += code;
  }
  return body;
})();

export function buildFixtures(): IFixture[] {
  const fixtures: IFixture[] = [];

  // 1. /status（ギルド内・ボタンあり）
  const statusGuild = buildStatusMessage({
    credits: { remaining: 1.2345 },
    rateLimited: false,
    cacheStatus: { lastUpdatedAt: new Date(Date.now() - 42 * 60 * 1000), modelCount: 327 },
    settings,
    version: "1.4.0",
  });
  fixtures.push({
    id: "status-guild",
    title: "/status（ギルド・ボタンあり）",
    note: "buildStatusMessage: Embed フィールド + 4 ボタンのアクションロウ",
    messages: [pack(statusGuild.embeds, statusGuild.components)],
  });

  // 2. /status（DM・ボタンなし）
  const statusDm = buildStatusMessage({
    credits: { remaining: Number.POSITIVE_INFINITY },
    rateLimited: true,
    cacheStatus: { lastUpdatedAt: null, modelCount: 0 },
    version: "1.4.0",
  });
  fixtures.push({
    id: "status-dm",
    title: "/status（DM・設定なし）",
    note: "settings 無しでボタンが出ない分岐、残高無制限・レート制限中",
    messages: [pack(statusDm.embeds, statusDm.components)],
  });

  // 3. /help
  fixtures.push({
    id: "help",
    title: "/help",
    note: "createSuccessEmbed: マークダウン（太字・インラインコード）",
    messages: [pack([createSuccessEmbed(HELP_TEXT, "DisQord ヘルプ")])],
  });

  // 4. /model set 確認（fields 付き Embed）
  const modelSet = createEmbed({
    color: getColorForModel(DEMO_MODEL),
    title: "モデルを変更しました",
    fields: [
      { name: "モデル", value: `\`${DEMO_MODEL}\``, inline: false },
      { name: "コンテキスト長", value: "163K (163,840)", inline: true },
      { name: "入力", value: "$0.00/1M", inline: true },
      { name: "出力", value: "$0.00/1M", inline: true },
    ],
    timestamp: null,
  });
  fixtures.push({
    id: "model-set",
    title: "/model set 確認",
    note: "createEmbed: モデルハッシュ由来カラー + inline フィールドの折り返し",
    messages: [pack([modelSet])],
  });

  // 5. エラー
  fixtures.push({
    id: "error",
    title: "エラー Embed",
    note: "createErrorEmbed: 赤色・タイムスタンプ付き",
    messages: [
      pack([
        createErrorEmbed(
          "OpenRouter API がタイムアウトしました。しばらくしてから再試行してください。",
        ),
      ]),
    ],
  });

  // 6. ストリーミング途中（停止ボタン付き）
  const streaming = createStreamingEmbed(
    "これは生成途中の応答です。トークンが順次追記されていきます。現在モデルが考えている内容がここに表示され",
    DEMO_MODEL,
    getColorForModel(DEMO_MODEL),
    "生成中...",
  );
  fixtures.push({
    id: "streaming",
    title: "ストリーミング途中 + 停止ボタン",
    note: "createStreamingEmbed + createStopButton（author 名・🛑 絵文字ボタン）",
    messages: [pack([streaming], [createStopButton("400000000000000000")])],
  });

  // 7. /model list
  fixtures.push({
    id: "model-list",
    title: "/model list",
    note: "createSuccessEmbed: 埋め込み抑制リンク <url> + インラインコード",
    messages: [
      pack([
        createSuccessEmbed(
          "モデル一覧はOpenRouterのサイトで確認できます:\n<https://openrouter.ai/models>\n\nモデルを変更するには `/model set <model>` を使用してください。",
          "モデル一覧",
        ),
      ]),
    ],
  });

  // 8. /config auto-reply list
  fixtures.push({
    id: "auto-reply-list",
    title: "/config auto-reply list",
    note: "createSuccessEmbed: 太字 + 箇条書き + 複数チャンネルメンション",
    messages: [
      pack([
        createSuccessEmbed(
          "**自動応答チャンネル:**\n- <#300000000000000000>\n- <#300000000000000001>\n- <#300000000000000002>",
          "自動応答チャンネル一覧",
        ),
      ]),
    ],
  });

  // 9. /config 設定変更の確認
  fixtures.push({
    id: "config-confirm",
    title: "/config free-only 確認",
    note: "createSuccessEmbed: 文中の太字強調",
    messages: [
      pack([createSuccessEmbed("無料モデル限定を **有効** にしました。", "無料モデル限定設定")]),
    ],
  });

  // 10. 短い LLM 応答（単一メッセージ + 詳細フッター + 本文絵文字）
  const shortAnswer = [
    "承知しました ✅",
    "",
    "OpenRouter のモデルは `/model set` で切り替えられます。",
    "無料枠で試すなら `:free` サフィックス付きのモデルがおすすめです 🎉",
  ].join("\n");
  const shortSplit = splitTextToMultipleMessages(
    shortAnswer,
    { color: getColorForModel(DEMO_MODEL), timestamp: new Date(), author: { name: DEMO_MODEL } },
    {
      showDetails: true,
      model: DEMO_MODEL,
      provider: "DeepSeek",
      latency: 642,
      usage: { prompt_tokens: 32, completion_tokens: 58, total_tokens: 90, cost: 0.000004 },
    },
  );
  fixtures.push({
    id: "llm-response-short",
    title: "短い LLM 応答（詳細フッター + 絵文字）",
    note: "splitTextToMultipleMessages 単一メッセージ。本文絵文字の Twemoji 化を検証",
    messages: shortSplit.map((embeds) => pack(embeds)),
  });

  // 11. 長文応答（複数メッセージへ分割 + LLM 詳細フッター）
  const split = splitTextToMultipleMessages(
    LONG_ANSWER,
    { color: getColorForModel(DEMO_MODEL), timestamp: new Date(), author: { name: DEMO_MODEL } },
    {
      showDetails: true,
      model: DEMO_MODEL,
      provider: "DeepSeek",
      latency: 1234,
      usage: {
        prompt_tokens: 48,
        completion_tokens: 812,
        total_tokens: 860,
        cost: 0.000123,
      },
    },
  );
  fixtures.push({
    id: "llm-response-long",
    title: "長文応答（分割 + 詳細フッター）",
    note: "splitTextToMultipleMessages: ページング・コードブロック・最終ページの詳細",
    messages: split.map((embeds) => pack(embeds)),
  });

  return fixtures;
}
