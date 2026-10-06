import { ConversationWindowService } from "../../src/services/conversationWindow";
import { BOT_CONTEXT_PREFIX, botContextMarker, INPUT_PREFIX, observeResponsesBody } from "./input";

// This module is loaded only by the E2E child, before src/index.ts imports.
const build = ConversationWindowService.prototype.build;
ConversationWindowService.prototype.build = function (input): ReturnType<typeof build> {
  const marker = botContextMarker(input.current.content);
  if (marker && input.current.author.bot && input.current.author.id === input.e2eTesterBotId) {
    // Keep the entry-point exception that permits a tester mention, while
    // testing actual Bot eligibility for history and explicit reply targets.
    console.log(`${BOT_CONTEXT_PREFIX}${marker}`);
    return build.call(this, { ...input, e2eTesterBotId: undefined });
  }
  return build.call(this, input);
};

const originalFetch = globalThis.fetch;
function observedFetch(...args: Parameters<typeof fetch>): ReturnType<typeof fetch> {
  const [resource, init] = args;
  const url =
    typeof resource === "string"
      ? resource
      : resource instanceof URL
        ? resource.href
        : resource.url;
  if (
    url === "https://openrouter.ai/api/v1/responses" &&
    init?.method === "POST" &&
    typeof init.body === "string"
  ) {
    try {
      const observation = observeResponsesBody(JSON.parse(init.body));
      if (observation) console.log(`${INPUT_PREFIX}${JSON.stringify(observation)}`);
    } catch {
      // No observation makes the assertion fail; don't log a raw body on error.
    }
  }
  // Preserve the request arguments and response stream exactly as supplied.
  return originalFetch(...args);
}
globalThis.fetch = Object.assign(observedFetch, originalFetch);
