import { expect } from "bun:test"
import { Effect } from "effect"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

type Json = { data: { id: string; head: number; changes: ReadonlyArray<unknown> } }

const setup = (enabled: boolean) =>
  Effect.gen(function* () {
    const handler = yield* ServerFetch.make({
      app: { version: "test" },
      database: { path: ":memory:" },
      fs: { filewatcher: false },
      sync: { enabled },
    })
    return (path: string, body?: unknown) =>
      Effect.promise(async () => {
        const response = await handler(
          new Request(`http://opencode.local${path}`, {
            method: body === undefined ? "GET" : "POST",
            headers: { "content-type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
          }),
        )
        return { status: response.status, json: (await response.json()) as Json }
      })
  })

it.live("serves the session change feed only when sync is enabled", () =>
  Effect.gen(function* () {
    const enabled = yield* setup(true)
    const created = yield* enabled("/api/session", { title: "Feed" })
    const id = created.json.data.id
    const all = yield* enabled(`/api/experimental/session/${id}/changes`)
    expect(all.status).toBe(200)
    expect(all.json.data).toMatchObject({ sessionID: id, more: false })
    expect(all.json.data.changes).toEqual([
      expect.objectContaining({ type: "session", session: expect.objectContaining({ id, title: "Feed" }) }),
    ])

    const head = all.json.data.head
    expect((yield* enabled(`/api/experimental/session/${id}/changes?since=${head}`)).json.data.changes).toEqual([])
    expect((yield* enabled(`/api/experimental/session/ses_missing/changes`)).status).toBe(404)

    const disabled = yield* setup(false)
    const other = yield* disabled("/api/session", { title: "Off" })
    expect((yield* disabled(`/api/experimental/session/${other.json.data.id}/changes`)).status).toBe(503)
  }).pipe(Effect.scoped),
)
