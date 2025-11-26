import { Message } from "discord.js";

export function onMessageCreate(message: Message) {
  if (message.author.bot) {
    return;
  }

  // TODO: delegate to ChatService once implemented
}
