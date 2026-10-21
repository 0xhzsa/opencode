import { LiveTokenizer, codeToTokens, isSupportedLanguage, type Lang, type ThemedToken } from "@pierre/highlights"
import { OpenCodeHighlightsTheme } from "@opencode/ui/context/marked-theme"

// Pierre Highlights for markdown code blocks. Imported lazily by the markdown worker, since importing the package
// compiles its WebAssembly; languages it has no lexer for stay on Shiki.

export const supportsLanguage = isSupportedLanguage

export function highlightsTokens(code: string, lang: Lang) {
  return codeToTokens(code, { lang, theme: OpenCodeHighlightsTheme }).tokens
}

export function highlightsHtml(code: string, lang: Lang) {
  const result = codeToTokens(code, { lang, theme: OpenCodeHighlightsTheme })

  const lines = result.tokens.map(
    (line) =>
      `<span class="line">${line.map((token) => `<span style="${attribute(style(token))}">${text(token.content)}</span>`).join("")}</span>`,
  )

  return `<pre class="shiki OpenCode" style="background-color:${result.bg};color:${result.fg}"><code class="language-${lang}">${lines.join("\n")}</code></pre>`
}

/**
 * Streams one code block through an editable document: each delta is appended as an edit, so only the edited last line
 * and the lines after it are lexed again, with lexer state carried across chunks. Lines that end before the last one are
 * final; the last line is still growing.
 */
export function createHighlightsStream(lang: Lang) {
  const live = new LiveTokenizer({ lang, theme: OpenCodeHighlightsTheme })
  let emitted = 0

  return {
    push(delta: string) {
      const last = live.lineCount - 1
      const end = { line: last, character: live.getLineLength(last) }
      live.applyEdits([{ range: { start: end, end }, newText: delta }])
      const tail = live.lineCount - 1

      const stable = Array.from({ length: tail - emitted }, (_, index) => [
        ...live.getLineTokens(emitted + index).tokens,
        { content: "\n", offset: 0 },
      ]).flat()

      emitted = tail

      return { stable, unstable: live.getLineTokens(tail).tokens }
    },
    dispose: () => live.dispose(),
  }
}

export function style(token: Pick<ThemedToken, "color" | "fontStyle">) {
  return [
    token.color ? `color:${token.color}` : "",
    token.fontStyle && token.fontStyle & 1 ? "font-style:italic" : "",
    token.fontStyle && token.fontStyle & 2 ? "font-weight:bold" : "",
  ]
    .filter(Boolean)
    .join(";")
}

function text(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

function attribute(value: string) {
  return text(value).replaceAll('"', "&quot;")
}
