import { ChannelType, SlashCommandBuilder } from "discord.js";

export const configCommand = new SlashCommandBuilder()
  .setName("config")
  .setDescription("設定管理コマンド")
  .addSubcommand((sub) =>
    sub
      .setName("free-only")
      .setDescription("無料モデル限定の切り替え")
      .addStringOption((option) =>
        option
          .setName("enabled")
          .setDescription("有効/無効")
          .setRequired(true)
          .addChoices({ name: "on", value: "on" }, { name: "off", value: "off" }),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("release-channel")
      .setDescription("リリース通知チャンネルを設定（省略で無効化）")
      .addChannelOption((option) =>
        option
          .setName("channel")
          .setDescription("通知先チャンネル")
          .addChannelTypes(ChannelType.GuildText),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("llm-details")
      .setDescription("LLM詳細情報表示の切り替え")
      .addStringOption((option) =>
        option
          .setName("enabled")
          .setDescription("有効/無効")
          .setRequired(true)
          .addChoices({ name: "on", value: "on" }, { name: "off", value: "off" }),
      ),
  )
  .addSubcommandGroup((group) =>
    group
      .setName("auto-reply")
      .setDescription("自動応答チャンネル設定")
      .addSubcommand((sub) =>
        sub
          .setName("add")
          .setDescription("自動応答チャンネルを追加")
          .addChannelOption((option) =>
            option
              .setName("channel")
              .setDescription("自動応答を有効にするチャンネル")
              .setRequired(true)
              .addChannelTypes(ChannelType.GuildText, ChannelType.PublicThread),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("remove")
          .setDescription("自動応答チャンネルを削除")
          .addStringOption((option) =>
            option
              .setName("channel")
              .setDescription("自動応答を無効にするチャンネル")
              .setRequired(true)
              .setAutocomplete(true),
          ),
      )
      .addSubcommand((sub) => sub.setName("list").setDescription("自動応答チャンネル一覧を表示")),
  );
