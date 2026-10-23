import { expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import type { OpenCodeEvent } from "@opencode/client"
import { createData, type CreateDataInput } from "@opencode/client/solid"
import { createSessionRetention } from "../../src/context/session-retention"
import { createApi, createFetch, directory, json } from "../fixture/tui-client"

test("trims a hidden transcript to its tail and pages the dropped history back in", async () => {
  const setup = fixture({ a: 100, b: 10 })
  try {
    await setup.view("a")
    for (const _ of [1, 2, 3]) await setup.data.session.message.loadMore("a")
    expect(setup.ids("a")).toEqual(range("a", 20, 100))

    await setup.view("b")
    expect(setup.ids("a")).toEqual(range("a", 60, 100))
    expect(setup.data.session.message.more("a")).toBe(true)

    const reads = setup.reads.length
    await setup.view("a")
    expect(setup.reads).toHaveLength(reads)
    expect(setup.ids("a")).toEqual(range("a", 60, 100))
    while (setup.data.session.message.more("a")) await setup.data.session.message.loadMore("a")
    expect(setup.ids("a")).toEqual(range("a", 0, 100))
  } finally {
    setup.dispose()
  }
})

test("keeps visible and running transcripts whole until they are hidden and settled", async () => {
  const setup = fixture({ a: 100, b: 100 })
  try {
    await setup.view("a")
    for (const _ of [1, 2, 3]) await setup.data.session.message.loadMore("a")
    setup.data.session.setStatus("a", "running")
    await setup.view("b")
    expect(setup.ids("a")).toHaveLength(80)

    setup.data.session.setStatus("a", "idle")
    expect(setup.ids("a")).toEqual(range("a", 60, 100))
  } finally {
    setup.dispose()
  }
})

test("re-trims a hidden tail that background events grow", async () => {
  const setup = fixture({ a: 100, b: 10 })
  try {
    await setup.view("a")
    for (const _ of [1, 2, 3]) await setup.data.session.message.loadMore("a")
    await setup.view("b")
    expect(setup.ids("a")).toHaveLength(40)

    // Within twice the tail, cut at a newer loaded page and keep paging from it.
    setup.append("a", 45)
    expect(setup.ids("a")).toHaveLength(65)
    expect(setup.ids("a")[0]).toBe("msg_a_080")
    expect(setup.data.session.message.more("a")).toBe(true)

    // Past it, keep the newest messages and refetch as many on the next view.
    setup.append("a", 30)
    expect(setup.ids("a")).toHaveLength(40)
    expect(setup.data.session.message.more("a")).toBe(false)
    await setup.view("a")
    expect(setup.ids("a")).toEqual(range("a", 60, 100))
    expect(setup.data.session.message.more("a")).toBe(true)
  } finally {
    setup.dispose()
  }
})

test("trims a transcript hidden mid-load once its page lands", async () => {
  const setup = fixture({ a: 100, b: 10 })
  try {
    await setup.view("a")
    for (const _ of [1, 2, 3]) await setup.data.session.message.loadMore("a")
    const loading = setup.data.session.message.loadMore("a")
    const view = setup.view("b")
    expect(setup.ids("a")).toHaveLength(80)

    await Promise.all([loading, view])
    expect(setup.ids("a")).toEqual(range("a", 60, 100))
  } finally {
    setup.dispose()
  }
})

test("keeps a subagent's ancestors whole while it is viewed", async () => {
  const setup = fixture({ p: 100, c: 100, x: 10 }, { parents: { c: "p" } })
  try {
    await setup.view("p")
    for (const _ of [1, 2, 3]) await setup.data.session.message.loadMore("p")
    await setup.view("c")
    expect(setup.ids("p")).toHaveLength(80)

    await setup.view("x")
    expect(setup.ids("p")).toEqual(range("p", 60, 100))
  } finally {
    setup.dispose()
  }
})

test("re-measures a hidden transcript whose content changed at the same length", async () => {
  const setup = fixture({ a: 40, b: 20, c: 10 }, { budget: 45_000, text: 1_000 })
  try {
    await setup.view("a")
    await setup.data.session.message.loadMore("a")
    await setup.view("b")
    expect(setup.ids("a")).toHaveLength(40)

    // Small background output replaces the large history, back at 40 messages.
    setup.append("a", 70)
    expect(setup.ids("a")).toHaveLength(40)
    expect(setup.data.session.message.size("a")).toBeLessThan(10_000)

    await setup.view("c")
    expect(setup.ids("a")).toHaveLength(40)
    expect(setup.ids("b")).toHaveLength(20)
  } finally {
    setup.dispose()
  }
})

test("never evicts a family while one of its sessions is running", async () => {
  // Outside the retained set, then over the byte budget.
  for (const limit of [1, 3]) {
    const setup = fixture({ a: 20, b: 20, c: 20 }, { limit, budget: 30_000, text: 1_000 })
    try {
      await setup.view("a")
      setup.data.session.setStatus("a", "running")
      await setup.view("b")
      await setup.view("c")
      expect(setup.ids("a")).toHaveLength(20)

      setup.data.session.setStatus("a", "idle")
      expect(setup.ids("a")).toHaveLength(0)
    } finally {
      setup.dispose()
    }
  }
})

test("evicts the least recently viewed families past the byte budget", async () => {
  const setup = fixture({ a: 20, b: 20, c: 20, d: 20, e: 20 }, { limit: 5, budget: 50_000, text: 1_000 })
  try {
    for (const id of ["a", "b", "c", "d", "e"]) await setup.view(id)
    expect(["c", "d", "e"].map((id) => setup.ids(id).length)).toEqual([20, 20, 20])
    expect(["a", "b"].map((id) => setup.ids(id).length)).toEqual([0, 0])
    expect(setup.data.session.message.size("d")).toBeGreaterThan(20_000)
  } finally {
    setup.dispose()
  }
})

test("bounds retained transcript bytes across many open tabs", async () => {
  const sessions = Object.fromEntries(Array.from({ length: 15 }, (_, index) => [`t${index}`, 400]))
  const measure = async (options: { tail?: number; budget?: number }) => {
    const setup = fixture(sessions, { ...options, text: 2_000, keep: Object.keys(sessions) })
    try {
      for (const id of Object.keys(sessions)) {
        await setup.view(id)
        await setup.data.session.message.loadMore(id, { all: true })
      }
      await setup.view("t0")
      return Object.keys(sessions).reduce((total, id) => total + setup.data.session.message.size(id), 0)
    } finally {
      setup.dispose()
    }
  }
  const before = await measure({ tail: Infinity, budget: Infinity })
  const after = await measure({})
  // About 12.1 MB before and 1.2 MB after.
  expect(after).toBeLessThan(before / 5)
})

function range(session: string, from: number, to: number) {
  return Array.from({ length: to - from }, (_, index) => message(session, from + index))
}

function message(session: string, index: number) {
  return `msg_${session}_${String(index).padStart(3, "0")}`
}

function fixture(
  counts: Record<string, number>,
  options: {
    limit?: number
    budget?: number
    tail?: number
    text?: number
    keep?: string[]
    parents?: Record<string, string>
  } = {},
) {
  const listeners = new Set<Parameters<CreateDataInput["event"]["listen"]>[0]>()
  const reads: string[] = []
  const text = "x".repeat(options.text ?? 10)
  const api = createApi(
    createFetch((url) => {
      const sessionID = url.pathname.split("/")[3] ?? ""
      if (url.pathname.endsWith("/inbox")) return json({ data: [] })
      if (!url.pathname.endsWith("/message")) return undefined
      reads.push(sessionID)
      // Newest first; a cursor is the index of the oldest message already returned.
      const cursor = url.searchParams.get("cursor")
      const end = cursor === null ? (counts[sessionID] ?? 0) : Number(cursor)
      const start = Math.max(0, end - Number(url.searchParams.get("limit") ?? 50))
      return json({
        data: Array.from({ length: end - start }, (_, offset) => {
          const index = end - 1 - offset
          return { id: message(sessionID, index), type: "user", text, time: { created: index } }
        }),
        cursor: start > 0 ? { next: String(start) } : {},
      })
    }).fetch,
  )
  return createRoot((dispose) => {
    const data = createData({
      api: () => api,
      directory,
      event: {
        on: () => () => {},
        listen(handler) {
          listeners.add(handler)
          return () => listeners.delete(handler)
        },
      },
    })
    const [current, setCurrent] = createSignal<string>()
    const remember = (id: string, updated = 0) =>
      data.session.remember({
        id,
        parentID: options.parents?.[id],
        projectID: "project",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 0, updated },
        location: { directory },
      })
    for (const id of Object.keys(counts)) remember(id)
    createSessionRetention({
      session: data.session,
      current,
      keep: () => options.keep ?? [],
      limit: options.limit ?? 3,
      tail: options.tail,
      budget: options.budget,
    })
    let events = 0
    return {
      data,
      dispose,
      reads,
      ids: (id: string) => data.session.message.list(id).map((item) => item.id),
      async view(id: string) {
        setCurrent(id)
        await data.session.message.sync(id)
      },
      // Background turn output, followed by the session metadata update a turn publishes.
      append(id: string, count: number) {
        for (const _ of Array.from({ length: count })) {
          const event: OpenCodeEvent = {
            id: `evt_${String(++events).padStart(3, "0")}`,
            created: events,
            type: "session.agent.selected",
            durable: { aggregateID: id, seq: events, version: 1 },
            data: { sessionID: id, agent: "build" },
          }
          listeners.forEach((listener) => listener({ name: event.type, details: event }))
        }
        remember(id, events)
      },
    }
  })
}
