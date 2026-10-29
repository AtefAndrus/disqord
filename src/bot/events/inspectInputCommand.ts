import {
  AttachmentBuilder,
  ButtonBuilder,
  type ButtonInteraction,
  ButtonStyle,
  ChannelType,
  ContainerBuilder,
  escapeMarkdown,
  type MessageContextMenuCommandInteraction,
  MessageFlags,
  PermissionFlagsBits,
} from "discord.js";
import type { ReplyRecord } from "../../db/repositories/replyRecord";
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

// A generation made with a server tool is not looked up: OpenRouter has no input for it to return.
type GenerationLog =
  | { id: string; serverTools: true }
  | { id: string; serverTools: false; generation: GenerationLookup; content: GenerationLookup };

interface JsonFile {
  name: string;
  data: Buffer;
}

const TIMEOUT: GenerationLookup = { ok: false, reason: "時間切れ" };
// Kept out of the attachment budget for the summary's payload_json and the multipart framing,
// in case the upload limit applies to the whole request rather than to each file.
export const REQUEST_OVERHEAD_BYTES = 64 * 1024;
const MISSING_RECORD = "この bot の返答ではないか、記録がありません";
const LOGGING_HINT =
  "404 は OpenRouter への反映が遅れている場合があります。少し待ってから「再取得」を押し、それでも 404 なら OpenRouter の入出力ログの設定を確認してください";
export const INSPECT_RETRY_PREFIX = "inspect:retry:";

export type InspectInputInteraction = MessageContextMenuCommandInteraction | ButtonInteraction;

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
  if (lookup.ok) return "";
  const status = lookup.status === undefined ? "" : `${lookup.status} `;
  return ` / ${endpoint}: ${status}${summaryValue(lookup.reason)}`;
}

