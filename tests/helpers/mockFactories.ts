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
        defaultModel: settings.defaultModel ?? "test-model:fixture",
        freeModelsOnly: settings.freeModelsOnly ?? false,
        releaseChannelId: settings.releaseChannelId ?? null,
        showLlmDetails: settings.showLlmDetails ?? true,
        autoReplyChannels: settings.autoReplyChannels ?? [],
        createdAt: settings.createdAt ?? new Date().toISOString(),
        updatedAt: settings.updatedAt ?? new Date().toISOString(),
      }),
    ),
    updateShowLlmDetails: mock(() => Promise.resolve()),
    updateAutoReplyChannels: mock(() => Promise.resolve()),
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
    chatStream: mock(async function* () {
      yield { content: "Mock ", done: false as const };
      yield { content: "response", done: false as const };
      yield {
        done: true as const,
        fullText: "Mock response",
        usage: undefined,
        model: undefined,
        provider: undefined,
      };
    }),
    listModels: mock(() => Promise.resolve(["model-1", "model-2"])),
    listModelsWithPricing: mock(() =>
      Promise.resolve([
        {
          id: "model-1",
          name: "Model 1",
          created: 1640000000,
          contextLength: 4096,
          pricing: { prompt: "0", completion: "0" },
        },
        {
          id: "model-2",
          name: "Model 2",
          created: 1650000000,
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
        defaultModel: "test-model:fixture",
        freeModelsOnly: false,
        releaseChannelId: null,
        showLlmDetails: true,
        autoReplyChannels: [],
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
        showLlmDetails: true,
        autoReplyChannels: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    ),
    setFreeModelsOnly: mock((guildId: string, freeModelsOnly: boolean) =>
      Promise.resolve({
        guildId,
        defaultModel: "test-model:fixture",
        freeModelsOnly,
        releaseChannelId: null,
        showLlmDetails: true,
        autoReplyChannels: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    ),
    setReleaseChannel: mock((guildId: string, channelId: string | null) =>
      Promise.resolve({
        guildId,
        defaultModel: "test-model:fixture",
        freeModelsOnly: false,
        releaseChannelId: channelId,
        showLlmDetails: true,
        autoReplyChannels: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    ),
    setShowLlmDetails: mock((_guildId: string, _showLlmDetails: boolean) => Promise.resolve()),
    toggleShowLlmDetails: mock((_guildId: string) => Promise.resolve(true)),
    getGuildsWithReleaseChannel: mock(() => Promise.resolve([])),
    addAutoReplyChannel: mock((_guildId: string, _channelId: string) => Promise.resolve()),
    removeAutoReplyChannel: mock((_guildId: string, _channelId: string) => Promise.resolve(true)),
  };
}

export function createMockGuildSettings(overrides?: Partial<GuildSettings>): GuildSettings {
  return {
    guildId: "test-guild-id",
    defaultModel: "test-model:fixture",
    freeModelsOnly: false,
    releaseChannelId: null,
    showLlmDetails: true,
    autoReplyChannels: [],
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
    ...overrides,
  };
}
