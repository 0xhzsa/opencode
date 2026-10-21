/// <reference lib="webworker" />

import { ShikiStreamTokenizer } from "@shikijs/stream"
import { createMarkdownParser } from "@opencode/ui/context/marked-parser"
import { OpenCodeTheme } from "@opencode/ui/context/marked-theme"
import {
  bundledLanguages,
  createHighlighter,
  getTokenStyleObject,
  stringifyTokenStyle,
  type BundledLanguage,
  type ThemedToken,
} from "shiki"
import type { MarkdownToken, MarkdownWorkerRequest, MarkdownWorkerResponse } from "./markdown-worker-protocol"
import { createLatestWorkerQueue } from "./markdown-worker-queue"
import { project, type Projection } from "./markdown-stream"
import type { Lang } from "@pierre/highlights"
import type { CodeHighlighter } from "../pierre/highlighter"

type Highlights = typeof import("./markdown-highlights")

type Tokenizer = {
  push: (delta: string) => Promise<{ stable: MarkdownToken[]; unstable: MarkdownToken[] }>
  dispose: () => void
}

type Stream = {
  language: string
  highlighter: CodeHighlighter
  source: string
  tokenizer: Tokenizer
}

const streams = new Map<string, Stream>()

const projections = new Map<string, Projection>()

let highlighter: ReturnType<typeof createHighlighter> | undefined

// Undefined once Highlights failed to load or to highlight: this worker then stays on Shiki for the rest of the session,
// since a load failure (such as a blocked WebAssembly compile) would only repeat on every block.
let highlights: Promise<Highlights | undefined> | undefined

const highlightQueue = createLatestWorkerQueue<Extract<MarkdownWorkerRequest, { type: "highlight" }>>({
  run: highlight,
  supersede: (request) => post({ type: "superseded", id: request.id, key: request.key }),
  dispose: (key) => {
    streams.get(key)?.tokenizer.dispose()
    streams.delete(key)
  },
})

const projectQueue = createLatestWorkerQueue<Extract<MarkdownWorkerRequest, { type: "project" }>>({
  run: runProject,
  supersede: (request) => post({ type: "superseded", id: request.id, key: request.key }),
  dispose: (key) => void projections.delete(key),
})

const shikiParser = createMarkdownParser(shikiHtml)

const highlightsParser = createMarkdownParser(async (code, language) => {
  const lexer = await getHighlights()

  if (!lexer?.supportsLanguage(language)) return shikiHtml(code, language)

  try {
    return lexer.highlightsHtml(code, language)
  } catch (error) {
    disableHighlights(error)

    return shikiHtml(code, language)
  }
})

async function shikiHtml(code: string, language: string) {
  const instance = await getHighlighter()
  // SAFETY: `name` is a key of bundledLanguages or "text", which Shiki always has.
  const name = (language in bundledLanguages ? language : "text") as BundledLanguage

  if (!instance.getLoadedLanguages().includes(name)) await instance.loadLanguage(bundledLanguages[name])

  return instance
    .codeToHtml(code, { lang: name, theme: "OpenCode", tabindex: false })
    .replace("<code>", `<code class="language-${name}">`)
}

self.onmessage = (event: MessageEvent<MarkdownWorkerRequest>) => {
  if (event.data.type === "dispose") {
    highlightQueue.dispose(event.data.key)
    projectQueue.dispose(event.data.key)

    return
  }

  if (event.data.type === "parse") {
    void parse(event.data)

    return
  }

  if (event.data.type === "project") {
    projectQueue.highlight(event.data)

    return
  }

  highlightQueue.highlight(event.data)
}

async function parse(request: Extract<MarkdownWorkerRequest, { type: "parse" }>) {
  try {
    const parser = request.highlighter === "highlights" ? highlightsParser : shikiParser
    post({ type: "parse", id: request.id, html: await parser.parse(request.text) })
  } catch (error) {
    post({ type: "error", id: request.id, message: error instanceof Error ? error.message : String(error) })
  }
}

