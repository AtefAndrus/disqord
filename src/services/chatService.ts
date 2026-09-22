import {
  type ConversationContext,
  type ConversationExchange,
  estimatePersistedContentTokens,
  hydratePersistedContent,
  type PersistedContentPart,
  stripHistoricalMedia,
} from "../db/repositories/conversation";
import { BadRequestError } from "../errors";
import type { ILLMClient } from "../llm/openrouter";
import type { IToolLoopUpdater, ToolLoopResult } from "../llm/toolLoop";
import { addUsage, runToolLoop } from "../llm/toolLoop";
import type { ToolRegistry } from "../llm/tools/registry";
import {
  buildWebSearchDateTimeSystemMessage,
  buildWebSearchServerTool,
  buildWebSearchStaticSystemMessage,
  type WebSearchEngine,
} from "../llm/tools/webSearch";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
  ChatMessageContent,
  GuildId,
  MessageId,
} from "../types";
import { PDF_PARSER_PLUGIN } from "./attachmentParser";
import type { IModelService } from "./modelService";
import type { ISettingsService } from "./settingsService";
import {
  buildTweetSystemMessage,
  type ITweetService,
  type TweetExpansionResult,
} from "./tweetService";

export interface ChatUserInput {
  text: string;
  parts?: ChatMessageContent[];
  conversation?: ConversationContext;
  /**
   * Checked right before each model request that would carry
   * `conversation`; `false` sends the request without history.
   */
  isConversationCurrent?: (context: ConversationContext) => Promise<boolean>;
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
function buildChatMessages(
  input: ChatUserInput,
  tweetParts: ChatMessageContent[] = [],
  currentText = input.text,
): ChatMessage[] {
  const parts = [...(input.parts ?? []), ...tweetParts];

  let content: ChatMessage["content"];
  if (parts.length === 0) {
    content = currentText;
  } else {
    // OpenRouter / 一部モデルは text part を含まない content 配列で接続を切るため、
    // text が空の場合は default prompt を補う
    const text = currentText.length > 0 ? currentText : pickDefaultPrompt(parts);
    content = [{ type: "text", text }, ...parts];
  }

  return [{ role: "user", content }];
}

function buildChatRequest(
  model: string,
  input: ChatUserInput,
  tweetParts: ChatMessageContent[] = [],
  messages = buildChatMessages(input, tweetParts),
): ChatCompletionRequest {
  const hasFile = messages.some(
    (message) =>
      Array.isArray(message.content) && message.content.some((part) => part.type === "file"),
  );

  return {
    model,
    messages,
    ...(hasFile && { plugins: [PDF_PARSER_PLUGIN] }),
  };
}

function estimateTextTokens(text: string): number {
  let ascii = 0;
  let nonAscii = 0;
  for (const character of Array.from(text)) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && codePoint <= 0x7f) ascii++;
    else nonAscii++;
  }
  return Math.ceil(ascii / 4) + nonAscii;
}

function estimateContentTokens(content: ChatMessageContent[] | string): number {
  if (typeof content === "string") return estimateTextTokens(content);
  return content.reduce((total, part) => {
    if (part.type === "text") return total + estimateTextTokens(part.text);
    if (part.type === "image_url") return total + 1_000;
    return total + 2_000;
  }, 0);
}

function estimateMessageTokens(message: ChatMessage): number {
  if (message.content === null) return 0;
  return estimateContentTokens(message.content);
}

function estimateHistoricalUserTokens(user: ConversationExchange["user"]): number {
  const label = user.authorLabel ?? user.authorId ?? "user";
  let hasText = false;
  let tokens = 0;
  for (const part of user.content) {
    if (part.type === "text") {
      tokens += estimateTextTokens(hasText ? part.text : `[${label}]: ${part.text}`);
      hasText = true;
      continue;
    }
    // History is sent with media replaced by a short note (stripHistoricalMedia).
    tokens += estimateTextTokens(
      part.type === "image-ref"
        ? "[earlier image omitted]"
        : `[earlier file omitted: ${part.filename}]`,
    );
  }
  if (!hasText) {
    const hasImage = user.content.some((part) => part.type === "image-ref");
    const hasFile = user.content.some((part) => part.type === "file-ref");
    const defaultPrompt =
      hasImage && hasFile
        ? "添付ファイルについて説明してください。"
        : hasImage
          ? "添付された画像について説明してください。"
          : "添付された文書を要約してください。";
    tokens += estimateTextTokens(`[${label}]: ${defaultPrompt}`);
  }
  return tokens;
}

