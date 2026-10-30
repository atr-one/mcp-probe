/**
 * Token estimate without a tokenizer. Tokenizers differ between model families, so this is a rough, documented
 * heuristic: an ASCII character counts as 1/4 token (about 4 characters per token for English text and JSON),
 * any other character as 1/2 token (Cyrillic, CJK and accented text tokenize far less efficiently).
 */
export const ASCII_CHARS_PER_TOKEN = 4;
export const OTHER_CHARS_PER_TOKEN = 2;

/** Characters as code points (what a reader would count), not UTF-16 units. */
export function countChars(text: string): number {
  let n = 0;
  for (const _ of text) n++;
  return n;
}

export function estimateTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (const ch of text) {
    if (ch.codePointAt(0)! < 0x80) ascii++;
    else other++;
  }
  return Math.ceil(ascii / ASCII_CHARS_PER_TOKEN + other / OTHER_CHARS_PER_TOKEN);
}
