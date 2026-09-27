/**
 * Counts an ASCII character as a quarter token and any other character as a
 * whole token. Japanese measured about 0.49 tokens per character, so this
 * leans to the safe side by roughly a factor of two there. No tokenizer is
 * used because the model, and so the tokenizer, changes per guild.
 */
export function estimateTextTokens(text: string): number {
  let ascii = 0;
  let nonAscii = 0;
  for (const character of text) {
    if ((character.codePointAt(0) ?? 0) <= 0x7f) ascii++;
    else nonAscii++;
  }
  return Math.ceil(ascii / 4) + nonAscii;
}
