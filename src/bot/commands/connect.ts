import { InteractionContextType, SlashCommandBuilder } from "discord.js";

export const connectCommand = new SlashCommandBuilder()
  .setName("connect")
  .setDescription("OpenRouter アカウントを接続する")
  .setContexts(
    InteractionContextType.Guild,
    InteractionContextType.BotDM,
    InteractionContextType.PrivateChannel,
  )
  .addSubcommand((sub) =>
    sub.setName("user").setDescription("自分の OpenRouter アカウントを接続する"),
  )
  .addSubcommand((sub) =>
    sub.setName("guild").setDescription("サーバー用の OpenRouter アカウントを接続する"),
  )
  .addSubcommand((sub) =>
    sub.setName("status").setDescription("接続状態と自分のキーの残額を確認する"),
  );
export const disconnectCommand = new SlashCommandBuilder()
  .setName("disconnect")
  .setDescription("OpenRouter アカウントの接続を解除する")
  .setContexts(
    InteractionContextType.Guild,
    InteractionContextType.BotDM,
    InteractionContextType.PrivateChannel,
  )
  .addSubcommand((sub) => sub.setName("user").setDescription("自分の接続を解除する"))
  .addSubcommand((sub) => sub.setName("guild").setDescription("サーバーの接続を解除する"));
