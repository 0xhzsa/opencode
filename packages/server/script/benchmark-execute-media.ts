// Run from packages/server; isolated synthetic HTTP fixture, no listening server.
import { OpenCode, type SessionMessageInfo } from "@opencode/client"
import { Session } from "@opencode/schema/session"
import { Effect } from "effect"
import assert from "node:assert/strict"
import { ServerFetch } from "../src/fetch"
import { tempGlobalLayer } from "../../core/test/fixture/global"

await Effect.runPromise(
  Effect.gen(function* () {
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
      fetch: Object.assign(
        async (input: string | URL | Request, init?: RequestInit) => {
          const response = await handler(new Request(input, init))
          const body = await response.arrayBuffer()
          measured.bytes += body.byteLength
          return new Response(body, { status: response.status, headers: response.headers })
        },
        { preconnect: fetch.preconnect },
      ),
    })
    yield* Effect.promise(async () => {
      const template = await api.session.create({ title: "Execute media page" })
      const messages: SessionMessageInfo[] = Array.from({ length: 40 }, (_, index) => ({
        id: `msg_fixture_${index}`,
        type: "assistant",
        agent: "build",
        model: { providerID: "test", id: "test" },
        content: index === 20 ? [{
          type: "tool",
          id: "call_execute",
          name: "execute",
          time: { created: index, completed: index + 1 },
          state: {
            status: "completed",
            input: { code: "return await tools.screenshot()" },
            content: [
              { type: "text", text: "Captured screenshot" },
              { type: "file", mime: "image/png", uri: `data:image/png;base64,${"A".repeat(2_550_000)}` },
            ],
          },
        }] : [{ type: "text", text: "Synthetic response. ".repeat(20) }],
        finish: "stop",
        time: { created: index, completed: index + 1 },
      }))
      const session = await api.session.import({ info: { ...template, id: Session.ID.create() }, messages })
      const samples: { iteration: number; ms: number; bytes: number }[] = []
      for (let iteration = 0; iteration < 8; iteration++) {
        measured.bytes = 0
        const start = performance.now()
        const page = await api.message.list({ sessionID: session.id, limit: 40 })
        const sample = { iteration, ms: performance.now() - start, bytes: measured.bytes }
        assert.equal(page.data.length, 40)
        assert.deepEqual(page.data.map((message) => message.id), messages.toReversed().map((message) => message.id))
        const message = page.data.find((message) => message.id === "msg_fixture_20")
        assert(message?.type === "assistant")
        const tool = message.content[0]
        assert(tool?.type === "tool" && tool.state.status === "completed")
        assert.deepEqual(tool.state.content[0], { type: "text", text: "Captured screenshot" })
        samples.push(sample)
      }
      const times = samples.slice(1).map((sample) => sample.ms).sort((a, b) => a - b)
      console.log(JSON.stringify({
        fixture: "40 synthetic messages, one execute result with 2.55 MB base64; not HOME replay",
        median: times[3], min: times[0], max: times.at(-1), samples,
      }, null, 2))
    })
  }).pipe(Effect.provide(tempGlobalLayer), Effect.scoped),
)
