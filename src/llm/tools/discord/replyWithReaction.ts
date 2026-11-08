import type {
  IClientTool,
  IToolContext,
  IToolHandlerResult,
  IToolInvocationMeta,
} from "../registry";
import { isReactionToolEnabled, validateReactionEmoji } from "./addReaction";

export const REPLY_WITH_REACTION_TOOL = "reply_with_reaction";

interface Arguments {
  emoji: string;
}

/**
 * A separate tool rather than `add_reaction` followed by an empty answer: that
 * takes one more model call, and whether the model then writes nothing is up
 * to the model, while an empty answer also means a failed response.
 *
 * The description is what keeps a question from getting a reaction alone, and
 * `scripts/reaction-only-eval.ts` measures it. With "a question or a request,
 * including one that follows thanks" alone, z-ai/glm-5.3-flash answered "thanks,
 * now show me an example" with a reaction once in 160 runs (2026-11-08).
 */
export class ReplyWithReactionTool implements IClientTool<Arguments> {
  readonly name = REPLY_WITH_REACTION_TOOL;
  readonly description =
    "Respond to the user's current message with only a reaction and no text, when the whole message needs no answer and no work and a reaction is enough: thanks, an acknowledgement, a short back-channel remark. Never use it when any part of the message asks a question or requests something, such as a request that follows thanks (\"thanks, now show me...\"), or when the user seems stuck; answer those in text. Calling it ends your response. Use a Unicode emoji or this guild's custom emoji name, without colons or an ID.";
  readonly parameters: Record<string, unknown> = {
    type: "object",
    properties: { emoji: { type: "string", minLength: 1 } },
    required: ["emoji"],
    additionalProperties: false,
  };

  isEnabled(ctx: IToolContext): boolean {
    return isReactionToolEnabled(ctx);
  }

  validate(value: unknown): { ok: true; value: Arguments } | { ok: false; error: string } {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return { ok: false, error: "arguments must be an object" };
    const emoji = validateReactionEmoji((value as Record<string, unknown>).emoji);
    return typeof emoji === "string" ? { ok: true, value: { emoji } } : emoji;
  }

  async handler(
    args: Arguments,
    ctx: IToolContext,
    signal: AbortSignal,
    _meta: IToolInvocationMeta,
  ): Promise<IToolHandlerResult> {
    const llmResult = ctx.discord
      ? await ctx.discord.addReaction(args.emoji, undefined, signal)
      : '{"ok":false,"reason":"unavailable"}';
    // A failure goes back to the model, which then answers in text: with
    // neither a reaction nor text, the user would get nothing at all.
    const added = (JSON.parse(llmResult) as { ok?: unknown }).ok === true;
    return { llmResult, terminal: true, ...(added && { endResponse: { reaction: args.emoji } }) };
  }
}

export function createReplyWithReactionTool(): ReplyWithReactionTool {
  return new ReplyWithReactionTool();
}
