import { describe, expect } from "bun:test"
import { DateTime, Effect, Exit } from "effect"
import { asc, eq } from "drizzle-orm"
import { Money } from "@opencode/schema/money"
import { Agent } from "@opencode/core/agent"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Bus } from "@opencode/core/bus"
import { Location } from "@opencode/core/location"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { Model } from "@opencode/core/model"
import { Project } from "@opencode/core/project"
import { Provider } from "@opencode/core/provider"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionChanges } from "@opencode/core/session/changes"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionMessageTable, SessionPartTable } from "@opencode/core/session/sql"
import { SessionStore } from "@opencode/core/session/store"
import { SessionTransfer } from "@opencode/core/session/transfer"
import { testEffect } from "./lib/effect"
import { promptLocationNode } from "./fixture/prompt-location"
import { globalProjectNode } from "./lib/project"

const services = (persist: boolean) =>
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      SessionProjector.node,
      SessionStore.node,
      Session.node,
      SessionTransfer.node,
      SessionChanges.node,
    ]),
    [
      Bus.node.replace(Bus.configured({ persist })),
      Project.node.replace(globalProjectNode),
      LocationServiceMap.node.replace(promptLocationNode),
      SessionExecution.node.replace(SessionExecution.noopLayer),
    ],
  )
const it = testEffect(services(true))
const memoryIt = testEffect(services(false))

const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })
const model = Model.Ref.make({ id: Model.ID.make("model"), providerID: Provider.ID.make("provider") })
const tokens = { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }

type Snapshot = {
  session?: unknown
  messages: Map<string, unknown>
  parts: Map<string, unknown>
  inbox: Map<string, unknown>
}

const partKey = (messageID: string, ordinal: number) => `${messageID}#${ordinal}`

/** Apply a change list the way a client would. */
const apply = (snapshot: Snapshot, changes: ReadonlyArray<SessionChanges.Change>): Snapshot => {
  const next: Snapshot = {
    session: snapshot.session,
    messages: new Map(snapshot.messages),
    parts: new Map(snapshot.parts),
    inbox: new Map(snapshot.inbox),
  }
  for (const change of changes) {
    if (change.type === "session") next.session = change.session
    if (change.type === "message") next.messages.set(change.message.id, change.message)
    if (change.type === "part") next.parts.set(partKey(change.messageID, change.ordinal), change.part)
    if (change.type === "inbox") next.inbox.set(change.item.id, change.item)
    if (change.type !== "removed") continue
    if (change.kind === "inbox") next.inbox.delete(change.id)
    if (change.kind === "part") next.parts.delete(partKey(change.id, change.ordinal ?? 0))
    if (change.kind === "message") {
      next.messages.delete(change.id)
      for (const key of next.parts.keys()) if (key.startsWith(`${change.id}#`)) next.parts.delete(key)
    }
  }
  return next
}

const empty = (): Snapshot => ({ messages: new Map(), parts: new Map(), inbox: new Map() })

/** Follow pages from `since` to the head. */
const readAll = (sessionID: Session.ID, since?: number, limit?: number) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const changes: SessionChanges.Change[] = []
    const sizes: number[] = []
    let cursor = since
    while (true) {
      const page = yield* SessionChanges.read(db, { sessionID, since: cursor, limit })
      sizes.push(page.changes.length)
      for (const change of page.changes) {
        // A page never splits a change number, so the next page starts past everything this one held.
        expect(change.seq).toBeLessThanOrEqual(page.through)
        if (cursor !== undefined) expect(change.seq).toBeGreaterThan(cursor)
      }
      if (cursor !== undefined) expect(page.through).toBeGreaterThanOrEqual(cursor)
      changes.push(...page.changes)
      cursor = page.through
      if (!page.more) return { changes, head: page.head, through: page.through, sizes }
    }
  })

const snapshot = (sessionID: Session.ID) => readAll(sessionID).pipe(Effect.map((read) => apply(empty(), read.changes)))

const head = (sessionID: Session.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return yield* Bus.latestSequence(db, sessionID)
  })

