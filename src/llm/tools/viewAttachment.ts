import type { IClientTool, IToolContext, IToolInvocationMeta, ToolLlmResult } from "./registry";

interface ViewAttachmentArguments {
  message_ref: string;
  attachment_index: number;
}

export class ViewAttachmentTool implements IClientTool<ViewAttachmentArguments> {
  readonly name = "view_attachment";
  readonly description =
    "Open one PNG, JPEG, GIF, WebP, or PDF attachment from a message already shown in this response.";
  readonly parameters: Record<string, unknown> = {
    type: "object",
    properties: {
      message_ref: { type: "string", pattern: "^m[0-9]+$" },
      attachment_index: { type: "integer", minimum: 1 },
    },
    required: ["message_ref", "attachment_index"],
    additionalProperties: false,
  };

  isEnabled(ctx: IToolContext): boolean {
    return ctx.toolsAllowed !== false && ctx.conversation !== undefined;
  }

  validate(
    args: unknown,
  ): { ok: true; value: ViewAttachmentArguments } | { ok: false; error: string } {
    if (typeof args !== "object" || args === null || Array.isArray(args)) {
      return { ok: false, error: "arguments must be an object" };
    }
    const value = args as { message_ref?: unknown; attachment_index?: unknown };
    if (typeof value.message_ref !== "string" || !/^m[0-9]+$/u.test(value.message_ref)) {
      return { ok: false, error: "message_ref must be a response reference such as m7" };
    }
    if (!Number.isInteger(value.attachment_index) || (value.attachment_index as number) < 1) {
      return { ok: false, error: "attachment_index must be a positive integer" };
    }
    return {
      ok: true,
      value: {
        message_ref: value.message_ref,
        attachment_index: value.attachment_index as number,
      },
    };
  }

  async handler(
    args: ViewAttachmentArguments,
    ctx: IToolContext,
    signal: AbortSignal,
    _meta: IToolInvocationMeta,
  ): Promise<{ llmResult: ToolLlmResult }> {
    if (!ctx.conversation || !ctx.model) {
      return { llmResult: '{"error":"attachment_unavailable"}' };
    }
    return {
      llmResult: await ctx.conversation.viewAttachment(
        args.message_ref,
        args.attachment_index,
        ctx.model,
        signal,
      ),
    };
  }
}

export function createViewAttachmentTool(): ViewAttachmentTool {
  return new ViewAttachmentTool();
}
