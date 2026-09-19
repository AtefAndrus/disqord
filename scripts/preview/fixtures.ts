/**
 * プレビュー対象の代表的な Bot UI 状態（fixture）。
 *
 * 重要: ここでは「実際の Bot UI 生成関数」をそのまま呼び出してペイロードを
 * 得る。プレビューが本物のコードを反映するため、UI 関数を改修すれば
 * `bun run preview` の出力に即反映される。
 */

import type { ActionRowBuilder, ButtonBuilder, ContainerBuilder, EmbedBuilder } from "discord.js";
import type { GuildSettings } from "../../src/types";
import {
  badgeText,
  buildErrorContainer,
  buildFinalContainer,
  buildStoppedContainer,
  buildStoppedFooterText,
  buildStreamingContainer,
  estimateFinalFooterBudget,
  type FinalMetadata,
  measureTextBudget,
  STREAMING_LABEL,
  splitTextIntoMessages,
} from "../../src/utils/chatContainerBuilder";
import {
  createEmbed,
  createErrorEmbed,
  createSuccessEmbed,
  getColorForModel,
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

/** Components V2: Container 1 個が message 1 通（toComponentsV2Payload と同じ構造） */
function packContainers(containers: ContainerBuilder[]): IRenderMessage[] {
  return containers.map((c) => ({ embeds: [], components: [c.toJSON()] }));
}

const DEMO_MODEL = "demo/preview-model:placeholder";
const DEMO_COLOR = getColorForModel(DEMO_MODEL);
const TRIGGER_MESSAGE_ID = "400000000000000000";

const settings: GuildSettings = {
  guildId: "100000000000000000",
  defaultModel: DEMO_MODEL,
  freeModelsOnly: true,
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
    '```ts\nconst res = await client.chat({\n  model: "provider/model-id",\n  messages,\n});\n```\n';
  let body = "## 長文応答の分割プレビュー\n\n";
  // ページ番号フッターと「詳細は末尾 message のみ」の分岐を描画させるため、1 message の本文予算
  // （MAX_TOTAL_CHARS_PER_MESSAGE からバッジと footer 見積りを引いた残り）を超える段落数にする。
  // 予算が変われば必要な段落数も変わるので、実際に 2 message 以上へ割れることは
  // tests/unit/scripts/previewFixtures.test.ts が検証する。
  for (let i = 0; i < 34; i++) {
    body += `${i + 1}. ${para}`;
    if (i === 6) body += code;
  }
  return body;
})();

