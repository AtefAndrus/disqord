import {
  ContainerBuilder,
  type MessageCreateOptions,
  type MessageEditOptions,
  MessageFlags,
  type MessageReplyOptions,
  SeparatorSpacingSize,
} from "discord.js";
import type { MessageId } from "../types";
import { EmbedColors } from "../types/embed";
import { createStopButton } from "./buttonBuilder";
import { splitTextIntoChunks } from "./embedBuilder";

/**
 * 1 message の全 TextDisplay 合計文字数上限。
 * Discord の実上限は 4000 字（per-component ではなく1 message 内の全 TextDisplay 合計）。
 * 200 字の安全マージンを引いた値をここで使用する。
 */
export const MAX_TOTAL_CHARS_PER_MESSAGE = 3800;

/** ストリーミング中、Section 内に表示する固定ラベル */
export const STREAMING_LABEL = "生成中...";

/**
 * 本文が空文字列の場合に表示するプレースホルダー。
 * discord.js の TextDisplayBuilder#setContent は空文字列を同期的に reject (ExpectedConstraintError)
 * するため、builder を total function にするための最終防御としてここでフォールバックする。
 */
export const EMPTY_TEXT_PLACEHOLDER = "（応答なし）";

/** ページ番号 prefix（"ページ 99/99 | "相当）の予約文字数。footer 文字数見積りに使用 */
const PAGE_PREFIX_RESERVE = 20;

export interface UsageMetadata {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
}

export interface FinalMetadata {
  showDetails: boolean;
  model?: string;
  provider?: string;
  latency?: number;
  usage?: UsageMetadata;
}

interface ChatContainerBaseParams {
  /** この message の本文（既に splitTextIntoMessages で分割済みのチャンク） */
  text: string;
  modelName: string;
  color: number;
  /** 先頭 message か（Model badge を表示するか） */
  isFirst: boolean;
  /** 末尾 message か（Section / footer を表示するか） */
  isLast: boolean;
}

/** Model badge の TextDisplay 文言 */
export function badgeText(modelName: string): string {
  return `**Model:** ${modelName}`;
}

/**
 * 本文を「1 message に載る本文量」ごとに分割する。
 * badgeChars / footerChars はその message に同居しうる badge・footer の文字数見積りで、
 * 合計予算 (MAX_TOTAL_CHARS_PER_MESSAGE) から差し引く。badge は先頭 message、footer は末尾
 * message にしか実際には乗らないが、簡潔さと安全性を優先し全 message に同一予算を適用する。
 */
export function splitTextIntoMessages(
  text: string,
  badgeChars: number,
  footerChars: number,
): string[] {
  const bodyBudget = Math.max(1, MAX_TOTAL_CHARS_PER_MESSAGE - badgeChars - footerChars);
  const chunks = splitTextIntoChunks(text, bodyBudget);
  return chunks.length > 0 ? chunks : [""];
}

/**
 * LLM 詳細情報（Tokens/Cost/Model/Latency/Provider/Cached/Reasoning/TPS）の " | " 区切り文字列。
 * showDetails=false または usage 未取得の場合は undefined。
 */
export function buildUsageDetailsText(metadata: FinalMetadata): string | undefined {
  if (!metadata.showDetails || !metadata.usage) {
    return undefined;
  }

  const { usage } = metadata;
  const details: string[] = [
    `Tokens: ${usage.prompt_tokens}+${usage.completion_tokens}=${usage.total_tokens}`,
  ];

  if (usage.cost !== undefined) {
    details.push(`Cost: $${usage.cost.toFixed(6)}`);
  }
  if (metadata.model) {
    details.push(`Model: ${metadata.model}`);
  }
  if (metadata.latency !== undefined) {
    details.push(`Latency: ${metadata.latency}ms`);
  }
  if (metadata.provider) {
    details.push(`Provider: ${metadata.provider}`);
  }
  if (usage.prompt_tokens_details?.cached_tokens) {
    details.push(`Cached: ${usage.prompt_tokens_details.cached_tokens}`);
  }
  if (usage.completion_tokens_details?.reasoning_tokens) {
    details.push(`Reasoning: ${usage.completion_tokens_details.reasoning_tokens}`);
  }
  if (usage.completion_tokens && metadata.latency) {
    const tokensPerSecond = usage.completion_tokens / (metadata.latency / 1000);
    details.push(`TPS: ${tokensPerSecond.toFixed(2)}`);
  }

  return details.join(" | ");
}

/**
 * 末尾 message の footer 文字列（ページ番号 + LLM 詳細情報）。
 * LLM 詳細情報が無い場合（showLlmDetails=false 等）は footer 自体を出さない（undefined）。
 */
export function buildFinalFooterText(
  metadata: FinalMetadata,
  pageInfo?: { page: number; total: number },
): string | undefined {
  const details = buildUsageDetailsText(metadata);
  if (!details) {
    return undefined;
  }
  if (pageInfo && pageInfo.total > 1) {
    return `ページ ${pageInfo.page}/${pageInfo.total} | ${details}`;
  }
  return details;
}

