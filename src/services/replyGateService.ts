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
      false: `人どうしで続いている会話、相づちや感想、特定の人に向けた発言、${botName} の回答への礼や人どうしの反応。`,
    },
  };
}

interface ReplyGateMessage {
  author: string;
  text: string;
  poll?: string;
  attachments: { kind: "image" | "pdf" | "other"; filename: string }[];
}

function formatMessage(message: ReplyGateMessage): string {
  const text = Array.from([message.text, message.poll].filter(Boolean).join("\n"));
  const labels = { image: "画像", pdf: "PDF", other: "ファイル" };
  return `${message.author}: ${text.slice(0, 400).join("")}${text.length > 400 ? "…" : ""}${message.attachments.map((attachment) => ` [${labels[attachment.kind]} ${attachment.filename}]`).join("")}`;
}

export function buildReplyGateState(input: {
  botName: string;
  current: ReplyGateMessage;
  conversation?: { messages: NormalizedMessage[]; replyTarget?: NormalizedMessage };
  isReplyToBot: boolean;
}): Record<string, unknown> {
  const newMessage = formatMessage(input.current);
  if (!input.conversation) {
    return {
      bot_name: input.botName,
      new_message: newMessage,
      is_reply_to_bot: input.isReplyToBot,
    };
  }
  const recent = input.conversation.messages.slice(-20).map(formatMessage);
  const replyTarget = input.conversation.replyTarget
    ? formatMessage(input.conversation.replyTarget)
    : undefined;
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
}

export class ReplyGateService implements IReplyGateService {
  private readonly silenced = new Map<string, number>();

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
      if (decision === "silent") this.silenced.set(input.messageId, this.now() + 60 * 60 * 1000);
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
      return "reply";
    }
  }

  wasSilenced(messageId: string): boolean {
    this.prune();
    return this.silenced.has(messageId);
  }

  private prune(): void {
    const now = this.now();
    for (const [id, expiry] of this.silenced) {
      if (expiry <= now) this.silenced.delete(id);
    }
  }
}