/** messageCreate.ts の最終描画と同じ手順（footer 予算込みで分割 → chunk ごとに Container） */
function buildFinalMessages(text: string, metadata: FinalMetadata): ContainerBuilder[] {
  const chunks = splitTextIntoMessages(
    text,
    measureTextBudget(badgeText(DEMO_MODEL)),
    estimateFinalFooterBudget(metadata),
  );
  return chunks.map((chunk, i) =>
    buildFinalContainer({
      text: chunk,
      modelName: DEMO_MODEL,
      color: DEMO_COLOR,
      isFirst: i === 0,
      isLast: i === chunks.length - 1,
      metadata,
      pageInfo: { page: i + 1, total: chunks.length },
    }),
  );
}

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

  // 6. /model list
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

  // 7. /config auto-reply list
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

  // 8. /config 設定変更の確認
  fixtures.push({
    id: "config-confirm",
    title: "/config free-only 確認",
    note: "createSuccessEmbed: 文中の太字強調",
    messages: [
      pack([createSuccessEmbed("無料モデル限定を **有効** にしました。", "無料モデル限定設定")]),
    ],
  });

  // 9. チャット返信・ストリーミング中（Components V2 / Section の停止ボタン）
  // streamingUpdater.ts と同じく、バッジと STREAMING_LABEL の予算で分割してから構築する
  const streamingText =
    "これは生成途中の応答です。トークンが順次追記されていきます。現在モデルが考えている内容がここに表示され";
  const streamingChunks = splitTextIntoMessages(
    streamingText,
    measureTextBudget(badgeText(DEMO_MODEL)),
    measureTextBudget(STREAMING_LABEL),
  );
  fixtures.push({
    id: "chat-streaming",
    title: "チャット返信: ストリーミング中",
    note: "buildStreamingContainer: Model バッジ + 本文 + Section（生成中... と 🛑 停止ボタン）",
    messages: packContainers(
      streamingChunks.map((chunk, i) =>
        buildStreamingContainer({
          text: chunk,
          modelName: DEMO_MODEL,
          color: DEMO_COLOR,
          isFirst: i === 0,
          isLast: i === streamingChunks.length - 1,
          triggerMessageId: TRIGGER_MESSAGE_ID,
        }),
      ),
    ),
  });

  // 10. チャット返信・短い確定応答（単一メッセージ + 詳細フッター + 本文絵文字）
  const shortAnswer = [
    "承知しました ✅",
    "",
    "OpenRouter のモデルは `/model set` で切り替えられます。",
    "無料枠で試すなら `:free` サフィックス付きのモデルがおすすめです 🎉",
  ].join("\n");
  fixtures.push({
    id: "chat-final-short",
    title: "チャット返信: 短い確定応答（詳細フッター + 絵文字）",
    note: "buildFinalContainer 単一メッセージ。本文絵文字の Twemoji 化を検証",
    messages: packContainers(
      buildFinalMessages(shortAnswer, {
        showDetails: true,
        model: DEMO_MODEL,
        provider: "DeepSeek",
        latency: 642,
        usage: { prompt_tokens: 32, completion_tokens: 58, total_tokens: 90, cost: 0.000004 },
      }),
    ),
  });

  // 11. チャット返信・長文（複数メッセージへ分割 + ページ番号 + 詳細フッター）
  fixtures.push({
    id: "chat-final-long",
    title: "チャット返信: 長文（分割 + ページ番号 + 詳細フッター）",
    note: "splitTextIntoMessages + buildFinalContainer: ページング・コードブロック・末尾のみ詳細",
    messages: packContainers(
      buildFinalMessages(LONG_ANSWER, {
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
      }),
    ),
  });

  // 12. チャット返信・停止（🛑 Stopped フッター、停止ボタンなし）
  const stoppedText =
    "ここまで受信したところでユーザーが停止ボタンを押しました。部分テキストはそのまま残ります。";
  const stoppedElapsedSeconds = 3.4;
  const stoppedChunks = splitTextIntoMessages(
    stoppedText,
    measureTextBudget(badgeText(DEMO_MODEL)),
    measureTextBudget(buildStoppedFooterText(stoppedElapsedSeconds, stoppedText.length)),
  );
  fixtures.push({
    id: "chat-stopped",
    title: "チャット返信: 停止",
    note: "buildStoppedContainer: 経過秒数と受信済み文字数のフッター",
    messages: packContainers(
      stoppedChunks.map((chunk, i) =>
        buildStoppedContainer({
          text: chunk,
          modelName: DEMO_MODEL,
          color: DEMO_COLOR,
          isFirst: i === 0,
          isLast: i === stoppedChunks.length - 1,
          elapsedSeconds: stoppedElapsedSeconds,
          receivedChars: stoppedText.length,
        }),
      ),
    ),
  });

  // 13. チャット返信・エラー（accent RED + 見出し付き TextDisplay）
  fixtures.push({
    id: "chat-error",
    title: "チャット返信: エラー Container",
    note: "buildErrorContainer: accent RED・`## ⚠️ エラー` 見出し + 本文",
    messages: packContainers([
      buildErrorContainer(
        "OpenRouter API がタイムアウトしました。しばらくしてから再試行してください。\n\nエラーID: `a1b2c3d4`",
      ),
    ]),
  });

  return fixtures;
}
