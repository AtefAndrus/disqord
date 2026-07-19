import type { ILLMClient } from "../llm/openrouter";
import type { IToolLoopUpdater, ToolLoopResult } from "../llm/toolLoop";
import { runToolLoop } from "../llm/toolLoop";
import type { ToolRegistry } from "../llm/tools/registry";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
  ChatMessageContent,
  GuildId,
  MessageId,
} from "../types";
import { PDF_PARSER_PLUGIN } from "./attachmentParser";
import type { ISettingsService } from "./settingsService";

export interface ChatUserInput {
  text: string;
  parts?: ChatMessageContent[];
}

/** Non-guild context the tool loop needs (guildId is threaded in separately). */
export interface ChatRequestContext {
  channelId: string;
  userId: string;
}

export interface IChatService {
  generateResponse(
    guildId: GuildId,
    input: ChatUserInput,
  ): Promise<{ text: string; metadata?: ChatCompletionResponse & { latency: number } }>;
  /**
   * Runs the normal chat path through `runToolLoop()`. With no tools
   * registered this resolves in exactly one model request (no `tools`/
   * `tool_choice` sent), matching the pre-tool-calling-foundation behavior.
   */
  generateChatResponse(
    guildId: GuildId,
    input: ChatUserInput,
    requestId: MessageId,
    updater: IToolLoopUpdater,
    ctx: ChatRequestContext,
  ): Promise<ToolLoopResult>;
  cancelRequest(requestId: MessageId): boolean;
}

function pickDefaultPrompt(parts: ChatMessageContent[]): string {
  const hasImage = parts.some((p) => p.type === "image_url");
  const hasFile = parts.some((p) => p.type === "file");
  if (hasImage && hasFile) return "添付ファイルについて説明してください。";
  if (hasImage) return "添付された画像について説明してください。";
  return "添付された文書を要約してください。";
}

/**
 * Races `promise` against `signal`. If `signal` aborts first, resolves with
 * `{ ok: false }` without waiting for `promise` — used so a cancel during the
 * very first await (settings fetch) settles the caller immediately instead
 * of leaving it pending until the settings call happens to resolve. Any
 * later rejection/resolution of a "lost" `promise` is swallowed so it can
 * never surface as an unhandled rejection.
 *
 * Cancel always wins once `signal` is aborted, even if `promise` happens to
 * settle (resolve *or* reject) before this function observes the abort:
 * both branches below re-check `signal.aborted` right before settling this
 * function's own promise, and discard the settlement in favor of
 * `{ ok: false }` when it is. Without this, a settings-fetch rejection that
 * settles while `cancelRequest()` has already aborted the request would
 * propagate as an unhandled error instead of the "cancelled" result the
 * stop button already promised the caller.
 */
function raceWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<{ ok: true; value: T } | { ok: false }> {
  if (signal.aborted) {
    promise.catch(() => {});
    return Promise.resolve({ ok: false });
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      promise.catch(() => {});
      resolve({ ok: false });
    };
    signal.addEventListener("abort", onAbort);

    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(signal.aborted ? { ok: false } : { ok: true, value });
      },
      (error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        // A rejection that lands once the request is already aborted must
        // not propagate — it is indistinguishable, from the caller's
        // perspective, from a rejection *caused by* the abort (e.g. a DB
        // client throwing on a torn-down connection), and either way the
        // stop button has already committed to reporting "cancelled".
        if (signal.aborted) {
          resolve({ ok: false });
        } else {
          reject(error);
        }
      },
    );
  });
}

/**
 * Builds the initial `messages` array from user input alone — independent of
 * guild settings (only `model`/`plugins` in `buildChatRequest()` below depend
 * on those). Split out so it can run before the settings-fetch race: a cancel
 * that arrives while settings are still loading must still see the user's
 * message in `history`, not `[]` (design "cancel タイミングで history が
 * 不整合" — dropping the user's own input purely based on cancel timing is a
 * bug, not a feature of "not yet started").
 */