/** 停止時の footer 文字列（"🛑 Stopped | xx.xs"、usage が無いため Tokens は含めない） */
export function buildStoppedFooterText(elapsedSeconds: number): string {
  return `🛑 Stopped | ${elapsedSeconds.toFixed(1)}s`;
}

/** footer 文字数見積り（LLM 詳細情報 + ページ番号 prefix のマージン） */
export function estimateFinalFooterChars(metadata: FinalMetadata): number {
  const details = buildUsageDetailsText(metadata);
  return details ? details.length + PAGE_PREFIX_RESERVE : 0;
}

function addBadgeAndBody(container: ContainerBuilder, params: ChatContainerBaseParams): void {
  if (params.isFirst) {
    container.addTextDisplayComponents((td) => td.setContent(badgeText(params.modelName)));
  }
  container.addTextDisplayComponents((td) => td.setContent(params.text || EMPTY_TEXT_PLACEHOLDER));
  // 将来: multimodal 出力 (画像 / ファイル) はここに
  // addMediaGalleryComponents / addFileComponents で追加予定（chat-response-v2 Phase D、現状 noop）
}

export interface StreamingContainerParams extends ChatContainerBaseParams {
  /** 停止ボタンの custom_id に埋め込む、トリガーとなったユーザー入力メッセージの ID */
  triggerMessageId: MessageId;
}

/**
 * ストリーミング中の Container を構築する。
 * 停止ボタン（Section accessory）は isLast の message にのみ配置する。
 */
export function buildStreamingContainer(params: StreamingContainerParams): ContainerBuilder {
  const container = new ContainerBuilder().setAccentColor(params.color);
  addBadgeAndBody(container, params);

  if (params.isLast) {
    container.addSeparatorComponents((sep) =>
      sep.setDivider(false).setSpacing(SeparatorSpacingSize.Small),
    );
    container.addSectionComponents((section) =>
      section
        .addTextDisplayComponents((td) => td.setContent(STREAMING_LABEL))
        .setButtonAccessory(createStopButton(params.triggerMessageId)),
    );
  }

  return container;
}

export interface FinalContainerParams extends ChatContainerBaseParams {
  metadata: FinalMetadata;
  /** 全 message 数（footer のページ番号表示に使用）。isLast の message でのみ参照される */
  pageInfo?: { page: number; total: number };
}

/**
 * 完了時の Container を構築する。
 * footer（ページ番号 + LLM 詳細情報）は isLast かつ showLlmDetails 有効・usage ありの場合のみ表示する。
 * Section は使わない（ボタン不要な状態のため）。
 */
export function buildFinalContainer(params: FinalContainerParams): ContainerBuilder {
  const container = new ContainerBuilder().setAccentColor(params.color);
  addBadgeAndBody(container, params);

  if (params.isLast) {
    const footerText = buildFinalFooterText(params.metadata, params.pageInfo);
    if (footerText) {
      container.addSeparatorComponents((sep) =>
        sep.setDivider(false).setSpacing(SeparatorSpacingSize.Small),
      );
      container.addTextDisplayComponents((td) => td.setContent(footerText));
    }
  }

  return container;
}

export interface StoppedContainerParams extends ChatContainerBaseParams {
  elapsedSeconds: number;
}

/**
 * 停止時の Container を構築する。
 * usage が無いため Tokens は含めず、経過秒数のみを footer に表示する。Section は使わない。
 */
export function buildStoppedContainer(params: StoppedContainerParams): ContainerBuilder {
  const container = new ContainerBuilder().setAccentColor(params.color);
  addBadgeAndBody(container, params);

  if (params.isLast) {
    container.addSeparatorComponents((sep) =>
      sep.setDivider(false).setSpacing(SeparatorSpacingSize.Small),
    );
    container.addTextDisplayComponents((td) =>
      td.setContent(buildStoppedFooterText(params.elapsedSeconds)),
    );
  }

  return container;
}

/** エラー表示用の Container を構築する（accent: RED、単一 TextDisplay） */
export function buildErrorContainer(message: string, title = "エラー"): ContainerBuilder {
  return new ContainerBuilder()
    .setAccentColor(EmbedColors.RED)
    .addTextDisplayComponents((td) => td.setContent(`## ⚠️ ${title}\n\n${message}`));
}

// --- 送信 payload ヘルパ ---
// allowedMentions / flags を必ず内包し、呼び出し側で上書きできない形にする（mention 漏れ事故防止）。

/** channel.send 用の Components V2 payload を構築する */
export function toComponentsV2Payload(container: ContainerBuilder): MessageCreateOptions {
  return {
    components: [container],
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] },
  };
}

/** message.edit 用の Components V2 payload を構築する */
export function toComponentsV2EditPayload(container: ContainerBuilder): MessageEditOptions {
  return {
    components: [container],
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] },
  };
}

/** message.reply 用の Components V2 payload を構築する（repliedUser: false も強制） */
export function toComponentsV2ReplyPayload(container: ContainerBuilder): MessageReplyOptions {
  return {
    components: [container],
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [], repliedUser: false },
  };
}
