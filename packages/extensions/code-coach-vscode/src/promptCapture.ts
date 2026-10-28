/*
 * promptCapture.ts - captures the developer's prompt from the clipboard.
 *
 * Cursor / Copilot / Claude chat prompts are in webviews the extension cannot
 * read directly. The reliable cross-editor path is the clipboard: the
 * developer copies their prompt (or the editor does), and we keep the last
 * text that looks like a prompt rather than code. It is then paired with the
 * next diff. A command ("Coach this prompt") lets the developer type it
 * explicitly when the clipboard is not available.
 */

const CODE_HINTS = /[{};<>]|=>|\bfunction\b|\bconst\b|\blet\b|\bvar\b|\bimport\b|\bclass\b|\bdef\b|\breturn\b/;

export function looksLikePrompt(text: string): boolean {
  const t = text.trim();
  if (t.length < 8 || t.length > 4000) return false;
  const lines = t.split("\n");
  if (lines.length > 40) return false;

  let codeish = 0;
  for (const l of lines) {
    if (CODE_HINTS.test(l)) codeish++;
  }
  // Mostly prose => prompt. Mostly code => not a prompt.
  return codeish / lines.length < 0.3;
}