function authorPrefixedText(label: string, text: string, parts: ChatMessageContent[]): string {
  if (text.length > 0) return `[${label}]: ${text}`;
  return `[${label}]: ${pickDefaultPrompt(parts)}`;
}

function buildUserContent(
  label: string,
  text: string,
  parts: ChatMessageContent[],
): string | ChatMessageContent[] {
  const prefixedText = authorPrefixedText(label, text, parts);
  if (parts.length === 0) return prefixedText;
  return [{ type: "text", text: prefixedText }, ...parts];
}

function buildHistoricalUserContent(
  label: string,
  parts: ChatMessageContent[],
): string | ChatMessageContent[] {
  if (parts.length === 0) return authorPrefixedText(label, "", parts);

  let prefixed = false;
  const result = parts.map((part) => {
    if (part.type !== "text" || prefixed) return part;
    prefixed = true;
    return { ...part, text: `[${label}]: ${part.text}` };
  });
  if (!prefixed) {
    result.unshift({ type: "text", text: authorPrefixedText(label, "", parts) });
  }
  return result;
}

async function buildConversationMessages(
  input: ChatUserInput,
  tweetParts: ChatMessageContent[],
  context: ConversationContext,
  leadingSystemMessages: ChatMessage[],
  volatileSystemMessages: ChatMessage[],
  webSearchEngine: WebSearchEngine | undefined,
  contextLength: number | null,
  signal: AbortSignal,
): Promise<ChatMessage[]> {
  const budget = contextLength === null ? 16_000 : Math.min(contextLength * 0.5, 32_000);
  const currentPersisted = context.current.content;
  const currentParts = [...(input.parts ?? []), ...tweetParts];
  const currentMessage = {
    role: "user" as const,
    content: buildUserContent(
      context.current.authorLabel ?? context.current.authorId ?? "user",
      input.text,
      currentParts,
    ),
  };
  const fixedTokens =
    [...leadingSystemMessages, ...volatileSystemMessages, currentMessage].reduce(
      (total, message) => total + estimateMessageTokens(message),
      0,
    ) +
    4_000 +
    (webSearchEngine
      ? estimateTextTokens(JSON.stringify(buildWebSearchServerTool(webSearchEngine)))
      : 0);
  let remaining = budget - fixedTokens;
  const selected: ConversationExchange[] = [];
  if (remaining > 0) {
    for (const exchange of [...context.exchanges].reverse()) {
      const exchangeTokens =
        estimateHistoricalUserTokens(exchange.user) +
        (exchange.assistant ? estimatePersistedContentTokens(exchange.assistant.content) : 0);
      if (exchangeTokens > remaining) break;
      selected.push(exchange);
      remaining -= exchangeTokens;
    }
  }
  selected.reverse();

  const userTurnsForStripping: Array<{ id: number; content: PersistedContentPart[] }> = [
    ...selected.map((exchange) => ({ id: exchange.user.id, content: exchange.user.content })),
    { id: context.current.id, content: currentPersisted },
  ];
  const stripped = stripHistoricalMedia(userTurnsForStripping);
  const strippedById = new Map(stripped.map((turn) => [turn.id, turn.content]));
  const historyMessages: ChatMessage[] = [];
  for (const exchange of selected) {
    const strippedContent = strippedById.get(exchange.user.id) ?? exchange.user.content;
    const hydrated = await hydratePersistedContent(strippedContent, fetch, signal);
    historyMessages.push({
      role: "user",
      content: buildHistoricalUserContent(
        exchange.user.authorLabel ?? exchange.user.authorId ?? "user",
        hydrated,
      ),
    });
    if (exchange.assistant) {
      historyMessages.push({
        role: "assistant",
        content: exchange.assistant.content
          .filter((part) => part.type === "text")
          .map((part) => (part.type === "text" ? part.text : ""))
          .join(""),
      });
    }
  }

  const messages = [
    ...leadingSystemMessages,
    ...historyMessages,
    ...volatileSystemMessages,
    currentMessage,
  ];
  return messages;
}