const prompt = (sessionID: Session.ID, text: string) =>
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const inboxID = SessionMessage.ID.create()
    yield* bus.publish(SessionEvent.InboxEnqueued, {
      sessionID,
      inboxID,
      item: { type: "user", payload: { text }, delivery: "steer" },
    })
    yield* bus.publish(SessionEvent.InboxDelivered, { sessionID, inboxID })
    return inboxID
  })

const answer = (sessionID: Session.ID, text: string) =>
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const assistantMessageID = SessionMessage.ID.create()
    yield* bus.publish(SessionEvent.Step.Started, {
      sessionID,
      assistantMessageID,
      agent: Agent.ID.make("build"),
      model,
      started: 1,
    })
    yield* bus.publish(SessionEvent.Text.Started, { sessionID, assistantMessageID, ordinal: 0 })
    yield* bus.publish(SessionEvent.Text.Ended, { sessionID, assistantMessageID, ordinal: 0, text })
    yield* bus.publish(SessionEvent.Step.Ended, {
      sessionID,
      assistantMessageID,
      finish: "stop",
      cost: Money.USD.make(0.01),
      tokens,
    })
    return assistantMessageID
  })

const messageSeqs = (sessionID: Session.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return yield* db
      .select({ id: SessionMessageTable.id, seq: SessionMessageTable.seq })
      .from(SessionMessageTable)
      .where(eq(SessionMessageTable.session_id, sessionID))
      .orderBy(asc(SessionMessageTable.seq))
      .all()
      .pipe(Effect.orDie)
  })

const replaceContent = (sessionID: Session.ID, messageID: SessionMessage.ID, texts: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    yield* bus.publish(SessionEvent.MessageContentUpdated, {
      sessionID,
      messageID,
      content: texts.map((text) => ({ type: "text" as const, text })),
    })
  })

const messageParts = (state: Snapshot, messageID: string) =>
  [...state.parts.keys()].filter((key) => key.startsWith(`${messageID}#`)).toSorted()

const updatesPartInPlace = Effect.gen(function* () {
  const session = yield* Session.Service
  const bus = yield* Bus.Service
  const created = yield* session.create({ location })
  yield* prompt(created.id, "hello")
  const assistantMessageID = SessionMessage.ID.create()
  yield* bus.publish(SessionEvent.Step.Started, {
    sessionID: created.id,
    assistantMessageID,
    agent: Agent.ID.make("build"),
    model,
    started: 1,
  })
  yield* bus.publish(SessionEvent.Text.Started, { sessionID: created.id, assistantMessageID, ordinal: 0 })
  const before = yield* head(created.id)
  const seqs = yield* messageSeqs(created.id)

  yield* bus.publish(SessionEvent.Text.Ended, {
    sessionID: created.id,
    assistantMessageID,
    ordinal: 0,
    text: "done",
  })
  const after = yield* head(created.id)
  expect(after).toBe(before + 1)

  const read = yield* readAll(created.id, before)
  expect(read.head).toBe(after)
  expect(read.changes).toEqual([
    {
      type: "part",
      seq: after,
      messageID: assistantMessageID,
      ordinal: 0,
      part: expect.objectContaining({ text: "done" }),
    },
  ])
  // An update moves the change number, never the creation order.
  expect(yield* messageSeqs(created.id)).toEqual(seqs)
  expect(yield* readAll(created.id, after)).toMatchObject({ changes: [], head: after })
})

