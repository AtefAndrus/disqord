import type { ILLMClient } from "../llm/openrouter";
import type {
  ChatCompletionResponse,
  GuildId,
  MessageId,
  StreamChunk,
  StreamFinalResult,
} from "../types";
import type { ISettingsService } from "./settingsService";

export interface IChatService {
  generateResponse(
    guildId: GuildId,
    userMessage: string,
  ): Promise<{ text: string; metadata?: ChatCompletionResponse & { latency: number } }>;
  generateResponseStream(
    guildId: GuildId,
    userMessage: string,
    requestId: MessageId,
  ): AsyncGenerator<StreamChunk | StreamFinalResult, void, void>;
  cancelRequest(requestId: MessageId): boolean;
}

export class ChatService implements IChatService {
  private activeRequests = new Map<MessageId, AbortController>();

  constructor(
    private readonly llmClient: ILLMClient,
    private readonly settingsService: ISettingsService,
  ) {}

  async generateResponse(
    guildId: GuildId,
    userMessage: string,
  ): Promise<{ text: string; metadata?: ChatCompletionResponse & { latency: number } }> {
    const settings = await this.settingsService.getGuildSettings(guildId);

    const startTime = Date.now();
    const response = await this.llmClient.chat({
      model: settings.defaultModel,
      messages: [
        {
          role: "user",
          content: userMessage,
        },
      ],
    });
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
    userMessage: string,
    requestId: MessageId,
  ): AsyncGenerator<StreamChunk | StreamFinalResult, void, void> {
    const settings = await this.settingsService.getGuildSettings(guildId);
    const controller = new AbortController();
    this.activeRequests.set(requestId, controller);

    try {
      const stream = this.llmClient.chatStream(
        {
          model: settings.defaultModel,
          messages: [
            {
              role: "user",
              content: userMessage,
            },
          ],
        },
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
