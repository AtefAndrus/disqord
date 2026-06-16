import type { ILLMClient } from "../llm/openrouter";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
  ChatMessageContent,
  GuildId,
  MessageId,
  StreamChunk,
  StreamFinalResult,
} from "../types";
import { PDF_PARSER_PLUGIN } from "./attachmentParser";
import type { ISettingsService } from "./settingsService";

export interface ChatUserInput {
  text: string;
  parts?: ChatMessageContent[];
}

export interface IChatService {
  generateResponse(
    guildId: GuildId,
    input: ChatUserInput,
  ): Promise<{ text: string; metadata?: ChatCompletionResponse & { latency: number } }>;
  generateResponseStream(
    guildId: GuildId,
    input: ChatUserInput,
    requestId: MessageId,
  ): AsyncGenerator<StreamChunk | StreamFinalResult, void, void>;
  cancelRequest(requestId: MessageId): boolean;
}

function pickDefaultPrompt(parts: ChatMessageContent[]): string {
  const hasImage = parts.some((p) => p.type === "image_url");
  const hasFile = parts.some((p) => p.type === "file");
  if (hasImage && hasFile) return "添付ファイルについて説明してください。";
  if (hasImage) return "添付された画像について説明してください。";
  return "添付された文書を要約してください。";
}

function buildChatRequest(model: string, input: ChatUserInput): ChatCompletionRequest {
  const parts = input.parts ?? [];
  const hasFile = parts.some((p) => p.type === "file");

  let content: ChatMessage["content"];
  if (parts.length === 0) {
    content = input.text;
  } else {
    // OpenRouter / 一部モデルは text part を含まない content 配列で接続を切るため、
    // text が空の場合は default prompt を補う
    const text = input.text.length > 0 ? input.text : pickDefaultPrompt(parts);
    content = [{ type: "text", text }, ...parts];
  }

  return {
    model,
    messages: [{ role: "user", content }],
    ...(hasFile && { plugins: [PDF_PARSER_PLUGIN] }),
  };
}

export class ChatService implements IChatService {
  private activeRequests = new Map<MessageId, AbortController>();

  constructor(
    private readonly llmClient: ILLMClient,
    private readonly settingsService: ISettingsService,
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

  async *generateResponseStream(
    guildId: GuildId,
    input: ChatUserInput,
    requestId: MessageId,
  ): AsyncGenerator<StreamChunk | StreamFinalResult, void, void> {
    const settings = await this.settingsService.getGuildSettings(guildId);
    const controller = new AbortController();
    this.activeRequests.set(requestId, controller);

    try {
      const stream = this.llmClient.chatStream(
        buildChatRequest(settings.defaultModel, input),
        controller.signal,
      );

      for await (const chunk of stream) {
        yield chunk;
      }
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
