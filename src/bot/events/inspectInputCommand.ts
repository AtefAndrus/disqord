import {
  AttachmentBuilder,
  ChannelType,
  ContainerBuilder,
  escapeMarkdown,
  type MessageContextMenuCommandInteraction,
  MessageFlags,
  PermissionFlagsBits,
} from "discord.js";
import type { GenerationLookup, IGenerationLogClient } from "../../llm/generationLog";
import { DiscordRestBudget } from "../../services/discordMessageReader";
import {
  type AuthorizationChannelLike,
  checkConversationAccess,
} from "../../services/messageAuthorization";
import type { IReplyRecordService } from "../../services/replyRecordService";
import {
  canManageGuildSettings,
  settingsActorFromInteraction,
} from "../../services/settingsAuthorization";
import type { ISettingsService } from "../../services/settingsService";
import { logger } from "../../utils/logger";

interface GenerationLog {
  id: string;
  generation: GenerationLookup;
  content: GenerationLookup;
}

interface JsonFile {
  name: string;
  data: Buffer;
}

const TIMEOUT: GenerationLookup = { ok: false, reason: "時間切れ" };
const MISSING_RECORD = "この bot の返答ではないか、記録がありません";
const LOGGING_HINT =
  "少し待ってから再実行し、それでも無ければ OpenRouter の入出力ログの設定を確かめてください";

