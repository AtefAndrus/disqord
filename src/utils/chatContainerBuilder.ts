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

/**
 * 1 message の全 TextDisplay 合計文字数上限。
 * Discord の文書化された上限は 4000 字（per-component ではなく1 message 内の全 TextDisplay 合計）。
 * 200 字の安全マージンを引いた値をここで使用する。
 */
export const MAX_TOTAL_CHARS_PER_MESSAGE = 3800;

/**
 * 1 message の全 TextDisplay 合計 UTF-8 バイト数上限。
 * 実 API 検証の結果、Discord は文書化された「4000 字」制限とは別に UTF-8 バイト数ベースの内部制限を
 * 持つことが判明した（実測境界 ≈ 10.17KB、超過時は 400 ではなく HTTP 500 を返す）。日本語主体
 * (≈3 bytes/字) の応答は文字数制限だけでは容易に超過するため、バイト予算も併用する。
 * 安全マージンを見て 9000 バイト（旧 embed 実装の MAX_BYTE_LENGTH と同値）とする。
 * 詳細は docs/changes/chat-response-v2/design.md の Open Questions / Risks を参照。
 */
export const MAX_TOTAL_BYTES_PER_MESSAGE = 9000;

/** ストリーミング中、Section 内に表示する固定ラベル */
export const STREAMING_LABEL = "生成中...";

/**
 * 本文が空文字列の場合に表示するプレースホルダー。
 * discord.js の TextDisplayBuilder#setContent は空文字列を同期的に reject (ExpectedConstraintError)
 * するため、builder を total function にするための最終防御としてここでフォールバックする。
 */
export const EMPTY_TEXT_PLACEHOLDER = "（応答なし）";

/** ページ番号 prefix（"ページ 99/99 | "相当）の予約文字数・バイト数。footer 予算見積りに使用 */
const PAGE_PREFIX_RESERVE_CHARS = 20;
const PAGE_PREFIX_RESERVE_BYTES = 30;

const textEncoder = new TextEncoder();

/** UTF-8 バイト長を計測する */
function byteLength(text: string): number {
  return textEncoder.encode(text).length;
}

/** ある文字列を 1 message に同居させる際に予算から差し引くべき文字数・バイト数 */
export interface TextBudget {
  chars: number;
  bytes: number;
}

/** 予算の消費が無いことを表す定数（footer が存在しない message 用） */
export const ZERO_TEXT_BUDGET: TextBudget = { chars: 0, bytes: 0 };

/** 文字列から TextBudget（文字数・UTF-8バイト数）を計測する */
export function measureTextBudget(text: string): TextBudget {
  return { chars: text.length, bytes: byteLength(text) };
}

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
  /**
   * Short user-facing annotation for a non-`stop` completion (e.g.
   * finishReason "length"/"content_filter"). Shown regardless of
   * `showDetails`, since it describes how the response itself ended rather
   * than optional LLM diagnostics.
   */
  note?: string;
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
 * text を「char 数 <= maxChars かつ UTF-8 byte 数 <= maxBytes」を満たす最大位置ごとに分割する。
 * 改行優先（cut 位置の 80% 以降に改行があればそこで切る。改行そのものは含めた上で両予算を満たす）。
 * コードポイント単位でイテレートするため、サロゲートペア（絵文字等）や結合文字の途中で切れることはない。
 *
 * 契約: maxChars / maxBytes が 1 コードポイント分未満（例: 0 や、その文字のサイズより小さい値）の
 * 極端な場合は、無限ループを避けて必ず前進するため、コードポイント 1 個を 1 chunk として押し出す。
 * この場合、その chunk は maxChars / maxBytes を超過しうる（呼び出し側の予算計算が呼び出し不能な
 * ほど小さい値を渡さない限り実運用では到達しない分岐であり、意図的に例外を投げない）。
 */
export function splitTextByCharsAndBytes(
  text: string,
  maxChars: number,
  maxBytes: number,
): string[] {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxChars && byteLength(remaining) <= maxBytes) {
      chunks.push(remaining);
      break;
    }

    let charCount = 0;
    let byteCount = 0;
    let cutIndex = 0; // remaining 内の UTF-16 コードユニット位置

    for (const codePoint of remaining) {
      const cpChars = codePoint.length; // サロゲートペアなら2
      const cpBytes = byteLength(codePoint);
      if (charCount + cpChars > maxChars || byteCount + cpBytes > maxBytes) {
        break;
      }
      charCount += cpChars;
      byteCount += cpBytes;
      cutIndex += cpChars;
    }

    // 1コードポイントも入らない極端なケースの保険（無限ループ防止、コードポイント境界は保つ）。
    // 上記の契約どおり、この場合は予算超過を許容してでも前進する。
    if (cutIndex === 0) {
      const firstCodePoint = remaining[Symbol.iterator]().next().value as string | undefined;
      cutIndex = firstCodePoint?.length ?? 1;
    }

    // 改行優先: cutIndex 直前（cutIndex自身は次chunkの先頭候補で未確定のため除外）に改行があり、
    // それが80%以降の位置なら改行を含めてそこで切る。cutIndex 自身を検索範囲に含めると、直後の
    // 改行が「まだ含めていないのに含めた」形で誤検出され、両予算を超過しうる（レビュー指摘）。
    const lastNewline = remaining.lastIndexOf("\n", cutIndex - 1);
    if (lastNewline > cutIndex * 0.8) {
      cutIndex = lastNewline + 1;
    }

    chunks.push(remaining.slice(0, cutIndex));
    remaining = remaining.slice(cutIndex);
  }

  return chunks;
}

