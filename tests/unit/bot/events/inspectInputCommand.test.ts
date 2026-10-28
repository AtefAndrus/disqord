import { describe, expect, mock, test } from "bun:test";
import {
  ApplicationCommandType,
  type AttachmentBuilder,
  ChannelType,
  ComponentType,
  type ContainerBuilder,
  type MessageContextMenuCommandInteraction,
  MessageFlags,
  PermissionFlagsBits,
  PermissionsBitField,
} from "discord.js";
import { inspectInputCommand } from "../../../../src/bot/commands/inspectInput";
import {
  createInspectInputHandler,
  REQUEST_OVERHEAD_BYTES,
} from "../../../../src/bot/events/inspectInputCommand";
import type { ReplyRecord } from "../../../../src/db/repositories/replyRecord";
import type { GenerationLookup } from "../../../../src/llm/generationLog";
import type { IReplyRecordService } from "../../../../src/services/replyRecordService";
import { createMockGuildSettings, createMockSettingsService } from "../../../helpers/mockFactories";

const RECORD: ReplyRecord = {
  triggerMsgId: "trigger-1",
  guildId: "guild-1",
  channelId: "channel-1",
  status: "completed",
  pageCount: 1,
  finalizedAt: 1,
  createdAt: 1,
};
const METADATA: GenerationLookup = {
  ok: true,
  data: {
    model: "example/model",
    provider_name: "provider",
    tokens_prompt: 123,
    tokens_completion: 45,
    total_cost: 0.001,
  },
};
const CONTENT: GenerationLookup = {
  ok: true,
  data: {
    input: [{ role: "user", content: "[OR_REDACTED]" }],
    output: { completion: "answer", reasoning: "thought" },
    error: null,
  },
};

interface HarnessOptions {
  manageGuild?: boolean;
  adminRole?: boolean;
  readHistory?: boolean;
  viewChannel?: boolean;
  connect?: boolean;
  type?: ChannelType;
  guildId?: string | null;
  record?: ReplyRecord | null;
  fallback?: ReplyRecord | null;
  targetAuthor?: string;
  reference?: string;
  ids?: string[];
  sizeLimit?: number;
  timeoutMs?: number;
  generation?: (id: string, signal?: AbortSignal) => Promise<GenerationLookup>;
  content?: (id: string, signal?: AbortSignal) => Promise<GenerationLookup>;
  privateMember?: boolean;
  /** The channel is missing from the cache and must be fetched; `"fails"` makes the fetch reject. */
  uncachedChannel?: true | "fails";
  followUp?: () => Promise<unknown>;
  deferDelayMs?: number;
}

interface Payload {
  flags: number;
  components: ContainerBuilder[];
  files: AttachmentBuilder[];
  allowedMentions: { parse: [] };
}

interface Harness {
  run: () => Promise<void>;
  editReply: ReturnType<typeof mock>;
  followUp: ReturnType<typeof mock>;
  deferReply: ReturnType<typeof mock>;
  findByPage: ReturnType<typeof mock>;
  findByTrigger: ReturnType<typeof mock>;
  generation: ReturnType<typeof mock>;
  content: ReturnType<typeof mock>;
  threadFetch: ReturnType<typeof mock>;
  channelFetch: ReturnType<typeof mock>;
}

