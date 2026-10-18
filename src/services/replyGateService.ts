import type { DecisionsNoulQuestion, IDecisionsClient } from "../llm/openrouter";
import type { NormalizedMessage } from "../utils/discordMessageNormalizer";
import { logger } from "../utils/logger";
import { estimateTextTokens } from "../utils/tokenEstimate";

export const REPLY_GATE_MODEL = "typesafe/jev-1.14";
export const REPLY_GATE_TIMEOUT_MS = 3000;

export function buildReplyGateQuestion(botName: string): DecisionsNoulQuestion {
  return {
    type: "noul",
    instructions: `Discord のチャンネルに常駐する AI アシスタント「${botName}」が、新しい発言に返答すべきかを判定する。`,
    criteria: {
      true: `${botName} に向けた発言（名前で呼ぶ、${botName} の直前の回答への続きの質問）、または参加者が答えや作業を求めていて ${botName} が役に立つ発言。`,
      false: `人どうしで続いている会話、相づちや感想、特定の人に向けた発言、${botName} の回答への礼や人どうしの反応。${botName} に黙る、口を挟まないよう求める発言（${botName} に向けていても黙る）。${botName} に答えを求めず、${botName} の仕組みや挙動について人どうしで推測や感想を述べる発言。独り言やメモ。`,
    },
  };
}

interface ReplyGateMessage {
  kind?: NormalizedMessage["kind"];
  /** A reply of the bot's that the gate chose, rather than one it was called for. */
  autoReply?: boolean;
  author: string;
  text: string;
  poll?: string;
  attachments: { kind: "image" | "pdf" | "other"; filename: string }[];
}

/**
 * The question names the bot, so the bot's own replies (author "assistant"
 * in the window) and mentions of it (`<@id>` in raw content) are rewritten
 * to that name; otherwise "a follow-up to the bot's answer" has nothing in
 * the state to match. Any other user mention becomes `@メンバー`: a bare id
 * does not tell the model the message is addressed to a person, and Jev
 * scored "<@id> この英文訳せる？" as one for the bot. Names are not looked up,
 * since the window keeps no member data and a lookup per mention would delay
 * every judged message.
 *
 * A reply the gate chose is marked `（自動応答）`. Without the mark, every
 * reply reads as one the bot was asked for, so after a run of unasked replies
 * the next person's message reads as a follow-up to the bot.
 */
function formatMessage(message: ReplyGateMessage, botName: string, botUserId: string): string {
  const author =
    message.kind === "assistant"
      ? `${botName}${message.autoReply ? AUTO_REPLY_MARK : ""}`
      : message.author;
  const body = [message.text, message.poll]
    .filter(Boolean)
    .join("\n")
    .replace(/<@!?(\d+)>/g, (_, id: string) => (id === botUserId ? `@${botName}` : "@メンバー"));
  const text = Array.from(body);
  const labels = { image: "画像", pdf: "PDF", other: "ファイル" };
  return `${author}: ${text.slice(0, 400).join("")}${text.length > 400 ? "…" : ""}${message.attachments.map((attachment) => ` [${labels[attachment.kind]} ${attachment.filename}]`).join("")}`;
}

export const AUTO_REPLY_MARK = "（自動応答）";

