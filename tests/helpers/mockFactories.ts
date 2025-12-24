import { mock } from "bun:test";
import type { IGuildSettingsRepository } from "../../src/db/repositories/guildSettings";
import type { ILLMClient } from "../../src/llm/openrouter";
import type { ISettingsService } from "../../src/services/settingsService";
import type { ChatCompletionResponse, GuildSettings } from "../../src/types";

export function createMockGuildSettingsRepository(): IGuildSettingsRepository {
  return {
    findByGuildId: mock(() => Promise.resolve(null)),
    findAllWithReleaseChannel: mock(() => Promise.resolve([])),
    upsert: mock((guildId: string, settings: Partial<GuildSettings>) =>
      Promise.resolve({
        guildId,
        defaultModel: settings.defaultModel ?? "google/gemini-2.0-flash-exp:free",
        freeModelsOnly: settings.freeModelsOnly ?? false,
        releaseChannelId: settings.releaseChannelId ?? null,
        createdAt: settings.createdAt ?? new Date().toISOString(),
        updatedAt: settings.updatedAt ?? new Date().toISOString(),
      }),
    ),
    delete: mock(() => Promise.resolve(true)),
  };
}

export function createMockLLMClient(): ILLMClient {
  return {
    chat: mock(() =>
      Promise.resolve({
        id: "mock-id",
        choices: [
          {
            message: {
              role: "assistant" as const,
              content: "Mock response",
            },
          },
        ],
      } satisfies ChatCompletionResponse),
    ),
    listModels: mock(() => Promise.resolve(["model-1", "model-2"])),
    listModelsWithPricing: mock(() =>
      Promise.resolve([
        {
          id: "model-1",
          name: "Model 1",
          contextLength: 4096,
          pricing: { prompt: "0", completion: "0" },
        },
        {
          id: "model-2",
          name: "Model 2",
          contextLength: 8192,
          pricing: { prompt: "0.001", completion: "0.002" },
        },
      ]),
    ),
    getCredits: mock(() => Promise.resolve({ remaining: 100 })),
    isRateLimited: mock(() => false),
  };
}

export function createMockSettingsService(): ISettingsService {
  return {
    getGuildSettings: mock((guildId: string) =>
      Promise.resolve({
        guildId,
        defaultModel: "google/gemini-2.0-flash-exp:free",
        freeModelsOnly: false,
        releaseChannelId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    ),
    setGuildModel: mock((guildId: string, model: string) =>
      Promise.resolve({
        guildId,
        defaultModel: model,
        freeModelsOnly: false,
        releaseChannelId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    ),
    setFreeModelsOnly: mock((guildId: string, freeModelsOnly: boolean) =>
      Promise.resolve({
        guildId,
        defaultModel: "google/gemini-2.0-flash-exp:free",
        freeModelsOnly,
        releaseChannelId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    ),
    setReleaseChannel: mock((guildId: string, channelId: string | null) =>
      Promise.resolve({
        guildId,
        defaultModel: "google/gemini-2.0-flash-exp:free",
        freeModelsOnly: false,
        releaseChannelId: channelId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    ),
    getGuildsWithReleaseChannel: mock(() => Promise.resolve([])),
  };
}

export function createMockGuildSettings(overrides?: Partial<GuildSettings>): GuildSettings {
  return {
    guildId: "test-guild-id",
    defaultModel: "google/gemini-2.0-flash-exp:free",
    freeModelsOnly: false,
    releaseChannelId: null,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
    ...overrides,
  };
}
