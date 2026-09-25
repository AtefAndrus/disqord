import { describe, expect, mock, test } from "bun:test";
import {
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type ContainerBuilder,
  MessageFlags,
} from "discord.js";
import packageJson from "../../../../package.json";
import { createCommandHandlers } from "../../../../src/bot/commands/handlers";
import type { IModelService } from "../../../../src/services/modelService";
import { parseChangelog, type ReleaseNotes } from "../../../../src/services/releaseNotes";
import { createMockLLMClient, createMockSettingsService } from "../../../helpers/mockFactories";

function changelogWith(versions: readonly string[], body = "- change (#1)"): string {
  return versions.map((version) => `## [${version}] - 2026-01-01\n\n${body}\n`).join("\n");
}

function handlersFor(notes: ReleaseNotes | undefined): ReturnType<typeof createCommandHandlers> {
  return createCommandHandlers(
    createMockLLMClient(),
    createMockSettingsService(),
    {} as IModelService,
    "perplexity",
    notes,
  );
}

function commandInteraction(version: string | null): {
  interaction: ChatInputCommandInteraction;
  reply: ReturnType<typeof mock>;
  followUp: ReturnType<typeof mock>;
} {
  const reply = mock(() => Promise.resolve());
  const followUp = mock(() => Promise.resolve());
  const interaction = {
    options: { getString: mock(() => version) },
    reply,
    followUp,
  } as unknown as ChatInputCommandInteraction;
  return { interaction, reply, followUp };
}

function replyOf(fn: ReturnType<typeof mock>, index = 0): { text: string; flags: number } {
  const payload = fn.mock.calls[index]?.[0] as
    | { components: ContainerBuilder[]; flags: number }
    | undefined;
  if (!payload) throw new Error("no reply");
  const text = (payload.components[0]?.components ?? [])
    .map((c) => (c.toJSON() as { content?: string }).content ?? "")
    .join("\n");
  return { text, flags: payload.flags };
}

describe("/release-note", () => {
  test("shows the running version when no version is given", async () => {
    const notes = parseChangelog(changelogWith([packageJson.version, "0.0.1"]));
    const { interaction, reply } = commandInteraction(null);
    await handlersFor(notes).releaseNote(interaction);
    const { text, flags } = replyOf(reply);
    expect(text).toContain(`## DisQord v${packageJson.version} の変更点`);
    expect(flags & MessageFlags.Ephemeral).toBe(0);
  });

  test("accepts a leading v and sends the remaining pages as follow-ups", async () => {
    const long = Array.from(
      { length: 150 },
      (_, i) => `- 長い項目 ${i} の説明文。会話履歴を Discord から読む変更 (#${i})`,
    ).join("\n");
    const notes = parseChangelog(changelogWith(["1.5.0"], long));
    const { interaction, reply, followUp } = commandInteraction("v1.5.0");
    await handlersFor(notes).releaseNote(interaction);
    expect(reply).toHaveBeenCalledTimes(1);
    expect(followUp.mock.calls.length).toBeGreaterThan(0);
  });

  test.each([
    ["an unknown version", "9.9.9", "v9.9.9 の変更点は CHANGELOG にありません。"],
    ["a malformed version", "1.2", "版は 1.2.3 の形で指定してください。"],
    ["a duplicated section", "1.0.0", "v1.0.0 の節が CHANGELOG に 2 つあるため表示できません。"],
  ])("answers %s privately", async (_label, input, expected) => {
    const notes = parseChangelog(changelogWith(["1.0.0", "1.0.0"]));
    const { interaction, reply, followUp } = commandInteraction(input);
    await handlersFor(notes).releaseNote(interaction);
    const { text, flags } = replyOf(reply);
    expect(text).toContain(expected);
    expect(flags & MessageFlags.Ephemeral).toBe(MessageFlags.Ephemeral);
    expect(followUp).not.toHaveBeenCalled();
  });

  test("says the notes could not be read when CHANGELOG was unreadable", async () => {
    const { interaction, reply } = commandInteraction("1.0.0");
    await handlersFor(undefined).releaseNote(interaction);
    const { text, flags } = replyOf(reply);
    expect(text).toContain("リリースノートを読み込めませんでした。");
    expect(flags & MessageFlags.Ephemeral).toBe(MessageFlags.Ephemeral);
  });
});

describe("/release-note autocomplete", () => {
  function autocomplete(focused: string): {
    interaction: AutocompleteInteraction;
    respond: ReturnType<typeof mock>;
  } {
    const respond = mock(() => Promise.resolve());
    const interaction = {
      options: { getFocused: mock(() => focused) },
      respond,
    } as unknown as AutocompleteInteraction;
    return { interaction, respond };
  }

  test("offers at most 25 versions, newest first", async () => {
    const versions = Array.from({ length: 30 }, (_, i) => `1.${i}.0`);
    const { interaction, respond } = autocomplete("");
    await handlersFor(parseChangelog(changelogWith(versions))).releaseNoteAutocomplete(interaction);
    const choices = respond.mock.calls[0]?.[0] as { name: string; value: string }[];
    expect(choices).toHaveLength(25);
    expect(choices[0]).toEqual({ name: "v1.29.0", value: "1.29.0" });
  });

  test("filters by the typed text, ignoring a leading v", async () => {
    const { interaction, respond } = autocomplete("v1.3");
    await handlersFor(
      parseChangelog(changelogWith(["1.4.0", "1.3.1", "1.3.0", "1.2.0"])),
    ).releaseNoteAutocomplete(interaction);
    expect(respond).toHaveBeenCalledWith([
      { name: "v1.3.1", value: "1.3.1" },
      { name: "v1.3.0", value: "1.3.0" },
    ]);
  });

  test("offers nothing when CHANGELOG was unreadable", async () => {
    const { interaction, respond } = autocomplete("1");
    await handlersFor(undefined).releaseNoteAutocomplete(interaction);
    expect(respond).toHaveBeenCalledWith([]);
  });
});
