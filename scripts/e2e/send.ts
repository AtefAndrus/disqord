import type { DiscordMessage, Scenario, ScenarioPost } from "./scenarios";

export interface SentScenario {
  triggerId: string;
  marker: string;
}

/** The same REST payload is used for real fixtures and their referenced trigger. */
export function messagePayload(
  message: ScenarioPost,
  botId: string,
  replyTo?: string,
): Record<string, unknown> {
  const mention = message.mention ?? true;
  return {
    ...(message.prompt && { content: mention ? `<@${botId}> ${message.prompt}` : message.prompt }),
    allowed_mentions: { users: mention ? [botId] : [], replied_user: false },
    attachments: (message.files ?? []).map((file, id) => ({ id, filename: file.name })),
    ...(message.embeds && { embeds: message.embeds }),
    ...(message.components && { components: message.components }),
    ...(message.flags !== undefined && { flags: message.flags }),
    ...(replyTo && { message_reference: { message_id: replyTo, fail_if_not_exists: true } }),
  };
}

export async function sendScenario(
  scenario: Scenario,
  post: (message: ScenarioPost, replyTo?: string) => Promise<DiscordMessage>,
  pause: () => Promise<void>,
): Promise<SentScenario> {
  let fixtureId: string | undefined;
  if (scenario.setup) {
    const fixture = await post(scenario.setup);
    fixtureId = fixture.id;
    if (scenario.input?.quote && fixture.author.bot !== true)
      throw new Error("the reply fixture is not a real Bot message in Discord REST");
    for (const unrelated of scenario.setup.after ?? []) {
      const decoy = await post(unrelated);
      if (scenario.input?.quote && decoy.author.bot !== true)
        throw new Error("the unrelated history fixture is not a real Bot message in Discord REST");
    }
    for (let index = 0; index < (scenario.setup.fillerCount ?? 0); index++) {
      await post({ prompt: `[e2e] window filler ${index + 1}`, mention: false });
    }
    await pause();
  }
  const marker = scenario.input
    ? `[${scenario.input.quote ? "e2e-bot-context" : "e2e-input"}:${crypto.randomUUID()}]`
    : "";
  const trigger = await post(
    { ...scenario, prompt: `${scenario.prompt}${marker ? `\n${marker}` : ""}` },
    scenario.setup?.reply ? fixtureId : undefined,
  );
  return { triggerId: trigger.id, marker };
}
