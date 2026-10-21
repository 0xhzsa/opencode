// Manual benchmark of the real HTTP handler and generated client, with isolated synthetic data.
import { OpenCode, type SessionMessageInfo } from "@opencode/client"
import { Session } from "@opencode/schema/session"
import { Effect } from "effect"
import assert from "node:assert/strict"
import { ServerFetch } from "../src/fetch"
import { tempGlobalLayer } from "../../core/test/fixture/global"

await Effect.runPromise(Effect.gen(function* () {
  const handler = yield* ServerFetch.make({
    app: { version: "benchmark" },
    database: { path: ":memory:" },
    config: { project: false },
    models: { fetch: false },
    fs: { filewatcher: false },
  })
  const measured = { bytes: 0 }
  const api = OpenCode.make({
    baseUrl: "http://fixture.invalid",
    fetch: Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
      const response = await handler(new Request(input, init))
      const body = await response.arrayBuffer()
      measured.bytes += body.byteLength
      return new Response(body, { status: response.status, headers: response.headers })
    }, { preconnect: fetch.preconnect }),
  })
  yield* Effect.promise(async () => {
    const template = await api.session.create({ title: "Attachment-heavy prompt index" })
    const messages: SessionMessageInfo[] = Array.from({ length: 1000 }, (_, index) => ({
      id: `msg_fixture_${index}`,
      type: "user",
      text: `Prompt ${index}. ` + "Synthetic prompt text. ".repeat(18),
      metadata: { displayText: `Prompt ${index}`, comments: [], attachments: [] },
      files: [{ data: "A".repeat(22000), mime: "image/png", source: { type: "inline" } }],
      time: { created: index },
    }))
    const session = await api.session.import({ info: { ...template, id: Session.ID.create() }, messages })
    const samples: { iteration: number; variant: string; ms: number; bytes: number; requests: number }[] = []
    for (let iteration = 0; iteration < 8; iteration++) {
      for (const includeFiles of iteration % 2 ? [false, true] : [true, false]) {
        measured.bytes = 0
        const start = performance.now()
        const result: SessionMessageInfo[] = []
        let cursor: string | undefined
        let requests = 0
        do {
          const page = await api.message.list({ sessionID: session.id, type: "user", limit: 200, cursor, includeFiles })
          requests++
          result.push(...page.data)
          cursor = page.cursor.next ?? undefined
        } while (cursor && result.length < 1000)
        const sample = { iteration, variant: includeFiles ? "before" : "after", ms: performance.now() - start, bytes: measured.bytes, requests }
        assert.equal(result.length, 1000)
        assert.deepEqual(result.map((message) => message.id), messages.toReversed().map((message) => message.id))
        const first = result[0]
        assert(first?.type === "user")
        assert.equal(first.metadata?.displayText, "Prompt 999")
        assert.equal(first.files?.length, includeFiles ? 1 : undefined)
        samples.push(sample)
      }
    }
    const summaries = Object.fromEntries(["before", "after"].map((variant) => {
      const rows = samples.filter((sample) => sample.iteration > 0 && sample.variant === variant)
      const times = rows.map((sample) => sample.ms).sort((a, b) => a - b)
      return [variant, { median: times[3], min: times[0], max: times.at(-1), bytes: rows[0]?.bytes, requests: rows[0]?.requests }]
    }))
    console.log(JSON.stringify({ fixture: "1000 user prompts, 22000 base64 characters each; synthetic, not an exact HOME replay", summaries, samples }, null, 2))
  })
}).pipe(Effect.provide(tempGlobalLayer), Effect.scoped))