function generationSummary(log: GenerationLog, index: number): string {
  if (log.serverTools) {
    return `${index + 1}. ${summaryValue(log.id)}: OpenRouter に入力が残っていません（Web 検索か日時取得のツールを渡した生成）`;
  }
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

// A message carries at most 10 attachments, and the size limit is applied to the request as well as
// to each file, so a batch is closed before either would be exceeded.
function batchFiles(files: JsonFile[], sizeLimit: number): JsonFile[][] {
  const batches: JsonFile[][] = [];
  let current: JsonFile[] = [];
  let bytes = 0;
  for (const file of files) {
    if (current.length === 10 || (current.length > 0 && bytes + file.data.byteLength > sizeLimit)) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(file);
    bytes += file.data.byteLength;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function errorDetails(error: unknown): Record<string, unknown> {
  const { code, status } = (typeof error === "object" && error !== null ? error : {}) as {
    code?: unknown;
    status?: unknown;
  };
  return {
    errorType: error instanceof Error ? error.name : typeof error,
    ...(typeof code === "number" || typeof code === "string" ? { code } : {}),
    ...(typeof status === "number" ? { status } : {}),
  };
}

function buildSummary(logs: GenerationLog[], omissions: Map<number, string>): string {
  // OpenRouter can reflect one generation of a reply before another, so a single 404 is worth a retry.
  const hint = logs.some((log) => !log.serverTools && !log.content.ok && log.content.status === 404)
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
  retryTriggerId?: string,
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
  if (retryTriggerId) {
    container.addActionRowComponents((row) =>
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`${INSPECT_RETRY_PREFIX}${retryTriggerId}`)
          .setLabel("再取得")
          .setStyle(ButtonStyle.Secondary),
      ),
    );
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
): (interaction: InspectInputInteraction) => Promise<void> {
  // Result messages with a retry running. A press while one runs is only acknowledged, so a single
  // retry writes to a message at a time. Letting the later press win instead would need the edits
  // themselves ordered: two retries use different interaction tokens, and discord.js resends an edit
  // after a 429 or 5xx, so an earlier retry's edit can land after a later one's.
  const retrying = new Set<string>();
  const inspect = async (interaction: InspectInputInteraction): Promise<void> => {
    // The retry button lives on the ephemeral result, so a retry rewrites that message in place.
    const retryTriggerId = interaction.isButton()
      ? interaction.customId.slice(INSPECT_RETRY_PREFIX.length)
      : null;
    if (interaction.isButton()) await interaction.deferUpdate();
    else await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const deadline = Date.now() + timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(0, deadline - Date.now()));
    let resultSent = false;
    let unsent: JsonFile[] = [];
    // A refusal on a retry goes to a new message: editing would replace the result already shown.
    const notify = async (text: string): Promise<void> => {
      if (retryTriggerId === null) await interaction.editReply(replyPayload(text, []));
      else
        await interaction.followUp({
          ...replyPayload(text, []),
          flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
        });
    };
    try {
      if (!interaction.guildId) {
        await notify("このコマンドはサーバー内でのみ使用できます。");
        return;
      }
      // interaction.channel reads only the cache, which lacks threads archived before the bot started.
      const channel =
        interaction.channel ??
        (await interaction.client.channels.fetch(interaction.channelId).catch(() => null));
      if (!channel || channel.isDMBased() || !channel.isTextBased()) {
        await notify("このチャンネルの情報を取得できませんでした。");
        return;
      }
      const settings = await settingsService.getGuildSettings(interaction.guildId);
      if (!canManageGuildSettings(settingsActorFromInteraction(interaction), settings)) {
        await notify("この操作には「サーバーの管理」権限か管理者ロールが必要です。");
        return;
      }
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
        await notify(
          "このチャンネルの履歴を読む権限を確認できません。ボイス・ステージチャンネルでは「接続」権限も必要です。",
        );
        return;
      }
      let record: ReplyRecord | null;
      if (interaction.isButton()) record = replyRecordService.findByTrigger(retryTriggerId ?? "");
      else {
        const target = interaction.targetMessage;
        record =
          replyRecordService.findByPage(target.id) ??
          (target.author.id === interaction.client.user.id && target.reference?.messageId
            ? replyRecordService.findByTrigger(target.reference.messageId)
            : null);
      }
      if (
        !record ||
        record.guildId !== interaction.guildId ||
        record.channelId !== interaction.channelId
      ) {
        await notify(MISSING_RECORD);
        return;
      }
      // Generation ids are saved once the reply is finalized, so a reply still in progress has none yet.
      if (record.status === "pending") {
        await notify("この返答はまだ生成中です。生成が終わってから実行してください。");
        return;
      }
      const generations = replyRecordService.listGenerations(record.triggerMsgId);
      if (generations.length === 0) {
        await notify(MISSING_RECORD);
        return;
      }
      const logs: GenerationLog[] = [];
      for (const { id, serverTools } of generations) {
        if (serverTools) {
          logs.push({ id, serverTools });
          continue;
        }
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
        logs.push({ id, serverTools, generation, content });
      }
      const sizeLimit = Math.max(0, interaction.attachmentSizeLimit - REQUEST_OVERHEAD_BYTES);
      const { files, omissions } = prepareFiles(record.triggerMsgId, logs, sizeLimit);
      const [first = [], ...rest] = batchFiles(files, sizeLimit);
      const failed = logs.some(
        (log) => !log.serverTools && (!log.generation.ok || !log.content.ok),
      );
      await interaction.editReply({
        ...replyPayload(
          buildSummary(logs, omissions),
          first,
          failed ? record.triggerMsgId : undefined,
        ),
        // A retry rewrites a message that already carries the earlier JSON files.
        attachments: [],
      });
      resultSent = true;
      unsent = rest.flat();
      for (const batch of rest) {
        await interaction.followUp({
          ...replyPayload("LLM 入出力ログ（続き）", batch),
          flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
        });
        unsent = unsent.slice(batch.length);
      }
    } catch (error) {
      // Input logs can contain private history; never put the caught response in an application log.
      logger.error("LLM input inspection failed", errorDetails(error));
      const payload = replyPayload(
        resultSent
          ? `続きのファイルを送れませんでした。届いていないファイル: ${unsent.map((file) => file.name).join("、")}`
          : "LLM 入力の取得中にエラーが発生しました。",
        [],
      );
      try {
        // Editing the reply after the result went out would hide the summary and files already delivered.
        if (resultSent || retryTriggerId !== null)
          await interaction.followUp({
            ...payload,
            flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
          });
        else await interaction.editReply(payload);
      } catch (replyError) {
        logger.error("Failed to report the LLM input inspection failure", errorDetails(replyError));
      }
    } finally {
      clearTimeout(timer);
    }
  };
  return async (interaction: InspectInputInteraction): Promise<void> => {
    if (!interaction.isButton()) return inspect(interaction);
    const messageId = interaction.message.id;
    if (retrying.has(messageId)) {
      await interaction.deferUpdate();
      return;
    }
    // Checked and claimed before any await, so two presses cannot both start a retry.
    retrying.add(messageId);
    try {
      await inspect(interaction);
    } finally {
      retrying.delete(messageId);
    }
  };
}