function harness(options: HarnessOptions = {}): Harness {
  const deferReply = mock(
    () => new Promise<void>((resolve) => setTimeout(resolve, options.deferDelayMs ?? 0)),
  );
  const editReply = mock(() => Promise.resolve());
  const followUp = mock(options.followUp ?? (() => Promise.resolve()));
  const threadFetch = mock(() =>
    options.privateMember === false ? Promise.reject({ status: 404 }) : Promise.resolve({}),
  );
  const generation = mock(options.generation ?? (async () => METADATA));
  const content = mock(options.content ?? (async () => CONTENT));
  const findByPage = mock(() => (options.record === undefined ? RECORD : options.record));
  const findByTrigger = mock(() => options.fallback ?? null);
  const records = {
    findByPage,
    findByTrigger,
    listGenerationIds: mock(() => options.ids ?? ["gen-1"]),
  } as unknown as IReplyRecordService;
  const settings = createMockSettingsService();
  settings.getGuildSettings = mock(async () =>
    createMockGuildSettings({ adminRoleId: options.adminRole ? "admin-role" : null }),
  );
  const channel = {
    type: options.type ?? ChannelType.GuildText,
    isDMBased: (): boolean => false,
    isTextBased: (): boolean => true,
    permissionsFor: (subject: { id?: string }): { has: (permission: bigint) => boolean } => ({
      has: (permission: bigint): boolean =>
        subject.id === "bot" ||
        (permission === PermissionFlagsBits.ViewChannel
          ? options.viewChannel !== false
          : permission === PermissionFlagsBits.ReadMessageHistory
            ? options.readHistory !== false
            : permission === PermissionFlagsBits.Connect
              ? options.connect !== false
              : false),
    }),
    members: { fetch: threadFetch },
  };
  const channelFetch = mock(() =>
    options.uncachedChannel === "fails"
      ? Promise.reject(new Error("Missing Access"))
      : Promise.resolve(channel),
  );
  const interaction = {
    guildId: options.guildId === undefined ? "guild-1" : options.guildId,
    channelId: "channel-1",
    user: { id: "requester" },
    client: { user: { id: "bot" }, channels: { fetch: channelFetch } },
    member: { roles: options.adminRole ? ["admin-role"] : [] },
    memberPermissions: new PermissionsBitField(
      options.manageGuild === false ? 0n : PermissionFlagsBits.ManageGuild,
    ),
    channel: options.uncachedChannel ? null : channel,
    targetMessage: {
      id: "page-1",
      author: { id: options.targetAuthor ?? "bot" },
      reference: options.reference ? { messageId: options.reference } : null,
    },
    // `sizeLimit` is the room left for attachments after the reserved request overhead.
    attachmentSizeLimit: (options.sizeLimit ?? 10_000_000) + REQUEST_OVERHEAD_BYTES,
    deferReply,
    editReply,
    followUp,
  } as unknown as MessageContextMenuCommandInteraction;
  const handler = createInspectInputHandler(
    settings,
    records,
    { getGeneration: generation, getGenerationContent: content },
    options.timeoutMs,
  );
  return {
    run: () => handler(interaction),
    deferReply,
    editReply,
    followUp,
    findByPage,
    findByTrigger,
    generation,
    content,
    threadFetch,
    channelFetch,
  };
}

function payload(call: ReturnType<typeof mock>, index = 0): Payload {
  return call.mock.calls[index]?.[0] as Payload;
}

function textOf(call: ReturnType<typeof mock>): string {
  return payload(call)
    .components.flatMap((container) =>
      container
        .toJSON()
        .components.flatMap((component) =>
          component.type === ComponentType.TextDisplay ? [component.content] : [],
        ),
    )
    .join("\n");
}

function fileJson(file: AttachmentBuilder): {
  triggerMessageId: string;
  generations: { id: string; generation: GenerationLookup; content: GenerationLookup }[];
} {
  if (!Buffer.isBuffer(file.attachment)) throw new Error("Expected an in-memory JSON attachment");
  return JSON.parse(file.attachment.toString("utf8"));
}

