import { expect, mock, test } from "bun:test";
import {
  DiscordMessageReader,
  DiscordRestBudget,
} from "../../../src/services/discordMessageReader";

test("forwards an abort signal to Discord REST list and fetch calls", async () => {
  const rest = {
    get: mock(async () => []),
  };
  const reader = new DiscordMessageReader(rest);
  const signal = new AbortController().signal;

  await reader.list("channel", { before: "100", limit: 100 }, new DiscordRestBudget(), signal);
  await reader.fetch("channel", "100", new DiscordRestBudget(), signal);

  expect(rest.get).toHaveBeenNthCalledWith(
    1,
    expect.any(String),
    expect.objectContaining({ signal }),
  );
  expect(rest.get).toHaveBeenNthCalledWith(
    2,
    expect.any(String),
    expect.objectContaining({ signal }),
  );
});