export function buildReplyGateState(input: {
  botName: string;
  botUserId: string;
  current: ReplyGateMessage;
  conversation?: { messages: NormalizedMessage[]; replyTarget?: NormalizedMessage };
  isReplyToBot: boolean;
  /** Whether a bot reply in the conversation was one the gate chose. */
  isAutoReply?: (message: NormalizedMessage) => boolean;
}): Record<string, unknown> {
  const format = (message: ReplyGateMessage | NormalizedMessage): string =>
    formatMessage(
      "exchangeId" in message && message.kind === "assistant"
        ? { ...message, autoReply: input.isAutoReply?.(message) ?? false }
        : message,
      input.botName,
      input.botUserId,
    );
  const newMessage = format(input.current);
  if (!input.conversation) {
    return {
      bot_name: input.botName,
      new_message: newMessage,
      is_reply_to_bot: input.isReplyToBot,
    };
  }
  const target = input.conversation.replyTarget;
  // The reply target is its own field, so it neither takes one of the 20 places nor counts twice.
  const recent = input.conversation.messages
    .filter((message) => message.id !== target?.id)
    .slice(-20)
    .map(format);
  const replyTarget = target ? format(target) : undefined;
  let tokens =
    estimateTextTokens(newMessage) +
    (replyTarget ? estimateTextTokens(replyTarget) : 0) +
    recent.reduce((total, message) => total + estimateTextTokens(message), 0);
  // Required messages and attachment labels stay intact even if they alone exceed the budget.
  while (tokens > 3000 && recent.length > 0) {
    tokens -= estimateTextTokens(recent.shift() as string);
  }
  return {
    bot_name: input.botName,
    recent_messages: recent,
    ...(replyTarget !== undefined && { reply_target: replyTarget }),
    new_message: newMessage,
  };
}

interface ReplyGateInput {
  guildId: string;
  channelId: string;
  messageId: string;
  state: Record<string, unknown>;
  botName: string;
}

export interface IReplyGateService {
  judge(input: ReplyGateInput): Promise<"reply" | "silent">;
  wasSilenced(messageId: string): boolean;
  /** Whether this message was answered because the gate chose it (or failed and fell back to replying). */
  wasAnswered(messageId: string): boolean;
}

/** Both are kept as long as the conversation window looks back (`WINDOW_RAW_AGE_MS`). */
const REMEMBER_MS = 60 * 60 * 1000;

export class ReplyGateService implements IReplyGateService {
  private readonly silenced = new Map<string, number>();
  private readonly answered = new Map<string, number>();

  constructor(
    private readonly client: IDecisionsClient,
    private readonly threshold: number,
    private readonly now: () => number = Date.now,
  ) {}

  async judge(input: ReplyGateInput): Promise<"reply" | "silent"> {
    this.prune();
    const startedAt = this.now();
    const meta = {
      guildId: input.guildId,
      channelId: input.channelId,
      messageId: input.messageId,
      threshold: this.threshold,
    };
    try {
      const result = await this.client.decideNoul(
        {
          model: REPLY_GATE_MODEL,
          state: input.state,
          questions: { should_reply: buildReplyGateQuestion(input.botName) },
        },
        "should_reply",
        AbortSignal.timeout(REPLY_GATE_TIMEOUT_MS),
      );
      const decision = result.noul >= this.threshold ? "reply" : "silent";
      (decision === "silent" ? this.silenced : this.answered).set(
        input.messageId,
        this.now() + REMEMBER_MS,
      );
      logger.info("Reply gate", {
        ...meta,
        decision,
        noul: result.noul,
        elapsed: this.now() - startedAt,
        cost: result.cost,
        model: result.model ?? REPLY_GATE_MODEL,
      });
      return decision;
    } catch (error) {
      const status =
        typeof error === "object" && error !== null && "status" in error ? error.status : undefined;
      logger.info("Reply gate", {
        ...meta,
        decision: "error",
        elapsed: this.now() - startedAt,
        model: REPLY_GATE_MODEL,
        error:
          typeof status === "number" ? status : error instanceof Error ? error.name : typeof error,
      });
      this.answered.set(input.messageId, this.now() + REMEMBER_MS);
      return "reply";
    }
  }

  wasSilenced(messageId: string): boolean {
    this.prune();
    return this.silenced.has(messageId);
  }

  wasAnswered(messageId: string): boolean {
    this.prune();
    return this.answered.has(messageId);
  }

  private prune(): void {
    const now = this.now();
    for (const map of [this.silenced, this.answered]) {
      for (const [id, expiry] of map) {
        if (expiry <= now) map.delete(id);
      }
    }
  }
}
