import { getSharedHighlighter } from "@pierre/diffs"
import { bundledLanguages } from "shiki"
import { createSimpleContext } from "./helper"
import { createMarkdownParser } from "./marked-parser"
import { registerOpenCodeTheme } from "./marked-theme-register"

export { OpenCodeTheme } from "./marked-theme"

registerOpenCodeTheme()

export const { use: useMarked, provider: MarkedProvider } = createSimpleContext({
  name: "Marked",
  init: () =>
    createMarkdownParser(async (code, language) => {
      const highlighter = await getSharedHighlighter({
        themes: ["OpenCode"],
        langs: [],
        preferredHighlighter: "shiki-wasm",
      })

      const name = language in bundledLanguages ? language : "text"

      await highlighter.loadLanguages([name])

      return highlighter.codeToHtml(code, { lang: name, theme: "OpenCode" })
    }),
})
