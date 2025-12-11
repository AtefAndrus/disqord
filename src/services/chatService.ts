import type { ILLMClient } from "../llm/openrouter";
import type { GuildId } from "../types";
import type { ISettingsService } from "./settingsService";

export interface IChatService {
  generateResponse(guildId: GuildId, userMessage: string): Promise<string>;
}

export class ChatService implements IChatService {
  constructor(
    private readonly llmClient: ILLMClient,
    private readonly settingsService: ISettingsService,
  ) {}

  async generateResponse(guildId: GuildId, userMessage: string): Promise<string> {
    const settings = await this.settingsService.getGuildSettings(guildId);
    const response = await this.llmClient.chat({
      model: settings.defaultModel,
      messages: [
        {
          role: "user",
          content: userMessage,
        },
      ],
    });

    return response.choices[0]?.message.content ?? "";
  }
}
