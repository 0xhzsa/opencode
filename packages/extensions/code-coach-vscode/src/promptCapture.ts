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

// A location is a URL, a domain, or a filesystem path. The UIA observer sees
// the browser address bar as an Edit control, so without this guard the
// address bar would be captured as a prompt.
const URL_PREFIX = /^(?:https?|chrome|edge|file|about|view-source|data):/i;
const WINDOWS_PATH = /^[a-z]:[\\/]/i;
const UNIX_PATH = /^\/(?:Users|home|usr|etc|var|opt|tmp|mnt)\//;
const BARE_DOMAIN = /^(?:[\w-]+\.)+[a-z]{2,}(?::\d+)?(?:[/?#]\S*)?$/i;
const LOCAL_HOST = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?(?:[/?#]\S*)?$/i;

export function looksLikeLocation(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (URL_PREFIX.test(t)) return true;
  if (WINDOWS_PATH.test(t)) return true;
  if (UNIX_PATH.test(t)) return true;
  // A bare domain only counts when the whole text is one token; a prompt that
  // mentions a domain in a sentence is still a prompt.
  if (!/\s/.test(t) && (BARE_DOMAIN.test(t) || LOCAL_HOST.test(t))) return true;
  return false;
}

export function looksLikePrompt(text: string): boolean {
  const t = text.trim();
  if (t.length < 8 || t.length > 4000) return false;
  if (looksLikeLocation(t)) return false;
  const lines = t.split("\n");
  if (lines.length > 40) return false;

  let codeish = 0;
  for (const l of lines) {
    if (CODE_HINTS.test(l)) codeish++;
  }
  // Mostly prose => prompt. Mostly code => not a prompt.
  return codeish / lines.length < 0.3;
}
