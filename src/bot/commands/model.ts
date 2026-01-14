import { SlashCommandBuilder } from "discord.js";

export const modelCommand = new SlashCommandBuilder()
  .setName("model")
  .setDescription("モデル管理コマンド")
  .addSubcommand((sub) => sub.setName("current").setDescription("現在のデフォルトモデルを表示"))
  .addSubcommand((sub) =>
    sub
      .setName("set")
      .setDescription("デフォルトモデルを変更")
      .addStringOption((option) =>
        option
          .setName("model")
          .setDescription("OpenRouterのモデルID")
          .setRequired(true)
          .setAutocomplete(true),
      ),
  )
  .addSubcommand((sub) => sub.setName("list").setDescription("OpenRouterのモデル一覧ページへ"))
  .addSubcommand((sub) => sub.setName("refresh").setDescription("モデルキャッシュを更新"));
