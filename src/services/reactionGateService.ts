import type {
  DecisionsChoiceQuestion,
  DecisionsNoulQuestion,
  IDecisionsAnswersClient,
} from "../llm/openrouter";
import type { ApiKeySource } from "../types";
import type { NormalizedMessage } from "../utils/discordMessageNormalizer";
import { logger } from "../utils/logger";
import { REACTION_EMOJI } from "./reactionEmoji";
import { REPLY_GATE_MODEL } from "./replyGateService";

/** A slow judgment delays the first page of a reply that needs text, so it gives up early. */
export const REACTION_GATE_TIMEOUT_MS = 1500;
/** The judgment state cuts a message at this length, so a longer one could hide a question. */
export const MAX_REACTION_GATE_CHARS = 400;
export const MAX_EMOJI_CHOICES = 255;
const MAX_CUSTOM_EMOJI_CHOICES = 100;

/**
 * Both must hold for a reaction alone. A reaction where text was needed leaves
 * the person without an answer, while text where a reaction was enough is only
 * what the bot did anyway, so both lean towards text. On the cases in
 * `scripts/reaction-gate-cases.ts` (2026-11-09), messages that need text fell
 * below `NEEDS_TEXT` only as short replies accepting an offer, and `ACCEPTS`
 * caught those at 0.4: at 0.45 "よろしくー" got through once in 465 judgments.
 */
export const NEEDS_TEXT_THRESHOLD = 0.3;
export const ACCEPTS_THRESHOLD = 0.4;

export function buildReactionGateQuestions(
  botName: string,
  customEmoji: readonly string[],
): {
  needs_text: DecisionsNoulQuestion;
  accepts: DecisionsNoulQuestion;
  emoji: DecisionsChoiceQuestion;
} {
  const custom = customEmoji.slice(0, MAX_CUSTOM_EMOJI_CHOICES);
  const choices = [...new Set([...custom, ...REACTION_EMOJI])].slice(0, MAX_EMOJI_CHOICES);
  return {
    needs_text: {
      type: "noul",
      instructions: `Discord の AI アシスタント「${botName}」への新しい発言に、本文の返答が要るかを判定する。リアクションだけで応えると、発言者には本文が届かない。`,
      criteria: {
        true: `答え、説明、作業、意見を求めている、困っている、反論している、または ${botName} の質問や提案への返事で、${botName} の作業が続く発言。`,
        false: `礼、了解、相づち、感想、挨拶だけで、これ以上 ${botName} に求めることが無い発言。`,
      },
    },
    // `needs_text` alone read "了解" and "よろしく" after an offer as an acknowledgement in 28 of 87
    // judgments, and a wording of `needs_text` that names offers did not change that.
    accepts: {
      type: "noul",
      instructions: `${botName} の最後の発言が、具体的な作業の提案か、発言者への質問になっているかを見る。そうであれば、新しい発言がそれに応じて ${botName} に続きを求めているかを判定する。last_bot_message_end があれば、それが最後の発言の末尾である。`,
      criteria: {
        true: `${botName} が具体的な作業を提案するか質問をしていて、新しい発言がそれを受け入れて続きを待っている。了解、よろしく、助かる、いいね のような短い返事もこれに当たる。`,
        false: `${botName} の最後の発言に具体的な提案や質問が無い（「他に質問があれば」のような締めくくりだけである）、または新しい発言が礼や断りで終わっている。`,
      },
    },
    emoji: {
      type: "choice",
      instructions: `この発言に Discord のリアクションで応えるなら、どの絵文字が最も自然かを選ぶ。${
        custom.length > 0 ? "英字の名前はこのサーバーのカスタム絵文字である。" : ""
      }`,
      criteria: Object.fromEntries(choices.map((emoji) => [emoji, null])),
    },
  };
}

/**
 * The judgment state keeps the start of each message, while a long answer ends
 * on its offer ("…サンプルも書きましょうか？"), so "了解" after one would read as
 * thanks after a finished answer. Only this judgment needs the end, so the state
 * the reply gate reads stays as its thresholds were tuned on.
 */
export function withBotMessageEnd(
  state: Record<string, unknown>,
  conversation: { messages: NormalizedMessage[]; replyTarget?: NormalizedMessage } | undefined,
): Record<string, unknown> {
  const target =
    conversation?.replyTarget?.kind === "assistant"
      ? conversation.replyTarget
      : conversation?.messages.findLast((message) => message.kind === "assistant");
  if (!target) return state;
  const chars = Array.from(target.text);
  if (chars.length <= MAX_REACTION_GATE_CHARS) return state;
  return { ...state, last_bot_message_end: chars.slice(-MAX_REACTION_GATE_CHARS).join("") };
}

export interface ReactionGateInput {
  guildId: string;
  channelId: string;
  messageId: string;
  botName: string;
  state: Record<string, unknown>;
  customEmoji: readonly string[];
}

export interface IReactionGateService {
  /** The emoji to answer with alone, or null to answer in text, including whenever the judgment fails. */
  judge(
    input: ReactionGateInput,
    client: IDecisionsAnswersClient,
    source: ApiKeySource,
  ): Promise<string | null>;
}

function noulOf(answer: unknown): number | undefined {
  if (typeof answer !== "object" || answer === null || !("noul" in answer)) return undefined;
  return typeof answer.noul === "number" && Number.isFinite(answer.noul) ? answer.noul : undefined;
}

function choiceOf(answer: unknown): string | undefined {
  if (typeof answer !== "object" || answer === null || !("choice" in answer)) return undefined;
  return typeof answer.choice === "string" ? answer.choice : undefined;
}

export class ReactionGateService implements IReactionGateService {
  constructor(private readonly now: () => number = Date.now) {}

  async judge(
    input: ReactionGateInput,
    client: IDecisionsAnswersClient,
    source: ApiKeySource,
  ): Promise<string | null> {
    const startedAt = this.now();
    const meta = { guildId: input.guildId, channelId: input.channelId, messageId: input.messageId };
    try {
      const questions = buildReactionGateQuestions(input.botName, input.customEmoji);
      const result = await client.decide(
        { model: REPLY_GATE_MODEL, state: input.state, questions },
        AbortSignal.timeout(REACTION_GATE_TIMEOUT_MS),
      );
      const needsText = noulOf(result.answers.needs_text);
      const accepts = noulOf(result.answers.accepts);
      const choice = choiceOf(result.answers.emoji);
      const emoji =
        needsText !== undefined &&
        accepts !== undefined &&
        needsText < NEEDS_TEXT_THRESHOLD &&
        accepts < ACCEPTS_THRESHOLD &&
        choice !== undefined &&
        choice in questions.emoji.criteria
          ? choice
          : null;
      logger.info("Reaction gate", {
        ...meta,
        decision: emoji === null ? "text" : "reaction",
        needsText,
        accepts,
        choice,
        elapsed: this.now() - startedAt,
        cost: result.cost,
        keySource: source,
      });
      return emoji;
    } catch (error) {
      const status =
        typeof error === "object" && error !== null && "status" in error ? error.status : undefined;
      logger.info("Reaction gate", {
        ...meta,
        decision: "error",
        elapsed: this.now() - startedAt,
        keySource: source,
        error:
          typeof status === "number" ? status : error instanceof Error ? error.name : typeof error,
      });
      return null;
    }
  }
}