// Race the client as well as aborting fetch so a stalled response cannot hold the interaction open.
function lookupBeforeDeadline(
  lookup: () => Promise<GenerationLookup>,
  signal: AbortSignal,
): Promise<GenerationLookup> {
  if (signal.aborted) return Promise.resolve(TIMEOUT);
  return new Promise((resolve) => {
    const abort = (): void => resolve(TIMEOUT);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve()
      .then(lookup)
      .then(resolve, (error: unknown) =>
        resolve({ ok: false, reason: error instanceof Error ? error.message : String(error) }),
      )
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function summaryValue(value: unknown): string {
  return typeof value === "string" || typeof value === "number"
    ? escapeMarkdown(
        String(value)
          .replace(/[\r\n]/g, " ")
          .slice(0, 100),
      )
    : "不明";
}

function lookupFailure(endpoint: string, lookup: GenerationLookup): string {
  return lookup.ok ? "" : ` / ${endpoint}: ${lookup.status ?? ""} ${summaryValue(lookup.reason)}`;
}

function generationSummary(log: GenerationLog, index: number): string {
  const data = log.generation.ok ? asObject(log.generation.data) : {};
  return (
    `${index + 1}. ${summaryValue(log.id)}: モデル ${summaryValue(data.model)}、` +
    `プロバイダ ${summaryValue(data.provider_name)}、` +
    `入力 ${summaryValue(data.tokens_prompt)} / 出力 ${summaryValue(data.tokens_completion)} tokens、` +
    `コスト $${summaryValue(data.total_cost)}` +
    lookupFailure("/generation", log.generation) +
    lookupFailure("/generation/content", log.content)
  );
}

function jsonBuffer(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value, null, 2), "utf8");
}

function prepareFiles(
  triggerMessageId: string,
  logs: GenerationLog[],
  sizeLimit: number,
): { files: JsonFile[]; omissions: Map<number, string> } {
  const data = jsonBuffer({ triggerMessageId, generations: logs });
  if (data.byteLength <= sizeLimit) {
    return { files: [{ name: `llm-input-${triggerMessageId}.json`, data }], omissions: new Map() };
  }
  const files: JsonFile[] = [];
  const omissions = new Map<number, string>();
  logs.forEach((log, index) => {
    const part = jsonBuffer({ triggerMessageId, generations: [log] });
    if (part.byteLength > sizeLimit) {
      omissions.set(
        index,
        `${part.byteLength} bytes、添付上限 ${sizeLimit} bytes を超えるためファイルを省略`,
      );
    } else {
      files.push({ name: `llm-input-${triggerMessageId}-${index + 1}.json`, data: part });
    }
  });
  return { files, omissions };
}

function buildSummary(logs: GenerationLog[], omissions: Map<number, string>): string {
  const hint = logs.every((log) => !log.content.ok && log.content.status === 404)
    ? `\n${LOGGING_HINT}`
    : "";
  let text = "LLM 入出力ログ";
  let included = 0;
  // Omitted files have no JSON to consult, so keep their sizes visible before ordinary rows.
  const rows = [
    ...[...omissions].map(([index, note]) => `${generationSummary(logs[index], index)} / ${note}`),
    ...logs.flatMap((log, index) => (omissions.has(index) ? [] : [generationSummary(log, index)])),
  ];
  for (const row of rows) {
    const remaining = logs.length - included - 1;
    const suffix = remaining > 0 ? `\n他 ${remaining} 件は JSON を参照` : "";
    if (`${text}\n${row}${suffix}${hint}`.length > 4000) break;
    text += `\n${row}`;
    included += 1;
  }
  if (included < logs.length) text += `\n他 ${logs.length - included} 件は JSON を参照`;
  return text + hint;
}

function replyPayload(
  text: string,
  files: JsonFile[],
): {
  flags: typeof MessageFlags.IsComponentsV2;
  components: ContainerBuilder[];
  files: AttachmentBuilder[];
  allowedMentions: { parse: [] };
} {
  const container = new ContainerBuilder().addTextDisplayComponents((td) => td.setContent(text));
  for (const file of files) {
    container.addFileComponents((component) => component.setURL(`attachment://${file.name}`));
  }
  return {
    flags: MessageFlags.IsComponentsV2,
    components: [container],
    files: files.map((file) => new AttachmentBuilder(file.data, { name: file.name })),
    allowedMentions: { parse: [] },
  };
}

export function createInspectInputHandler(
  settingsService: ISettingsService,
  replyRecordService: IReplyRecordService,
  generationLogClient: IGenerationLogClient,
  timeoutMs = 60_000,
): (interaction: MessageContextMenuCommandInteraction) => Promise<void> {
  return async (interaction: MessageContextMenuCommandInteraction): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(0, deadline - Date.now()));
    try {
      if (!interaction.guildId || !interaction.channel) {
        await interaction.editReply(
          replyPayload("このコマンドはサーバー内でのみ使用できます。", []),
        );
        return;
      }
      const settings = await settingsService.getGuildSettings(interaction.guildId);
      if (!canManageGuildSettings(settingsActorFromInteraction(interaction), settings)) {
        await interaction.editReply(
          replyPayload("この操作には「サーバーの管理」権限か管理者ロールが必要です。", []),
        );
        return;
      }
      const channel = interaction.channel;
      const access = await checkConversationAccess(
        {
          channel: channel as unknown as AuthorizationChannelLike,
          author: interaction.user,
          member: interaction.member,
          client: interaction.client,
        },
        interaction.client.user,
        new DiscordRestBudget(),
        controller.signal,
      );
      const needsConnect =
        channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice;
      if (
        access !== "allowed" ||
        (needsConnect &&
          !channel.permissionsFor(interaction.user)?.has(PermissionFlagsBits.Connect))
      ) {
        await interaction.editReply(
          replyPayload(
            "このチャンネルの履歴を読む権限を確認できません。ボイス・ステージチャンネルでは「接続」権限も必要です。",
            [],
          ),
        );
        return;
      }
      const target = interaction.targetMessage;
      const record =
        replyRecordService.findByPage(target.id) ??
        (target.author.id === interaction.client.user.id && target.reference?.messageId
          ? replyRecordService.findByTrigger(target.reference.messageId)
          : null);
      if (
        !record ||
        record.guildId !== interaction.guildId ||
        record.channelId !== interaction.channelId
      ) {
        await interaction.editReply(replyPayload(MISSING_RECORD, []));
        return;
      }
      const ids = replyRecordService.listGenerationIds(record.triggerMsgId);
      if (ids.length === 0) {
        await interaction.editReply(replyPayload(MISSING_RECORD, []));
        return;
      }
      const logs: GenerationLog[] = [];
      for (const id of ids) {
        const [generation, content] = await Promise.all([
          lookupBeforeDeadline(
            () => generationLogClient.getGeneration(id, controller.signal),
            controller.signal,
          ),
          lookupBeforeDeadline(
            () => generationLogClient.getGenerationContent(id, controller.signal),
            controller.signal,
          ),
        ]);
        logs.push({ id, generation, content });
      }
      const { files, omissions } = prepareFiles(
        record.triggerMsgId,
        logs,
        interaction.attachmentSizeLimit,
      );
      await interaction.editReply(replyPayload(buildSummary(logs, omissions), files.slice(0, 10)));
      for (let index = 10; index < files.length; index += 10) {
        await interaction.followUp({
          ...replyPayload("LLM 入出力ログ（続き）", files.slice(index, index + 10)),
          flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
        });
      }
    } catch (error) {
      // Input logs can contain private history; never put the caught response in an application log.
      logger.error("LLM input inspection failed", {
        errorType: error instanceof Error ? error.name : typeof error,
      });
      await interaction.editReply(replyPayload("LLM 入力の取得中にエラーが発生しました。", []));
    } finally {
      clearTimeout(timer);
    }
  };
}
