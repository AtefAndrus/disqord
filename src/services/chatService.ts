import type { ILLMClient } from "../llm/openrouter";
import type { ChatCompletionResponse, GuildId } from "../types";
import type { ISettingsService } from "./settingsService";

export interface IChatService {
  generateResponse(
    guildId: GuildId,
    userMessage: string,
  ): Promise<{ text: string; metadata?: ChatCompletionResponse & { latency: number } }>;
}

export class ChatService implements IChatService {
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
}