describe("LLM 入力を見る", () => {
  test("registers a message command restricted to ManageGuild by default", () => {
    expect(inspectInputCommand.toJSON()).toMatchObject({
      name: "LLM 入力を見る",
      type: ApplicationCommandType.Message,
      default_member_permissions: String(PermissionFlagsBits.ManageGuild),
    });
  });

  test("defers ephemerally and returns raw input, output, error, metadata and File components", async () => {
    const h = harness();
    await h.run();
    expect(h.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    const result = payload(h.editReply);
    expect(result.flags).toBe(MessageFlags.IsComponentsV2);
    expect(result.allowedMentions).toEqual({ parse: [] });
    expect(result.files[0].name).toBe("llm-input-trigger-1.json");
    expect(fileJson(result.files[0])).toEqual({
      triggerMessageId: "trigger-1",
      generations: [{ id: "gen-1", generation: METADATA, content: CONTENT }],
    });
    expect(result.components[0].toJSON().components).toContainEqual({
      type: ComponentType.File,
      file: { url: "attachment://llm-input-trigger-1.json" },
    });
    expect(textOf(h.editReply)).toContain("123");
    expect(textOf(h.editReply)).toContain("45");
    expect(textOf(h.editReply)).toContain("0.001");
  });

  test("rejects non-administrators before looking up records or content", async () => {
    const h = harness({ manageGuild: false });
    await h.run();
    expect(textOf(h.editReply)).toContain("管理");
    expect(h.findByPage).not.toHaveBeenCalled();
    expect(h.generation).not.toHaveBeenCalled();
  });

  test("accepts the configured administrator role", async () => {
    const h = harness({ manageGuild: false, adminRole: true });
    await h.run();
    expect(payload(h.editReply).files).toHaveLength(1);
  });

  for (const denied of [
    { readHistory: false },
    { viewChannel: false },
    { type: ChannelType.GuildVoice, connect: false },
    { type: ChannelType.GuildStageVoice, connect: false },
    { type: ChannelType.PrivateThread, privateMember: false },
  ]) {
    test(`rejects an administrator without channel access: ${JSON.stringify(denied)}`, async () => {
      const h = harness(denied);
      await h.run();
      expect(textOf(h.editReply)).toContain("履歴を読む権限");
      expect(h.generation).not.toHaveBeenCalled();
    });
  }

  test("rejects direct messages", async () => {
    const h = harness({ guildId: null });
    await h.run();
    expect(textOf(h.editReply)).toContain("サーバー内");
    expect(h.generation).not.toHaveBeenCalled();
  });

  test("fetches a channel missing from the cache, such as an archived thread", async () => {
    const h = harness({ uncachedChannel: true });
    await h.run();
    expect(h.channelFetch).toHaveBeenCalledWith("channel-1");
    expect(payload(h.editReply).files).toHaveLength(1);
  });

  test("reports an unreadable channel instead of calling it a direct message", async () => {
    const h = harness({ uncachedChannel: "fails" });
    await h.run();
    expect(textOf(h.editReply)).toContain("チャンネルの情報を取得できませんでした");
    expect(textOf(h.editReply)).not.toContain("サーバー内");
    expect(h.generation).not.toHaveBeenCalled();
  });

  test("finds an error display by the referenced trigger", async () => {
    const h = harness({ record: null, fallback: RECORD, reference: "trigger-1" });
    await h.run();
    expect(h.findByPage).toHaveBeenCalledWith("page-1");
    expect(h.findByTrigger).toHaveBeenCalledWith("trigger-1");
    expect(payload(h.editReply).files).toHaveLength(1);
  });

  test("does not use another author's reply to find a trigger", async () => {
    const h = harness({
      record: null,
      fallback: RECORD,
      reference: "trigger-1",
      targetAuthor: "other",
    });
    await h.run();
    expect(h.findByTrigger).not.toHaveBeenCalled();
    expect(textOf(h.editReply)).toContain("記録がありません");
  });

  test("prefers the page record to the referenced trigger", async () => {
    const h = harness({ reference: "other-trigger" });
    await h.run();
    expect(h.findByTrigger).not.toHaveBeenCalled();
  });

  for (const missing of [
    { record: null },
    { ids: [] },
    { record: { ...RECORD, channelId: "other-channel" } },
  ]) {
    test(`returns no record for ${JSON.stringify(missing)}`, async () => {
      const h = harness(missing);
      await h.run();
      expect(textOf(h.editReply)).toContain("記録がありません");
      expect(h.generation).not.toHaveBeenCalled();
    });
  }

  test("keeps the successful endpoint and continues after the other endpoint fails", async () => {
    const failure: GenerationLookup = { ok: false, status: 403, reason: "forbidden" };
    const h = harness({ ids: ["gen-1", "gen-2"], content: async () => failure });
    await h.run();
    expect(fileJson(payload(h.editReply).files[0]).generations).toEqual(
      ["gen-1", "gen-2"].map((id) => ({ id, generation: METADATA, content: failure })),
    );
    expect(textOf(h.editReply)).toContain("403 forbidden");
  });

  test("keeps content when metadata fails and records rejected client calls", async () => {
    const h = harness({
      generation: async () => {
        throw new Error("offline");
      },
    });
    await h.run();
    const log = fileJson(payload(h.editReply).files[0]).generations[0];
    expect(log.generation).toEqual({ ok: false, reason: "offline" });
    expect(log.content).toEqual(CONTENT);
  });

  test("fetches both endpoints concurrently but generations sequentially", async () => {
    let release: (value: GenerationLookup) => void = () => {};
    const pending = new Promise<GenerationLookup>((resolve) => {
      release = resolve;
    });
    const seen: string[] = [];
    const h = harness({
      ids: ["gen-1", "gen-2"],
      generation: async (id) => {
        seen.push(`metadata:${id}`);
        return id === "gen-1" ? pending : METADATA;
      },
      content: async (id) => {
        seen.push(`content:${id}`);
        return CONTENT;
      },
    });
    const run = h.run();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(seen).toEqual(["metadata:gen-1", "content:gen-1"]);
    release(METADATA);
    await run;
    expect(seen).toEqual(["metadata:gen-1", "content:gen-1", "metadata:gen-2", "content:gen-2"]);
  });

  test("starts the deadline once the reply is deferred", async () => {
    const h = harness({
      deferDelayMs: 400,
      timeoutMs: 200,
      content: () => new Promise((resolve) => setTimeout(() => resolve(CONTENT), 5)),
    });
    await h.run();
    expect(fileJson(payload(h.editReply).files[0]).generations[0].content).toEqual(CONTENT);
  });

  test("times out unfinished endpoints and remaining generations while keeping completed data", async () => {
    let signal: AbortSignal | undefined;
    const h = harness({
      timeoutMs: 20,
      ids: ["gen-1", "gen-2", "gen-3"],
      content: async (id, requestSignal) => {
        signal = requestSignal;
        return id === "gen-1" ? CONTENT : new Promise<GenerationLookup>(() => {});
      },
    });
    await h.run();
    const logs = fileJson(payload(h.editReply).files[0]).generations;
    expect(logs[0].content).toEqual(CONTENT);
    expect(logs[1].generation).toEqual(METADATA);
    expect(logs[1].content).toEqual({ ok: false, reason: "時間切れ" });
    expect(logs[2]).toEqual({
      id: "gen-3",
      generation: { ok: false, reason: "時間切れ" },
      content: { ok: false, reason: "時間切れ" },
    });
    expect(signal?.aborted).toBe(true);
    expect(h.generation).toHaveBeenCalledTimes(2);
    expect(textOf(h.editReply)).toContain("/generation/content: 時間切れ");
  });

  test("keeps every message's attachments within the size limit", async () => {
    const ids = Array.from({ length: 5 }, (_, index) => `gen-${index}`);
    const h = harness({ ids, sizeLimit: 1100 });
    await h.run();
    const parts = [
      payload(h.editReply),
      ...h.followUp.mock.calls.map((_, i) => payload(h.followUp, i)),
    ];
    const bytes = (part: Payload): number =>
      part.files.reduce(
        (sum, file) => sum + (Buffer.isBuffer(file.attachment) ? file.attachment.byteLength : 0),
        0,
      );
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(bytes(part)).toBeLessThanOrEqual(1100);
    expect(
      parts.flatMap((part) => part.files.flatMap((file) => fileJson(file).generations)),
    ).toHaveLength(ids.length);
  });

  test("keeps the delivered result when a follow-up fails", async () => {
    const ids = Array.from({ length: 5 }, (_, index) => `gen-${index}`);
    const followUps: unknown[] = [];
    const h = harness({
      ids,
      sizeLimit: 1100,
      followUp: async () => {
        followUps.push(undefined);
        if (followUps.length === 1)
          throw Object.assign(new Error("Request entity too large"), { code: 40005 });
      },
    });
    await h.run();
    expect(h.editReply).toHaveBeenCalledTimes(1);
    expect(payload(h.editReply).files.length).toBeGreaterThan(0);
    const last = h.followUp.mock.calls.length - 1;
    expect(payload(h.followUp, last).files).toHaveLength(0);
    expect(payload(h.followUp, last).flags).toBe(
      MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    );
    // The first follow-up failed, so every file after the edited reply is reported as missing.
    const failedBatch = payload(h.followUp, 0).files.map((file) => file.name ?? "");
    const notice = textOf({ mock: { calls: [h.followUp.mock.calls[last]] } } as never);
    expect(notice).toContain("届いていないファイル");
    for (const name of failedBatch) expect(notice).toContain(name);
    expect(notice).not.toContain("取得中");
  });

  test("tells a reply still being generated apart from a missing record", async () => {
    const h = harness({ record: { ...RECORD, status: "pending" } });
    await h.run();
    expect(textOf(h.editReply)).toContain("生成中");
    expect(h.generation).not.toHaveBeenCalled();
  });

  for (const allowed of [
    { type: ChannelType.GuildText, connect: false },
    { type: ChannelType.GuildVoice, connect: true },
  ]) {
    test(`requires Connect only in voice channels: ${JSON.stringify(allowed)}`, async () => {
      const h = harness(allowed);
      await h.run();
      expect(payload(h.editReply).files).toHaveLength(1);
    });
  }

  test("splits by generation and uses ephemeral follow-ups after ten attachments", async () => {
    const ids = Array.from({ length: 23 }, (_, index) => `gen-${index}`);
    // Size the limit from one generation's file so ten files fit in a message but the whole JSON does not.
    const probe = harness({ ids, sizeLimit: 1100 });
    await probe.run();
    const fileSize = Math.max(
      ...[
        payload(probe.editReply),
        ...probe.followUp.mock.calls.map((_, i) => payload(probe.followUp, i)),
      ]
        .flatMap((part) => part.files)
        .map((file) => (Buffer.isBuffer(file.attachment) ? file.attachment.byteLength : 0)),
      0,
    );
    const h = harness({ ids, sizeLimit: 12 * fileSize });
    await h.run();
    expect(payload(h.editReply).files).toHaveLength(10);
    expect(h.followUp).toHaveBeenCalledTimes(2);
    const parts = [payload(h.editReply), payload(h.followUp), payload(h.followUp, 1)];
    expect(parts.map((part) => part.files.length)).toEqual([10, 10, 3]);
    expect(
      parts
        .slice(1)
        .every((part) => part.flags === (MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral)),
    ).toBe(true);
    const files = parts.flatMap((part) => part.files);
    expect(files.map((file) => file.name)).toEqual(
      ids.map((_, index) => `llm-input-trigger-1-${index + 1}.json`),
    );
    expect(files.flatMap((file) => fileJson(file).generations.map((log) => log.id))).toEqual(ids);
    for (const part of parts) {
      expect(
        part.components[0]
          .toJSON()
          .components.filter((component) => component.type === ComponentType.File),
      ).toHaveLength(part.files.length);
    }
    expect(textOf(h.editReply).length).toBeLessThanOrEqual(4000);
  });

  test("collapses summary rows above 4000 characters while retaining every JSON entry", async () => {
    const ids = Array.from({ length: 100 }, (_, index) => `gen-${index}`);
    const h = harness({ ids });
    await h.run();
    expect(textOf(h.editReply).length).toBeLessThanOrEqual(4000);
    expect(textOf(h.editReply)).toContain("件は JSON を参照");
    expect(fileJson(payload(h.editReply).files[0]).generations.map((log) => log.id)).toEqual(ids);
  });

  test("omits an oversized generation without truncating the other generation", async () => {
    const h = harness({
      ids: ["gen-1", "gen-2"],
      sizeLimit: 1100,
      content: async (id) =>
        id === "gen-1" ? { ok: true, data: { input: "あ".repeat(2000) } } : CONTENT,
    });
    await h.run();
    expect(payload(h.editReply).files).toHaveLength(1);
    expect(payload(h.editReply).files[0].name).toBe("llm-input-trigger-1-2.json");
    expect(fileJson(payload(h.editReply).files[0]).generations[0].content).toEqual(CONTENT);
    expect(textOf(h.editReply)).toContain("ファイルを省略");
    expect(textOf(h.editReply)).toContain("bytes");
  });

  test("shows the logging hint only when all content lookups return 404", async () => {
    const h = harness({
      ids: ["gen-1", "gen-2"],
      content: async () => ({ ok: false, status: 404, reason: "not found" }),
    });
    await h.run();
    expect(textOf(h.editReply)).toContain(
      "少し待ってから再実行し、それでも無ければ OpenRouter の入出力ログの設定を確かめてください",
    );
    const mixed = harness({
      ids: ["gen-1", "gen-2"],
      content: async (id) =>
        id === "gen-1" ? { ok: false, status: 404, reason: "not found" } : CONTENT,
    });
    await mixed.run();
    expect(textOf(mixed.editReply)).not.toContain("少し待ってから");
  });
});