export class ChatService implements IChatService {
  private activeRequests = new Map<MessageId, AbortController>();

  constructor(
    private readonly llmClient: ILLMClient,
    private readonly settingsService: ISettingsService,
    private readonly toolRegistry: ToolRegistry,
    private readonly webSearchEngine: WebSearchEngine,
    private readonly tweetService: ITweetService,
    private readonly modelService: IModelService,
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
      let expansion: TweetExpansionResult | undefined;
      if (
        settings.twitterExpandEnabled &&
        this.tweetService.extractTweetIds(input.text).length > 0
      ) {
        try {
          const expansionResult = await raceWithAbort(
            this.tweetService.expandTweets(input.text, controller.signal, (signal) =>
              raceWithAbort(
                this.modelService.isMultimodalCapable(settings.defaultModel, "image"),
                signal,
              ).then((result) => (result.ok ? result.value : null)),
            ),
            controller.signal,
          );
          if (!expansionResult.ok || expansionResult.value.status === "cancelled") {
            return { status: "cancelled", history: initialMessages };
          }
          expansion = expansionResult.value;
        } catch {
          // Tweet expansion is an external best-effort dependency. A failed
          // expansion must not prevent the original user message from being sent.
          if (controller.signal.aborted) {
            return { status: "cancelled", history: initialMessages };
          }
        }
      }

      if (controller.signal.aborted) {
        return { status: "cancelled", history: initialMessages };
      }

      const tweetParts = expansion?.parts ?? [];
      const leadingSystemMessages = [
        ...(settings.webSearchEnabled ? [buildWebSearchStaticSystemMessage()] : []),
      ];
      const volatileSystemMessages = [
        ...(expansion && expansion.textParts.length > 0 ? [buildTweetSystemMessage()] : []),
        ...(settings.webSearchEnabled ? [buildWebSearchDateTimeSystemMessage(new Date())] : []),
      ];
      const buildWithoutHistory = (): ChatCompletionRequest =>
        buildChatRequest(settings.defaultModel, input, tweetParts, [
          ...leadingSystemMessages,
          ...volatileSystemMessages,
          ...buildChatMessages(input, tweetParts),
        ]);
      // `/config history off` can land while tweet expansion, the model
      // lookup, or hydration is awaited, so the setting is read again before
      // building the history and once more after it; nothing is awaited
      // between the last read and the request.
      let historyEnabled = Boolean(settings.historyEnabled && input.conversation);
      if (historyEnabled) {
        const usable = await this.isHistoryUsable(input, controller.signal);
        if (usable === null) return { status: "cancelled", history: initialMessages };
        historyEnabled = usable;
      }
      let request: ChatCompletionRequest;
      if (historyEnabled && input.conversation) {
        let contextLength: number | null = null;
        try {
          const detailsResult = await raceWithAbort(
            this.modelService.getModelDetails(settings.defaultModel),
            controller.signal,
          );
          if (!detailsResult.ok) {
            return { status: "cancelled", history: initialMessages };
          }
          contextLength = detailsResult.value?.contextLength ?? null;
        } catch {
          contextLength = null;
        }
        const builtResult = await raceWithAbort(
          buildConversationMessages(
            input,
            tweetParts,
            input.conversation,
            leadingSystemMessages,
            volatileSystemMessages,
            settings.webSearchEnabled ? this.webSearchEngine : undefined,
            contextLength,
            controller.signal,
          ),
          controller.signal,
        );
        if (!builtResult.ok) {
          return { status: "cancelled", history: initialMessages };
        }
        const built = builtResult.value;
        const usable = await this.isHistoryUsable(input, controller.signal);
        if (usable === null) return { status: "cancelled", history: initialMessages };
        historyEnabled = usable;
        request = historyEnabled
          ? buildChatRequest(settings.defaultModel, input, tweetParts, built)
          : buildWithoutHistory();
      } else {
        request = buildWithoutHistory();
      }
      const tracked = createTrackingUpdater(updater);
      const result = await this.runChatLoop(
        request,
        settings.webSearchEnabled,
        guildId,
        ctx,
        tracked.updater,
        controller.signal,
        requestId,
        historyEnabled && input.conversation ? input.conversation.openrouterSessionId : undefined,
      );

      if (
        result.status === "error" &&
        result.error instanceof BadRequestError &&
        (expansion?.imageParts.length ?? 0) > 0 &&
        !tracked.stagedNonEmpty
      ) {
        console.warn("[chatService] retrying after removing tweet images");
        if (historyEnabled) {
          const usable = await this.isHistoryUsable(input, controller.signal);
          if (usable === null) return { status: "cancelled", history: initialMessages };
          historyEnabled = usable;
        }
        const retryBase = historyEnabled ? request : buildWithoutHistory();
        const retryRequest = buildChatRequest(
          settings.defaultModel,
          input,
          expansion?.textParts ?? [],
          retryBase.messages.map((message) =>
            message.role === "user" && Array.isArray(message.content)
              ? {
                  ...message,
                  content: message.content.filter(
                    (part) => part.type !== "image_url" || !expansion?.imageParts.includes(part),
                  ),
                }
              : message,
          ),
        );
        const retryTracked = createTrackingUpdater(updater);
        const retryResult = await this.runChatLoop(
          retryRequest,
          settings.webSearchEnabled,
          guildId,
          ctx,
          retryTracked.updater,
          controller.signal,
          requestId,
          historyEnabled && input.conversation ? input.conversation.openrouterSessionId : undefined,
        );
        // The rejected attempt can still have been billed (a heartbeat may
        // carry usage before the error), so the footer must count both.
        const usage = addUsage(addUsage(undefined, result.usage), retryResult.usage);
        return usage ? { ...retryResult, usage } : retryResult;
      }
      return result;
    } finally {
      this.activeRequests.delete(requestId);
    }
  }

  /**
   * `null` when the request was cancelled. Without a validator, or when the
   * check fails, the snapshot is treated as unusable: sending history that
   * may have been deleted is worse than answering without it.
   */
  private async isHistoryUsable(
    input: ChatUserInput,
    signal: AbortSignal,
  ): Promise<boolean | null> {
    const { conversation, isConversationCurrent } = input;
    if (!conversation || !isConversationCurrent) return false;
    try {
      const result = await raceWithAbort(isConversationCurrent(conversation), signal);
      return result.ok ? result.value : null;
    } catch {
      return false;
    }
  }

  private runChatLoop(
    request: ChatCompletionRequest,
    webSearchEnabled: boolean,
    guildId: GuildId,
    ctx: ChatRequestContext,
    updater: IToolLoopUpdater,
    signal: AbortSignal,
    requestId: MessageId,
    sessionId?: string,
  ): Promise<ToolLoopResult> {
    return runToolLoop({
      llmClient: this.llmClient,
      model: request.model,
      messages: request.messages,
      ...(request.plugins && { plugins: request.plugins }),
      ...(sessionId && { requestFields: { session_id: sessionId } }),
      registry: this.toolRegistry,
      ...(webSearchEnabled && {
        serverTools: [buildWebSearchServerTool(this.webSearchEngine)],
      }),
      ctx: { guildId, channelId: ctx.channelId, userId: ctx.userId },
      updater,
      signal,
      requestId,
    });
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

function createTrackingUpdater(updater: IToolLoopUpdater): {
  updater: IToolLoopUpdater;
  stagedNonEmpty: boolean;
} {
  const state = { stagedNonEmpty: false };
  return {
    get stagedNonEmpty(): boolean {
      return state.stagedNonEmpty;
    },
    updater: {
      beginTurn: () => updater.beginTurn(),
      stageContent: (text: string) => {
        if (text.length > 0) state.stagedNonEmpty = true;
        return updater.stageContent(text);
      },
      commitTurn: (kind) => updater.commitTurn(kind),
      abortTurn: (reason) => updater.abortTurn(reason),
      beginToolBlock: (name) => updater.beginToolBlock(name),
      endToolBlock: (name, render) => updater.endToolBlock(name, render),
    },
  };
}