function buildChatMessages(input: ChatUserInput): ChatMessage[] {
  const parts = input.parts ?? [];

  let content: ChatMessage["content"];
  if (parts.length === 0) {
    content = input.text;
  } else {
    // OpenRouter / 一部モデルは text part を含まない content 配列で接続を切るため、
    // text が空の場合は default prompt を補う
    const text = input.text.length > 0 ? input.text : pickDefaultPrompt(parts);
    content = [{ type: "text", text }, ...parts];
  }

  return [{ role: "user", content }];
}

function buildChatRequest(model: string, input: ChatUserInput): ChatCompletionRequest {
  const parts = input.parts ?? [];
  const hasFile = parts.some((p) => p.type === "file");

  return {
    model,
    messages: buildChatMessages(input),
    ...(hasFile && { plugins: [PDF_PARSER_PLUGIN] }),
  };
}

export class ChatService implements IChatService {
  private activeRequests = new Map<MessageId, AbortController>();

  constructor(
    private readonly llmClient: ILLMClient,
    private readonly settingsService: ISettingsService,
    private readonly toolRegistry: ToolRegistry,
  ) {}

  async generateResponse(
    guildId: GuildId,
    input: ChatUserInput,
  ): Promise<{ text: string; metadata?: ChatCompletionResponse & { latency: number } }> {
    const settings = await this.settingsService.getGuildSettings(guildId);

    const startTime = Date.now();
    const response = await this.llmClient.chat(buildChatRequest(settings.defaultModel, input));
    const latency = Date.now() - startTime;

    return {
      text: response.choices[0]?.message.content ?? "",
      metadata: {
        ...response,
        latency,
      },
    };
  }

  async generateChatResponse(
    guildId: GuildId,
    input: ChatUserInput,
    requestId: MessageId,
    updater: IToolLoopUpdater,
    ctx: ChatRequestContext,
  ): Promise<ToolLoopResult> {
    // Registered before any await (design "返り値の観測契約"): the stop
    // button must be able to cancel this request even while settings are
    // still loading, otherwise cancelRequest() would spuriously return
    // false and the request would run to completion regardless.
    const controller = new AbortController();
    this.activeRequests.set(requestId, controller);

    // Built up front, before the settings-fetch race below: message
    // construction depends only on `input`, never on guild settings, so a
    // cancel that lands while settings are still loading must return the
    // same `history` (including the user's message) that a cancel arriving
    // later would have started from — not an empty array purely because of
    // when the cancel happened to land.
    const initialMessages = buildChatMessages(input);

    try {
      // Raced against the cancel signal (design "返り値の観測契約"): without
      // this, a cancel that arrives while settings are still loading would
      // not settle the caller until the settings fetch itself resolves —
      // the stop button would register but the request would still hang.
      const settingsResult = await raceWithAbort(
        this.settingsService.getGuildSettings(guildId),
        controller.signal,
      );
      if (!settingsResult.ok) {
        return { status: "cancelled", history: initialMessages };
      }
      const settings = settingsResult.value;
      const request = buildChatRequest(settings.defaultModel, input);
      return await runToolLoop({
        llmClient: this.llmClient,
        model: request.model,
        messages: request.messages,
        ...(request.plugins && { plugins: request.plugins }),
        registry: this.toolRegistry,
        // serverTools: not wired yet (Phase 4). Future tool changes (e.g.
        // web-search) will pass them through here.
        ctx: { guildId, channelId: ctx.channelId, userId: ctx.userId },
        updater,
        signal: controller.signal,
        requestId,
      });
    } finally {
      this.activeRequests.delete(requestId);
    }
  }

  cancelRequest(requestId: MessageId): boolean {
    const controller = this.activeRequests.get(requestId);
    if (controller) {
      controller.abort();
      this.activeRequests.delete(requestId);
      return true;
    }
    return false;
  }
}
