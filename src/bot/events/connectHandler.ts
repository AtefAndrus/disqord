import {
  ActionRowBuilder,
  ButtonBuilder,
  type ButtonInteraction,
  ButtonStyle,
  type ChatInputCommandInteraction,
  MessageFlags,
  ModalBuilder,
  type ModalSubmitInteraction,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { AppError } from "../../errors";
import { formatKeyBalance, getKeyInfo } from "../../llm/openrouterAuth";
import type {
  ConnectionStatus,
  ConnectionTarget,
  IApiKeyService,
} from "../../services/apiKeyService";
import { REPLY_GATE_MODEL } from "../../services/replyGateService";
import {
  canManageGuildSettings,
  settingsActorFromInteraction,
} from "../../services/settingsAuthorization";
import type { ISettingsService } from "../../services/settingsService";
import {
  buildErrorContainer,
  buildSuccessNoticeContainer,
  toNoticeEditPayload,
  toNoticePayload,
} from "../../utils/chatContainerBuilder";
import { logger } from "../../utils/logger";
import { metrics } from "../../utils/metrics";

export type ConnectInteraction =
  | ChatInputCommandInteraction
  | ButtonInteraction
  | ModalSubmitInteraction;
function statusText(status: ConnectionStatus, includeLinks = true): string {
  if (status.status === "disconnected") return "未接続";
  if (status.status === "unreadable")
    return includeLinks ? "取得できません（接続し直してください）" : "取得できません";
  if (!includeLinks) return "接続済み";
  return `接続済み / [キー設定](https://openrouter.ai/keys/${status.keyHash}) / [利用ログ](https://openrouter.ai/logs?api_key_hash=${status.keyHash})`;
}
export async function guildBalanceText(
  service: IApiKeyService,
  guildId: string | null,
): Promise<string | undefined> {
  if (!guildId || service.getConnection({ scope: "guild", guildId }).status === "disconnected")
    return undefined;
  try {
    const resolved = service.resolveForGuild(guildId);
    return formatKeyBalance(resolved?.source === "guild" ? await getKeyInfo(resolved.key) : null);
  } catch {
    return formatKeyBalance(null);
  }
}
export function createConnectHandler(
  apiKeys: IApiKeyService,
  settingsService: ISettingsService,
): (interaction: ConnectInteraction) => Promise<void> {
  return async (interaction): Promise<void> => {
    const isCommand = interaction.isChatInputCommand();
    let modalTarget: ConnectionTarget | undefined;
    if (isCommand) metrics.increment(`command.${interaction.commandName}`);
    const notice = async (text: string, failed = false): Promise<void> => {
      const container = (failed ? buildErrorContainer : buildSuccessNoticeContainer)(
        text,
        "OpenRouter 接続",
      );
      if (interaction.deferred || interaction.replied)
        await interaction.editReply(toNoticeEditPayload(container));
      else await interaction.reply(toNoticePayload(container, true));
    };
    try {
      if (!apiKeys.enabled) {
        await notice("この Bot では OpenRouter アカウントの接続機能が無効です。", true);
        return;
      }
      const action = interaction.isChatInputCommand()
        ? interaction.options.getSubcommand()
        : interaction.customId.split(":")[2];
      if (action === "status" && interaction.isChatInputCommand()) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const user = apiKeys.getConnection({ scope: "user", userId: interaction.user.id });
        let balance = "取得できません";
        if (user.status === "connected") {
          try {
            const payer = apiKeys.resolveForMention(interaction.user.id, interaction.guildId ?? "");
            if (payer?.source === "user") balance = formatKeyBalance(await getKeyInfo(payer.key));
          } catch {
            /* A failed lookup must not display a fallback account's balance. */
          }
        }
        await notice(
          `自分: ${statusText(user)}${user.status === "disconnected" ? "" : `\n${balance}`}\nサーバー: ${interaction.guildId ? statusText(apiKeys.getConnection({ scope: "guild", guildId: interaction.guildId }), false) : "サーバー外"}`,
        );
        return;
      }
      if (action !== "user" && action !== "guild") {
        await notice("接続の操作を確認できません。", true);
        return;
      }
      if (action === "guild" && !interaction.guildId) {
        await notice("サーバーの接続はサーバー内でのみ操作できます。", true);
        return;
      }
      const target: ConnectionTarget =
        action === "user"
          ? { scope: "user", userId: interaction.user.id }
          : { scope: "guild", guildId: interaction.guildId as string };
      if (target.scope === "guild") {
        const settings = await settingsService.getGuildSettings(target.guildId);
        if (!canManageGuildSettings(settingsActorFromInteraction(interaction), settings)) {
          await notice("この操作には「サーバーの管理」権限か管理者ロールが必要です。", true);
          return;
        }
      }
      if (interaction.isButton()) {
        if (
          apiKeys.connectionMode !== "paste" ||
          !apiKeys.hasPendingConnection(interaction.user.id, target)
        ) {
          await notice(
            "接続の要求が期限切れか更新されています。`/connect` からやり直してください。",
            true,
          );
          return;
        }
        await interaction.showModal(
          new ModalBuilder()
            .setCustomId(`connect:code:${action}`)
            .setTitle("OpenRouter の認可コード")
            .addComponents(
              new ActionRowBuilder<TextInputBuilder>().addComponents(
                new TextInputBuilder()
                  .setCustomId("code")
                  .setLabel("認可ページに表示されたコード")
                  .setStyle(TextInputStyle.Short)
                  .setRequired(true),
              ),
            ),
        );
        return;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      if (interaction.isModalSubmit()) {
        modalTarget = target;
        const result = await apiKeys.completeConnection(
          interaction.user.id,
          target,
          interaction.fields.getTextInputValue("code").trim(),
        );
        if (result === "processing") {
          await notice("処理中です。結果をお待ちください。");
          return;
        }
        await notice(
          "OpenRouter アカウントを接続しました。接続し直す前のキーは OpenRouter に残るので、不要なら [キー設定](https://openrouter.ai/keys) で削除してください。",
        );
        return;
      }
      if (interaction.commandName === "disconnect") {
        const result = apiKeys.disconnect(target);
        await notice(
          `${result.removed ? "Bot に保存した接続を削除しました。" : "接続はありません。"}OpenRouter 上のキーは残るので、不要なら [キー設定](https://openrouter.ai/keys${result.keyHash ? `/${result.keyHash}` : ""}) で削除してください。`,
        );
        return;
      }
      const url = apiKeys.startConnection(interaction.user.id, target, {
        authorize: async () => {
          if (target.scope === "user") return true;
          const guild = await interaction.client.guilds.fetch(target.guildId);
          const member = await guild.members.fetch({
            user: interaction.user.id,
            force: true,
            cache: false,
          });
          return canManageGuildSettings(
            { permissions: member.permissions, roleIds: [...member.roles.cache.keys()] },
            await settingsService.getGuildSettings(target.guildId),
          );
        },
        report: async (result) => {
          await notice(
            result === "connected"
              ? "OpenRouter アカウントを接続しました。古いキーは OpenRouter に残るので、不要なら [キー設定](https://openrouter.ai/keys) で削除してください。"
              : "接続できませんでした。`/connect` からやり直してください。",
            result !== "connected",
          );
        },
      });
      const text = [
        "認可ページを開いて OpenRouter アカウントを接続してください。認可ページのリンクを他人に渡さないでください。",
        "キーは Bot の運営者のサーバーに暗号化して保存します。利用額は OpenRouter 側のキー上限で抑えられます。",
        "OpenRouter の入出力ログを有効にしていると、そのアカウントの持ち主（組織の workspace では組織の管理者も）が入力と出力を読めます。",
        action === "user"
          ? "この接続はこの Bot がいるすべてのサーバーで使われます。メンションへの返答は、そのサーバーの管理者が選んだモデルで自分のクレジットから支払われます。自動応答と定期実行には使われません。"
          : `自動応答の取捨選択を使う場合は ${REPLY_GATE_MODEL} も workspace で許可してください。`,
        "接続し直すと古いキーは OpenRouter に残ります。不要なら OpenRouter のキー設定で削除してください。",
        apiKeys.connectionMode === "paste"
          ? "認可後に表示されるコードを「コードを入力」から貼り付けてください。"
          : "承認すると自動的に接続が完了します。",
      ].join("\n");
      const container = buildSuccessNoticeContainer(text, "OpenRouter 接続");
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setLabel("認可ページを開く").setStyle(ButtonStyle.Link).setURL(url),
      );
      if (apiKeys.connectionMode === "paste")
        row.addComponents(
          new ButtonBuilder()
            .setCustomId(`connect:enter:${action}`)
            .setLabel("コードを入力")
            .setStyle(ButtonStyle.Primary),
        );
      container.addActionRowComponents(row);
      await interaction.editReply(toNoticeEditPayload(container));
    } catch (error) {
      if (isCommand) metrics.increment("command.errors");
      logger.warn("OpenRouter connection operation failed", {
        stage: "interaction",
        errorType: error instanceof Error ? "Error" : typeof error,
      });
      try {
        await notice(
          modalTarget && apiKeys.hasPendingConnection(interaction.user.id, modalTarget)
            ? "接続できませんでした。コードを確認して同じメッセージの「コードを入力」から入力し直すか、`/connect` からやり直してください。"
            : error instanceof AppError
              ? error.userMessage
              : "接続の操作に失敗しました。`/connect` からやり直してください。",
          true,
        );
      } catch (replyError) {
        logger.warn("Failed to report the OpenRouter connection failure", {
          stage: "report",
          errorType: replyError instanceof Error ? "Error" : typeof replyError,
        });
      }
    }
  };
}