/**
 * 本文を「1 message に載る本文量」ごとに分割する。1 message の全 TextDisplay 合計が
 * 文字数上限 (MAX_TOTAL_CHARS_PER_MESSAGE) と UTF-8 バイト数上限 (MAX_TOTAL_BYTES_PER_MESSAGE) の
 * 両方を満たすことを保証する。badge / footer はその message に同居しうる TextBudget（文字数・
 * バイト数）で、両方の合計予算から差し引く。badge は先頭 message、footer は末尾 message にしか
 * 実際には乗らないが、簡潔さと安全性を優先し全 message に同一予算を適用する。
 */
export function splitTextIntoMessages(
  text: string,
  badge: TextBudget,
  footer: TextBudget,
): string[] {
  const bodyBudgetChars = Math.max(1, MAX_TOTAL_CHARS_PER_MESSAGE - badge.chars - footer.chars);
  const bodyBudgetBytes = Math.max(1, MAX_TOTAL_BYTES_PER_MESSAGE - badge.bytes - footer.bytes);
  const chunks = splitTextByCharsAndBytes(text, bodyBudgetChars, bodyBudgetBytes);
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
 * message の footer 文字列（ページ番号 + LLM 詳細情報）。
 * ページ番号は pageInfo.total > 1 のとき（複数 message 時）常に含む。LLM 詳細情報は
 * showLlmDetails=false や usage 未取得時は含めない（buildUsageDetailsText が undefined を返す）。
 * どちらも無ければ footer 自体を出さない（undefined）。
 */
export function buildFinalFooterText(
  metadata: FinalMetadata,
  pageInfo?: { page: number; total: number },
): string | undefined {
  const details = buildUsageDetailsText(metadata);
  const pageText =
    pageInfo && pageInfo.total > 1 ? `ページ ${pageInfo.page}/${pageInfo.total}` : undefined;

  const parts = [metadata.note, pageText, details].filter(
    (part): part is string => part !== undefined && part.length > 0,
  );
  return parts.length > 0 ? parts.join(" | ") : undefined;
}

/**
 * 停止時の footer 文字列（"🛑 Stopped | xx.xs | NNN字"）。
 * usage は取得できないため Tokens は含めず、代わりに受信済み文字数を確定情報として表示する。
 * receivedChars が 0 の場合は文字数部を省略する。
 */
export function buildStoppedFooterText(elapsedSeconds: number, receivedChars: number): string {
  const base = `🛑 Stopped | ${elapsedSeconds.toFixed(1)}s`;
  return receivedChars > 0 ? `${base} | ${receivedChars}字` : base;
}

/**
 * footer の TextBudget 見積り（ページ番号 prefix のマージン + LLM 詳細情報）。
 * ページ番号は message 数が確定するまで有無が分からないため、details の有無によらず常に
 * ページ prefix 分のマージンを確保する。
 */
export function estimateFinalFooterBudget(metadata: FinalMetadata): TextBudget {
  const details = buildUsageDetailsText(metadata);
  const detailsBudget = details ? measureTextBudget(details) : ZERO_TEXT_BUDGET;
  // " | " suffix reserved alongside the note itself: an over-estimate is
  // harmless (the split just reserves a few extra bytes/chars), but an
  // under-estimate could let the note push a message over Discord's limits.
  const noteBudget = metadata.note ? measureTextBudget(`${metadata.note} | `) : ZERO_TEXT_BUDGET;
  return {
    chars: PAGE_PREFIX_RESERVE_CHARS + detailsBudget.chars + noteBudget.chars,
    bytes: PAGE_PREFIX_RESERVE_BYTES + detailsBudget.bytes + noteBudget.bytes,
  };
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
 * footer のページ番号（"ページ n/N"）は pageInfo.total > 1 のとき全 message に表示する
 * （旧 embed 実装の挙動）。LLM 詳細情報（Tokens/Cost 等）は isLast かつ showLlmDetails 有効・
 * usage ありの場合のみ末尾に追加する。Section は使わない（ボタン不要な状態のため）。
 */
export function buildFinalContainer(params: FinalContainerParams): ContainerBuilder {
  const container = new ContainerBuilder().setAccentColor(params.color);
  addBadgeAndBody(container, params);

  // LLM 詳細情報は末尾 message のみ。非末尾 message は showDetails: false 相当にしてページ番号のみにする
  const footerMetadata: FinalMetadata = params.isLast ? params.metadata : { showDetails: false };
  const footerText = buildFinalFooterText(footerMetadata, params.pageInfo);
  if (footerText) {
    container.addSeparatorComponents((sep) =>
      sep.setDivider(false).setSpacing(SeparatorSpacingSize.Small),
    );
    container.addTextDisplayComponents((td) => td.setContent(footerText));
  }

  return container;
}

export interface StoppedContainerParams extends ChatContainerBaseParams {
  elapsedSeconds: number;
  /** 受信済み文字数（Abort 時点までに届いた実テキスト長）。0 なら footer に含めない */
  receivedChars: number;
}

/**
 * 停止時の Container を構築する。
 * usage は取得できないため Tokens は含めず、経過秒数と受信済み文字数を footer に表示する。
 * Section は使わない。
 */
export function buildStoppedContainer(params: StoppedContainerParams): ContainerBuilder {
  const container = new ContainerBuilder().setAccentColor(params.color);
  addBadgeAndBody(container, params);

  if (params.isLast) {
    container.addSeparatorComponents((sep) =>
      sep.setDivider(false).setSpacing(SeparatorSpacingSize.Small),
    );
    container.addTextDisplayComponents((td) =>
      td.setContent(buildStoppedFooterText(params.elapsedSeconds, params.receivedChars)),
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
