import type {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  InteractionReplyOptions,
} from "discord.js";
import packageJson from "../../../package.json";
import type { ILLMClient } from "../../llm/openrouter";
import type { WebSearchEngine } from "../../llm/tools/webSearch";
import type { IModelService } from "../../services/modelService";
import {
  buildReleaseNotePages,
  formatVersion,
  parseVersion,
  type ReleaseNotes,
} from "../../services/releaseNotes";
import type { ISettingsService } from "../../services/settingsService";
import {
  buildErrorContainer,
  buildSuccessNoticeContainer,
  toNoticeEditPayload,
  toNoticePayload,
} from "../../utils/chatContainerBuilder";
import { buildConfigPanel } from "../../utils/configPanel";
import { logger } from "../../utils/logger";
import {
  buildModelDetailsContainer,
  getOpenRouterModelUrl,
} from "../../utils/modelDetailsContainer";
import { buildStatusMessage } from "../../utils/statusMessage";
import type { CommandHandlers } from "../events/interactionCreate";

function successNotice(message: string, title?: string): InteractionReplyOptions {
  return toNoticePayload(buildSuccessNoticeContainer(message, title));
}

function errorNotice(message: string, title?: string, ephemeral = false): InteractionReplyOptions {
  return toNoticePayload(buildErrorContainer(message, title), ephemeral);
}

