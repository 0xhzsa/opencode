import { expect, test } from "bun:test"
import { createHighlightsStream, highlightsTokens, style } from "./markdown-highlights"

test("streamed chunks finalize the same tokens as highlighting the whole block", () => {
  const code = 'const a = `tpl ${1 + 2}\nnext` /* multi\nline */ + "s"\nfunction f(x: number) { return x }\n'
  const stream = createHighlightsStream("ts")
  const chunks = Array.from({ length: Math.ceil(code.length / 3) }, (_, index) => code.slice(index * 3, index * 3 + 3))
  const results = chunks.map((chunk) => stream.push(chunk))
  stream.dispose()

  const streamed = [...results.flatMap((result) => result.stable), ...results.at(-1)!.unstable].flatMap((token) =>
    token.content === "\n" || token.content.length === 0 ? [] : [[token.content, style(token)]],
  )

  const whole = highlightsTokens(code, "ts")
    .flat()
    .flatMap((token) => (token.content.length === 0 ? [] : [[token.content, style(token)]]))

  expect(streamed).toEqual(whole)
})