describe("SessionChanges", () => {
  it.effect("gives an in-place part update a fresh change number", () => updatesPartInPlace)

  memoryIt.effect("stamps changes with event persistence off", () => updatesPartInPlace)

  it.effect("records removed rows as tombstones", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const bus = yield* Bus.Service
      const created = yield* session.create({ location })
      const first = yield* prompt(created.id, "first")
      yield* answer(created.id, "one")
      const second = yield* prompt(created.id, "second")
      const secondAnswer = yield* answer(created.id, "two")
      const queued = SessionMessage.ID.create()
      yield* bus.publish(SessionEvent.InboxEnqueued, {
        sessionID: created.id,
        inboxID: queued,
        item: { type: "user", payload: { text: "later" }, delivery: "queue" },
      })
      const before = yield* head(created.id)

      yield* bus.publish(SessionEvent.InboxCancelled, { sessionID: created.id, inboxID: queued })
      yield* bus.publish(SessionEvent.RevertEvent.Committed, { sessionID: created.id, to: second })
      const cancelled = before + 1
      const reverted = before + 2

      const read = yield* readAll(created.id, before)
      const removed = read.changes.filter((change) => change.type === "removed")
      expect(removed.slice(0, 1)).toEqual([{ type: "removed", seq: cancelled, kind: "inbox", id: queued }])
      expect(removed.slice(1).toSorted((a, b) => (a.id < b.id ? -1 : 1))).toEqual(
        [second, secondAnswer]
          .toSorted()
          .map((id) => ({ type: "removed" as const, seq: reverted, kind: "message" as const, id })),
      )
      const state = yield* snapshot(created.id)
      expect([...state.messages.keys()]).toContain(first)
      expect([...state.messages.keys()]).not.toContain(second)
      expect([...state.parts.keys()].some((key) => key.startsWith(secondAnswer))).toBe(false)
    }),
  )

  it.effect("stamps forked rows at or below the child's head", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const { db } = yield* Database.Service
      const created = yield* session.create({ location })
      yield* prompt(created.id, "first")
      yield* answer(created.id, "one")
      const forked = yield* session.fork({ sessionID: created.id })
      const forkHead = yield* head(forked.id)

      const rows = yield* db
        .select({ change: SessionMessageTable.change_seq })
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, forked.id))
        .all()
      const parts = yield* db
        .select({ change: SessionPartTable.change_seq })
        .from(SessionPartTable)
        .where(eq(SessionPartTable.session_id, forked.id))
        .all()
      expect(rows.length).toBeGreaterThan(0)
      expect(parts.length).toBeGreaterThan(0)
      // The copy is one transaction: every row takes the fork event's number.
      expect(new Set([...rows, ...parts].map((row) => row.change)).size).toBe(1)
      expect(rows[0]!.change).toBeLessThanOrEqual(forkHead)
      const state = yield* snapshot(forked.id)
      expect(state.messages.size).toBe(rows.length)
      expect(state.parts.size).toBe(parts.length)
      // Small pages still end on the page that holds the copy, not on an empty one after it.
      const paged = yield* readAll(forked.id, undefined, 2)
      expect(paged.sizes.every((size) => size > 0)).toBe(true)
      expect(paged.through).toBe(forkHead)
      expect(apply(empty(), paged.changes)).toEqual(state)

      // The next write to the fork lands after everything the copy wrote.
      yield* prompt(forked.id, "after")
      const read = yield* readAll(forked.id, forkHead)
      expect(read.changes.some((change) => change.type === "message")).toBe(true)
      expect(read.changes.every((change) => change.seq > forkHead)).toBe(true)
    }),
  )

  it.effect("stamps imported rows with the import's change number", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const transfer = yield* SessionTransfer.Service
      const template = yield* session.create({ location, title: "Imported" })
      const sessionID = Session.ID.create()
      const assistantID = SessionMessage.ID.create()
      yield* transfer.import({
        data: {
          info: { ...template, id: sessionID },
          messages: [
            { id: SessionMessage.ID.create(), type: "user", text: "hi", time: { created: DateTime.makeUnsafe(1) } },
            {
              id: assistantID,
              type: "assistant",
              agent: Agent.ID.make("build"),
              model,
              content: [
                { type: "text", text: "a" },
                { type: "text", text: "b" },
              ],
              time: { created: DateTime.makeUnsafe(2), completed: DateTime.makeUnsafe(3) },
            },
          ],
        },
        location,
      })
      const importHead = yield* head(sessionID)
      const read = yield* readAll(sessionID)
      expect(read.head).toBe(importHead)
      const seqs = new Set(read.changes.map((change) => change.seq))
      expect(seqs.size).toBe(1)
      expect([...seqs][0]).toBeLessThanOrEqual(importHead)
      expect(read.changes.map((change) => change.type)).toEqual(["session", "message", "message", "part", "part"])
      const paged = yield* readAll(sessionID, undefined, 2)
      expect(paged.sizes).toEqual([5])
      expect(paged.through).toBe(importHead)
      // A cursor past the head never moves backwards.
      expect(yield* readAll(sessionID, importHead + 5)).toMatchObject({
        changes: [],
        through: importHead + 5,
        sizes: [0],
      })

      yield* prompt(sessionID, "after")
      const next = yield* readAll(sessionID, importHead)
      expect(next.changes.length).toBeGreaterThan(0)
      expect(next.changes.every((change) => change.seq > importHead)).toBe(true)
    }),
  )

  it.effect("catching up from any cursor matches a full read at the head", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const bus = yield* Bus.Service
      const created = yield* session.create({ location })
      const record: Array<{ cursor: number; state: Snapshot }> = []
      const mark = Effect.gen(function* () {
        record.push({ cursor: yield* head(created.id), state: yield* snapshot(created.id) })
      })
      yield* mark
      yield* prompt(created.id, "first")
      yield* mark
      yield* answer(created.id, "one")
      yield* mark
      const second = yield* prompt(created.id, "second")
      yield* mark
      yield* answer(created.id, "two")
      yield* mark
      const queued = SessionMessage.ID.create()
      yield* bus.publish(SessionEvent.InboxEnqueued, {
        sessionID: created.id,
        inboxID: queued,
        item: { type: "user", payload: { text: "later" }, delivery: "queue" },
      })
      yield* mark
      yield* bus.publish(SessionEvent.InboxDeliveryChanged, {
        sessionID: created.id,
        inboxID: queued,
        delivery: "steer",
      })
      yield* mark
      yield* session.rename({ sessionID: created.id, title: "renamed" })
      yield* mark
      yield* bus.publish(SessionEvent.RevertEvent.Committed, { sessionID: created.id, to: second })
      yield* mark
      yield* answer(created.id, "three")

      const final = yield* snapshot(created.id)
      expect(final.messages.size).toBeGreaterThan(0)
      for (const { cursor, state } of record) {
        for (const limit of [1, 3, undefined]) {
          const read = yield* readAll(created.id, cursor, limit)
          expect(apply(state, read.changes)).toEqual(final)
        }
      }
    }),
  )

  it.effect("removes inline parts a legacy row loses when its content is replaced", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const { db } = yield* Database.Service
      const created = yield* session.create({ location })
      yield* prompt(created.id, "hello")
      const legacyID = SessionMessage.ID.create()
      yield* db
        .insert(SessionMessageTable)
        .values({
          id: legacyID,
          session_id: created.id,
          type: "assistant",
          seq: (yield* messageSeqs(created.id)).length,
          change_seq: yield* head(created.id),
          time_created: 10,
          time_updated: 10,
          data: {
            agent: Agent.ID.make("build"),
            model,
            content: ["a", "b", "c"].map((text) => ({ type: "text" as const, text })),
            time: { created: 10, completed: 11 },
          },
        })
        .run()
        .pipe(Effect.orDie)
      const cursor = yield* head(created.id)
      const before = yield* snapshot(created.id)
      expect(messageParts(before, legacyID)).toHaveLength(3)

      yield* replaceContent(created.id, legacyID, ["a"])
      const after = apply(before, (yield* readAll(created.id, cursor)).changes)
      expect(messageParts(after, legacyID)).toEqual([partKey(legacyID, 0)])
      expect(after).toEqual(yield* snapshot(created.id))
    }),
  )

  it.effect("re-creates a part key after a shrink, applied in change order", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const created = yield* session.create({ location })
      yield* prompt(created.id, "hello")
      const messageID = yield* answer(created.id, "one")
      const record: Array<{ cursor: number; state: Snapshot }> = []
      for (const texts of [["a", "b", "c"], ["a"], ["a", "b"]]) {
        record.push({ cursor: yield* head(created.id), state: yield* snapshot(created.id) })
        yield* replaceContent(created.id, messageID, texts)
      }
      // A full read holds both the old tombstone and the re-created row; the row comes later, so it wins.
      const final = yield* snapshot(created.id)
      expect(messageParts(final, messageID)).toEqual([partKey(messageID, 0), partKey(messageID, 1)])
      for (const { cursor, state } of record)
        for (const limit of [1, undefined])
          expect(apply(state, (yield* readAll(created.id, cursor, limit)).changes)).toEqual(final)
    }),
  )

  it.effect("refuses reads while the feed is disabled", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const changes = yield* SessionChanges.Service
      const created = yield* session.create({ location })
      expect(changes.enabled).toBe(false)
      const exit = yield* changes.read({ sessionID: created.id }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )
})
