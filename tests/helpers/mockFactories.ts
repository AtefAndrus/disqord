import { mock } from "bun:test";
import type { ILLMClient } from "../../src/llm/openrouter";
import type { ISettingsService, ModelCheck } from "../../src/services/settingsService";
import type { ITweetService } from "../../src/services/tweetService";
import type { ChatCompletionResponse, GuildSettings } from "../../src/types";

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
        finishReason: "stop" as const,
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
          inputModalities: ["text"],
          outputModalities: ["text"],
        },
        {
          id: "model-2",
          name: "Model 2",
          created: 1650000000,
          contextLength: 8192,
          pricing: { prompt: "0.001", completion: "0.002" },
          inputModalities: ["text"],
          outputModalities: ["text"],
        },
      ]),
    ),
    getCredits: mock(() => Promise.resolve({ remaining: 100 })),
    isRateLimited: mock(() => false),
  };
}

export function createMockSettingsService(): ISettingsService {
  const settings = (guildId: string, overrides: Partial<GuildSettings> = {}): GuildSettings =>
    createMockGuildSettings({ guildId, ...overrides });
  return {
    getGuildSettings: mock((guildId: string) => Promise.resolve(settings(guildId))),
    setReleaseAnnounceChannelId: mock((guildId: string, releaseAnnounceChannelId: string | null) =>
      Promise.resolve(settings(guildId, { releaseAnnounceChannelId })),
    ),
    setGuildModel: mock((guildId: string, check: ModelCheck) =>
      Promise.resolve(settings(guildId, { defaultModel: check.model })),
    ),
    setFreeModelsOnly: mock((guildId: string, freeModelsOnly: boolean, _check?: ModelCheck) =>
      Promise.resolve(settings(guildId, { freeModelsOnly })),
    ),
    setShowLlmDetails: mock((_guildId: string, _showLlmDetails: boolean) => Promise.resolve()),
    addAllowedChannel: mock(() => Promise.resolve()),
    removeAllowedChannel: mock(() => Promise.resolve(true)),
    setAdminRoleId: mock((guildId: string, adminRoleId: string | null) =>
      Promise.resolve(settings(guildId, { adminRoleId })),
    ),
    addAutoReplyChannel: mock((_guildId: string, _channelId: string) => Promise.resolve()),
    removeAutoReplyChannel: mock((_guildId: string, _channelId: string) => Promise.resolve(true)),
    setWebSearchEnabled: mock((guildId: string, webSearchEnabled: boolean) =>
      Promise.resolve(settings(guildId, { webSearchEnabled })),
    ),
    setReasoningDisplayEnabled: mock((guildId: string, reasoningDisplayEnabled: boolean) =>
      Promise.resolve(settings(guildId, { reasoningDisplayEnabled })),
    ),
    setTwitterExpandEnabled: mock((guildId: string, twitterExpandEnabled: boolean) =>
      Promise.resolve(settings(guildId, { twitterExpandEnabled })),
    ),
    setHistoryEnabled: mock((guildId: string, historyEnabled: boolean) =>
      Promise.resolve(settings(guildId, { historyEnabled })),
    ),
  };
}

export function createMockTweetService(): ITweetService {
  return {
    extractTweetIds: mock(() => []),
    expandTweets: mock(() =>
      Promise.resolve({ status: "none" as const, parts: [], textParts: [], imageParts: [] }),
    ),
  };
}

export function createMockGuildSettings(overrides?: Partial<GuildSettings>): GuildSettings {
  return {
    guildId: "test-guild-id",
    adminRoleId: null,
    releaseAnnounceChannelId: null,
    allowedChannels: null,
    settingsVersion: 0,
    updatedBy: null,
    defaultModel: "test-model:fixture",
    freeModelsOnly: false,
    showLlmDetails: true,
    autoReplyChannels: [],
    webSearchEnabled: false,
    reasoningDisplayEnabled: false,
    twitterExpandEnabled: true,
    historyEnabled: false,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
    ...overrides,
  };
}
