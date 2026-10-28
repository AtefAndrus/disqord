import { ApplicationCommandType, ContextMenuCommandBuilder, PermissionFlagsBits } from "discord.js";

export const INSPECT_INPUT_COMMAND_NAME = "LLM 入力を見る";

export const inspectInputCommand = new ContextMenuCommandBuilder()
  .setName(INSPECT_INPUT_COMMAND_NAME)
  .setType(ApplicationCommandType.Message)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);
