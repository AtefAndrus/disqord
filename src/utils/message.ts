const DISCORD_MESSAGE_LIMIT = 2000;

export function splitIntoChunks(content: string): string[] {
  if (content.length <= DISCORD_MESSAGE_LIMIT) {
    return [content];
  }

  const chunks: string[] = [];
  let pointer = 0;

  while (pointer < content.length) {
    chunks.push(content.slice(pointer, pointer + DISCORD_MESSAGE_LIMIT));
    pointer += DISCORD_MESSAGE_LIMIT;
  }

  return chunks;
}