async function runProject(request: Extract<MarkdownWorkerRequest, { type: "project" }>) {
  try {
    const projection = project(projections.get(request.key), request.text, request.live)
    projections.set(request.key, projection)
    post({ type: "project", id: request.id, key: request.key, projection })
  } catch (error) {
    post({
      type: "error",
      id: request.id,
      key: request.key,
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

async function highlight(request: Extract<MarkdownWorkerRequest, { type: "highlight" }>) {
  try {
    const lexer = request.highlighter === "highlights" ? await getHighlights() : undefined
    const requested = request.language

    if (lexer?.supportsLanguage(requested)) {
      const done = await highlightWithHighlights(lexer, request, requested).then(
        () => true,
        (error: unknown) => {
          disableHighlights(error)

          return false
        },
      )

      if (done) return
    }

    const instance = await getHighlighter()
    // SAFETY: `language` is a key of bundledLanguages or "text", which Shiki always has.
    const language = (request.language in bundledLanguages ? request.language : "text") as BundledLanguage

    if (!instance.getLoadedLanguages().includes(language)) await instance.loadLanguage(bundledLanguages[language])

    if (request.complete) {
      const result = instance.codeToTokens(request.text, { lang: language, theme: "OpenCode" })
      streams.get(request.key)?.tokenizer.dispose()
      streams.delete(request.key)
      post({
        type: "highlight",
        id: request.id,
        key: request.key,
        language,
        reset: true,
        stable: result.tokens
          .flatMap((line, index) =>
            index === result.tokens.length - 1 ? line : [...line, { content: "\n", offset: 0 }],
          )
          .map(token),
        unstable: [],
      })

      return
    }

    await stream(request, language, "shiki", () => {
      const tokenizer = new ShikiStreamTokenizer({ highlighter: instance, lang: language, theme: "OpenCode" })

      return {
        push: async (delta) => {
          const result = await tokenizer.enqueue(delta)

          return {
            stable: result.stable.filter((token) => token.content.length > 0).map(token),
            unstable: result.unstable.filter((token) => token.content.length > 0).map(token),
          }
        },
        dispose: () => undefined,
      }
    })
  } catch (error) {
    post({
      type: "error",
      id: request.id,
      key: request.key,
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

async function highlightWithHighlights(
  lexer: Highlights,
  request: Extract<MarkdownWorkerRequest, { type: "highlight" }>,
  language: Lang,
) {
  const convert = (value: { content: string; color?: string; fontStyle?: number }): MarkdownToken => [
    value.content,
    lexer.style(value),
  ]

  if (request.complete) {
    const lines = lexer.highlightsTokens(request.text, language)
    streams.get(request.key)?.tokenizer.dispose()
    streams.delete(request.key)
    post({
      type: "highlight",
      id: request.id,
      key: request.key,
      language,
      reset: true,
      stable: lines
        .flatMap((line, index) => (index === lines.length - 1 ? line : [...line, { content: "\n" }]))
        .filter((value) => value.content.length > 0)
        .map(convert),
      unstable: [],
    })

    return
  }

  await stream(request, language, "highlights", () => {
    const tokenizer = lexer.createHighlightsStream(language)

    return {
      push: async (delta) => {
        const result = tokenizer.push(delta)

        return {
          stable: result.stable.filter((value) => value.content.length > 0).map(convert),
          unstable: result.unstable.filter((value) => value.content.length > 0).map(convert),
        }
      },
      dispose: tokenizer.dispose,
    }
  })
}

// Feeds the request's new suffix to the block's tokenizer, starting a fresh one when the text no longer extends what
// it has seen or the language or highlighter changed.
async function stream(
  request: Extract<MarkdownWorkerRequest, { type: "highlight" }>,
  language: string,
  highlighter: CodeHighlighter,
  create: () => Tokenizer,
) {
  const previous = streams.get(request.key)

  const reset =
    !previous ||
    previous.language !== language ||
    previous.highlighter !== highlighter ||
    !request.text.startsWith(previous.source)

  if (reset) {
    previous?.tokenizer.dispose()
    streams.delete(request.key)
  }

  const current = reset ? { language, highlighter, source: "", tokenizer: create() } : previous
  const result = await current.tokenizer.push(request.text.slice(current.source.length))
  current.source = request.text
  streams.set(request.key, current)
  post({ type: "highlight", id: request.id, key: request.key, language, reset, ...result })
}

function getHighlights() {
  return (highlights ??= import("./markdown-highlights").catch((error: unknown) => {
    disableHighlights(error)

    return undefined
  }))
}

function disableHighlights(error: unknown) {
  highlights = Promise.resolve(undefined)
  console.error("Pierre Highlights failed; markdown code uses Shiki for the rest of this session", error)
}

function getHighlighter() {
  return (highlighter ??= createHighlighter({ themes: [OpenCodeTheme], langs: [] }))
}

function post(response: MarkdownWorkerResponse) {
  self.postMessage(response)
}

function token(value: ThemedToken): MarkdownToken {
  return [value.content, stringifyTokenStyle(value.htmlStyle ?? getTokenStyleObject(value))]
}
