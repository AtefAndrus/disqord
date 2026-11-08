import { createAddReactionTool } from "./discord/addReaction";
import { createCreateEventTool } from "./discord/createEvent";
import { createCreatePollTool } from "./discord/createPoll";
import { createCreateThreadTool } from "./discord/createThread";
import { createGetChannelInfoTool } from "./discord/getChannelInfo";
import { createListEventsTool } from "./discord/listEvents";
import { createListPinsTool } from "./discord/listPins";
import { createPinMessageTool } from "./discord/pinMessage";
import { createReplyWithReactionTool } from "./discord/replyWithReaction";
import { createProposeCronJobTool } from "./proposeCronJob";
import { createReadEarlierMessagesTool } from "./readEarlierMessages";
import { createReadXPostTool } from "./readXPost";
import { ToolRegistry } from "./registry";
import { createViewAttachmentTool } from "./viewAttachment";

/** Every client tool the bot offers; each one's `isEnabled` decides when. */
export function createDefaultToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(createReadEarlierMessagesTool());
  registry.register(createViewAttachmentTool());
  registry.register(createReadXPostTool());
  registry.register(createAddReactionTool());
  registry.register(createReplyWithReactionTool());
  registry.register(createCreatePollTool());
  registry.register(createCreateEventTool());
  registry.register(createCreateThreadTool());
  registry.register(createPinMessageTool());
  registry.register(createListPinsTool());
  registry.register(createGetChannelInfoTool());
  registry.register(createListEventsTool());
  registry.register(createProposeCronJobTool());
  return registry;
}