export function createCommandHandlers(
  llmClient: ILLMClient,
  settingsService: ISettingsService,
  modelService: IModelService,
  webSearchEngine: WebSearchEngine,
  /** Undefined when CHANGELOG.md could not be read at startup. */
  releaseNotes?: ReleaseNotes,
): CommandHandlers {
  return {
    async help(interaction: ChatInputCommandInteraction): Promise<void> {
      const helpText = `**使い方:**
- Botにメンションして話しかけると、LLMが応答します
- 例: \`@DisQord こんにちは\`

**コマンド:**
- \`/help\` - このヘルプを表示
- \`/status\` - Bot状態（残高等）を表示
- \`/model current\` - 現在のモデルを表示
- \`/model set <model>\` - モデルを変更
- \`/model list\` - OpenRouterのモデル一覧ページへ
- \`/model refresh\` - モデルキャッシュを更新
- \`/release-note [version]\` - リリースノート（変更点）を表示
- \`/config\` - 設定パネルを開く

設定の変更には「サーバーの管理」権限または管理ロールが必要です。管理ロールの変更は「サーバーの管理」権限の持ち主だけが行えます。`;

      await interaction.reply(successNotice(helpText, "DisQord ヘルプ"));
    },

    async modelCurrent(interaction: ChatInputCommandInteraction): Promise<void> {
      if (!interaction.guildId) {
        await interaction.reply(errorNotice("このコマンドはサーバー内でのみ使用できます。"));
        return;
      }

      await interaction.deferReply();
      const settings = await settingsService.getGuildSettings(interaction.guildId);
      let details: Awaited<ReturnType<IModelService["getModelDetails"]>> = null;
      try {
        details = await modelService.getModelDetails(settings.defaultModel);
      } catch (error) {
        logger.warn("Failed to fetch current model details", {
          error,
          model: settings.defaultModel,
        });
      }
      const container = details
        ? buildModelDetailsContainer(details, {
            title: "現在のモデル",
            description: `現在のモデルは \`${settings.defaultModel}\` です。`,
          })
        : buildSuccessNoticeContainer(
            `現在のモデル: \`${settings.defaultModel}\`\n\n<${getOpenRouterModelUrl(settings.defaultModel)}>`,
            "現在のモデル",
          );
      await interaction.editReply(toNoticeEditPayload(container));
    },

    async modelSet(interaction: ChatInputCommandInteraction): Promise<void> {
      if (!interaction.guildId) {
        await interaction.reply(errorNotice("このコマンドはサーバー内でのみ使用できます。"));
        return;
      }

      const model = interaction.options.getString("model", true);
      const settings = await settingsService.getGuildSettings(interaction.guildId);

      const validation = await modelService.validateModelSelection(model, settings.freeModelsOnly);
      if (!validation.valid) {
        if (validation.error === "MODEL_NOT_FOUND") {
          await interaction.reply(
            errorNotice(
              `モデル \`${model}\` は見つかりませんでした。\`/model list\` で利用可能なモデルを確認してください。`,
              "モデル設定エラー",
            ),
          );
        } else if (validation.error === "MODEL_NOT_FREE") {
          await interaction.reply(
            errorNotice(
              `このサーバーは無料モデル限定に設定されています。モデル \`${model}\` は無料モデルではありません。`,
              "モデル設定エラー",
            ),
          );
        }
        return;
      }

      // The check above used settings read before any await; the save
      // re-checks free-only against the stored settings.
      const isFree = await modelService.isFreeModel(model);
      await settingsService.setGuildModel(
        interaction.guildId,
        { model, isFree },
        interaction.user.id,
      );

      // モデル詳細情報を取得して表示
      const details = await modelService.getModelDetails(model);

      if (details) {
        const container = buildModelDetailsContainer(details, {
          title: "モデル変更",
          description: `モデルを \`${model}\` に変更しました。`,
        });
        await interaction.reply(toNoticePayload(container));
      } else {
        // フォールバック（詳細取得失敗時）
        await interaction.reply(
          successNotice(
            `モデルを \`${model}\` に変更しました。\n\n<${getOpenRouterModelUrl(model)}>`,
            "モデル変更",
          ),
        );
      }
    },

    async modelList(interaction: ChatInputCommandInteraction): Promise<void> {
      const message = `モデル一覧はOpenRouterのサイトで確認できます:
<https://openrouter.ai/models>

モデルを変更するには \`/model set <model>\` を使用してください。`;

      await interaction.reply(successNotice(message, "モデル一覧"));
    },

    async modelRefresh(interaction: ChatInputCommandInteraction): Promise<void> {
      await interaction.deferReply();
      await modelService.refreshCache();
      const cacheStatus = modelService.getCacheStatus();
      const container = buildSuccessNoticeContainer(
        `モデルキャッシュを更新しました。${cacheStatus.modelCount}件のモデルを取得しました。`,
        "モデルキャッシュ更新",
      );
      await interaction.editReply(toNoticeEditPayload(container));
    },

    async status(interaction: ChatInputCommandInteraction): Promise<void> {
      await interaction.deferReply();

      const credits = await llmClient.getCredits();
      const cacheStatus = modelService.getCacheStatus();

      const settings = interaction.guildId
        ? await settingsService.getGuildSettings(interaction.guildId)
        : undefined;

      const message = buildStatusMessage({
        credits,
        cacheStatus,
        settings,
        webSearchEngine,
        version: packageJson.version,
      });

      await interaction.editReply(message);
    },

    async config(interaction: ChatInputCommandInteraction): Promise<void> {
      if (!interaction.guildId) {
        await interaction.reply(
          errorNotice("このコマンドはサーバー内でのみ使用できます。", undefined, true),
        );
        return;
      }
      await interaction.reply(
        buildConfigPanel("response", await settingsService.getGuildSettings(interaction.guildId)),
      );
    },

    async releaseNote(interaction: ChatInputCommandInteraction): Promise<void> {
      const input = interaction.options.getString("version") ?? packageJson.version;
      const version = parseVersion(input);
      if (!version) {
        await interaction.reply(
          errorNotice("版は 1.2.3 の形で指定してください。", "リリースノート", true),
        );
        return;
      }
      if (!releaseNotes) {
        await interaction.reply(
          errorNotice("リリースノートを読み込めませんでした。", "リリースノート", true),
        );
        return;
      }
      const section = releaseNotes.section(version);
      const label = `v${formatVersion(version)}`;
      if (!section) {
        await interaction.reply(
          errorNotice(`${label} の変更点は CHANGELOG にありません。`, "リリースノート", true),
        );
        return;
      }
      if (section.status === "duplicate") {
        await interaction.reply(
          errorNotice(
            `${label} の節が CHANGELOG に 2 つあるため表示できません。`,
            "リリースノート",
            true,
          ),
        );
        return;
      }
      const [first, ...rest] = buildReleaseNotePages(version, section.body);
      if (!first) return;
      await interaction.reply(first);
      for (const page of rest) {
        await interaction.followUp(page);
      }
    },

    async releaseNoteAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
      if (!releaseNotes) {
        await interaction.respond([]);
        return;
      }
      const focused = interaction.options.getFocused().trim().replace(/^v/i, "");
      const choices = releaseNotes
        .versions()
        .map(formatVersion)
        .filter((version) => version.includes(focused))
        .slice(0, 25)
        .map((version) => ({ name: `v${version}`, value: version }));
      await interaction.respond(choices);
    },
  };
}

export async function handleAutocomplete(
  interaction: AutocompleteInteraction,
  settingsService: ISettingsService,
  modelService: IModelService,
): Promise<void> {
  try {
    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.respond([]);
      return;
    }

    // model set のAutocomplete
    if (interaction.commandName !== "model" || interaction.options.getSubcommand() !== "set") {
      await interaction.respond([]);
      return;
    }

    const focusedValue = interaction.options.getFocused().toLowerCase();

    // Guild設定を取得
    const settings = await settingsService.getGuildSettings(guildId);

    // モデル一覧取得
    const models = settings.freeModelsOnly
      ? await modelService.getFreeModels()
      : await modelService.getAllModels();

    // フィルタリング（name/id部分一致、大文字小文字無視）
    const filtered = models
      .filter(
        (model) =>
          model.name.toLowerCase().includes(focusedValue) ||
          model.id.toLowerCase().includes(focusedValue),
      )
      .sort((a, b) => b.created - a.created) // 新しい順
      .slice(0, 25) // Discord制限
      .map((model) => ({
        name: `${model.name} (${model.id})`,
        value: model.id,
      }));

    await interaction.respond(filtered);
  } catch (error) {
    logger.error("Autocomplete error", { error });
    await interaction.respond([]);
  }
}
