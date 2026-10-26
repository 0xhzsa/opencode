import { describe, expect } from "bun:test"
import type { FileSystem } from "@opencode/core/filesystem"
import { DateTime, Effect, Fiber, Layer, LayerMap } from "effect"
import { TestClock } from "effect/testing"
import { eq } from "drizzle-orm"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Bus } from "@opencode/core/bus"
import { Location } from "@opencode/schema/location"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { AbsolutePath } from "@opencode/core/schema"
import { Schedule } from "@opencode/core/schedule"
import { ScheduleTable } from "@opencode/core/schedule/sql"
import { Session } from "@opencode/core/session"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionInbox } from "@opencode/core/session/inbox"
import { SessionInboxTable, SessionTable } from "@opencode/core/session/sql"
import { SessionStore } from "@opencode/core/session/store"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import type { LocationServices } from "@opencode/core/location-services"
import { Plugin } from "@opencode/core/plugin"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { Snapshot } from "@opencode/core/snapshot"
import { Skill } from "@opencode/core/skill"
import { Config } from "@opencode/core/config"
import { Document, Info } from "@opencode/schema/config"
import { ConfigExperimental } from "@opencode/schema/config/experimental"
import { testEffect } from "./lib/effect"

const enabledDirectory = "/enabled"
const disabledDirectory = "/disabled"

const wakes: Session.ID[] = []
const execution = Layer.succeed(
  SessionExecution.Service,
  SessionExecution.Service.of({
    active: Effect.sync(() => new Set()),
    isActive: () => Effect.succeed(false),
    resume: () => Effect.void,
    interrupt: () => Effect.succeed(false),
    wake: (sessionID) => Effect.sync(() => void wakes.push(sessionID)),
    awaitIdle: () => Effect.void,
  }),
)
const enabled = Config.testLayer([
  new Document({
    type: "document",
    info: new Info({
      timezone: "America/New_York",
      experimental: new ConfigExperimental.Info({ schedules: true }),
    }),
  }),
])
const locations = makeGlobalNode({
  service: LocationServiceMap.Service,
  layer: Layer.effect(
    LocationServiceMap.Service,
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      return yield* LayerMap.make(
        (ref: Location.Ref) =>
          // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
          Layer.mergeAll(
            ref.directory === enabledDirectory ? enabled : Layer.empty,
            LayerNode.compile(LayerNode.group([PluginHooks.node, Skill.node]), {
              replacements: [Bus.node.replace(Layer.succeed(Bus.Service, bus))],
            }),
            Layer.mock(Snapshot.Service, { capture: () => Effect.undefined, restore: () => Effect.void }),
            Layer.mock(Plugin.Service, { awaitActivation: Effect.void }),
          ).pipe(Layer.fresh) as unknown as Layer.Layer<LocationServices, FileSystem.DirectoryNotFoundError>,
      )
    }),
  ),
  deps: [Bus.node],
})
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, Bus.node, SessionProjector.node, SessionStore.node, Session.node, Schedule.node]),
    [
      Bus.node.replace(Bus.configured({ persist: true })),
      SessionExecution.node.replace(execution),
      LocationServiceMap.node.replace(locations),
    ],
  ),
)

const sessionID = Session.ID.make("ses_schedule_test")

const setup = (directory = enabledDirectory) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({ id: sessionID, project_id: Project.ID.global, slug: "test", directory, title: "test", version: "test" })
      .run()
      .pipe(Effect.orDie)
    wakes.length = 0
    return yield* Schedule.Service
  })

const setTime = (iso: string) => TestClock.setTime(Date.parse(iso))
const pending = Database.Service.use(({ db }) =>
  db
    .select({ id: SessionInboxTable.id })
    .from(SessionInboxTable)
    .all()
    .pipe(
      Effect.orDie,
      Effect.map((rows) => rows.map((row) => row.id)),
    ),
)
/** Moves pending prompts into the transcript, as a running Session would. */
const deliver = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* SessionInbox.promote(db, yield* Bus.Service, sessionID, "steer")
})
const messageID = (schedule: Schedule.Info, run: number) => SessionMessage.ID.make(`msg_${schedule.id}_${run}`)
const iso = (time: DateTime.Utc | undefined) => time && DateTime.formatIso(time)

describe("Schedule", () => {
  it.effect("fires an in schedule once", () =>
    Effect.gen(function* () {
      const schedules = yield* setup()
      const schedule = yield* schedules.create({
        sessionID,
        when: { type: "in", in: "5 minutes" },
        action: { type: "prompt", prompt: "check the build" },
      })
      expect(schedule.tz).toBe("America/New_York")

      yield* TestClock.adjust("4 minutes")
      yield* schedules.tick
      expect(yield* pending).toEqual([])

      yield* TestClock.adjust("1 minute")
      yield* schedules.tick
      expect(yield* pending).toEqual([messageID(schedule, 1)])
      expect(wakes).toEqual([sessionID])
      const { db } = yield* Database.Service
      expect(yield* SessionInbox.find(db, messageID(schedule, 1))).toMatchObject({
        type: "user",
        delivery: "steer",
        payload: { text: "check the build" },
      })
      expect(yield* schedules.get(schedule.id)).toMatchObject({
        status: "done",
        runCount: 1,
        lastOutcome: "fired",
        nextDueAt: undefined,
      })

      yield* TestClock.adjust("10 minutes")
      yield* schedules.tick
      expect(yield* pending).toEqual([messageID(schedule, 1)])
    }),
  )

  it.effect("fires an at schedule at the wall-clock time in its zone", () =>
    Effect.gen(function* () {
      yield* setTime("2026-11-01T12:00:00Z")
      const schedules = yield* setup()
      const schedule = yield* schedules.create({
        sessionID,
        when: { type: "at", at: "2026-11-02T09:30", tz: "Europe/Paris" },
        action: { type: "prompt", prompt: "standup" },
      })
      expect(iso(schedule.nextDueAt)).toBe("2026-11-02T08:30:00.000Z")
      expect(
        yield* Effect.flip(
          schedules.create({
            sessionID,
            when: { type: "at", at: "2026-11-01T11:00:00Z" },
            action: { type: "prompt", prompt: "too late" },
          }),
        ),
      ).toMatchObject({ _tag: "Schedule.InvalidError" })

      yield* setTime("2026-11-02T08:30:00Z")
      yield* schedules.tick
      expect(yield* pending).toEqual([messageID(schedule, 1)])
      expect((yield* schedules.get(schedule.id)).status).toBe("done")
    }),
  )

  it.effect("stops an every schedule after ends.times", () =>
    Effect.gen(function* () {
      const schedules = yield* setup()
      const schedule = yield* schedules.create({
        sessionID,
        when: { type: "every", every: "1 minute" },
        ends: { times: 2 },
        action: { type: "prompt", prompt: "poll" },
      })
      for (const _ of [1, 2, 3]) {
        yield* TestClock.adjust("1 minute")
        yield* schedules.tick
        yield* deliver
      }
      expect(yield* schedules.get(schedule.id)).toMatchObject({ status: "done", runCount: 2, remainingRuns: 0 })
      expect(wakes).toEqual([sessionID, sessionID])
    }),
  )

  it.effect("stops an every schedule at ends.at", () =>
    Effect.gen(function* () {
      yield* setTime("2026-10-26T12:00:00Z")
      const schedules = yield* setup()
      const schedule = yield* schedules.create({
        sessionID,
        when: { type: "every", every: "10 minutes" },
        ends: { at: "2026-10-26T12:25:00Z" },
        action: { type: "prompt", prompt: "poll" },
      })
      for (const _ of [1, 2, 3]) {
        yield* TestClock.adjust("10 minutes")
        yield* schedules.tick
        yield* deliver
      }
      expect(yield* schedules.get(schedule.id)).toMatchObject({ status: "done", runCount: 2 })
    }),
  )

  it.effect("keeps cron at the same wall-clock time across a DST change", () =>
    Effect.gen(function* () {
      yield* setTime("2026-10-31T12:00:00Z")
      const schedules = yield* setup()
      const schedule = yield* schedules.create({
        sessionID,
        when: { type: "cron", cron: "30 9 * * *", tz: "America/New_York" },
        action: { type: "prompt", prompt: "morning" },
      })
      expect(iso(schedule.nextDueAt)).toBe("2026-10-31T13:30:00.000Z")

      yield* setTime("2026-10-31T13:30:00Z")
      yield* schedules.tick
      expect(iso((yield* schedules.get(schedule.id)).nextDueAt)).toBe("2026-11-01T14:30:00.000Z")
    }),
  )

  it.effect("catches up once after downtime, marked late, and keeps the phase", () =>
    Effect.gen(function* () {
      yield* setTime("2026-10-26T12:00:00Z")
      const schedules = yield* setup()
      const schedule = yield* schedules.create({
        sessionID,
        when: { type: "every", every: "10 minutes" },
        action: { type: "prompt", prompt: "poll" },
      })

      yield* setTime("2026-10-26T13:05:00Z")
      yield* schedules.tick
      yield* schedules.tick
      expect(yield* pending).toEqual([messageID(schedule, 1)])
      const { db } = yield* Database.Service
      expect(yield* SessionInbox.find(db, messageID(schedule, 1))).toMatchObject({
        payload: { metadata: { schedule: { id: schedule.id, run: 1, late: true } } },
      })
      expect(yield* schedules.get(schedule.id)).toMatchObject({ runCount: 1, lastOutcome: "late" })
      expect(iso((yield* schedules.get(schedule.id)).nextDueAt)).toBe("2026-10-26T13:10:00.000Z")
    }),
  )

  it.effect("skips a firing while the previous prompt is unconsumed", () =>
    Effect.gen(function* () {
      const schedules = yield* setup()
      const schedule = yield* schedules.create({
        sessionID,
        when: { type: "every", every: "1 minute" },
        action: { type: "prompt", prompt: "poll" },
      })
      yield* TestClock.adjust("1 minute")
      yield* schedules.tick
      yield* TestClock.adjust("1 minute")
      yield* schedules.tick
      expect(yield* pending).toEqual([messageID(schedule, 1)])
      expect(yield* schedules.get(schedule.id)).toMatchObject({ runCount: 1, lastOutcome: "skipped" })

      yield* deliver
      yield* TestClock.adjust("1 minute")
      yield* schedules.tick
      expect(yield* pending).toEqual([messageID(schedule, 2)])
    }),
  )

  it.effect("does not duplicate a prompt admitted before a crash", () =>
    Effect.gen(function* () {
      const schedules = yield* setup()
      const sessions = yield* Session.Service
      const schedule = yield* schedules.create({
        sessionID,
        when: { type: "in", in: "1 minute" },
        action: { type: "prompt", prompt: "once" },
      })
      yield* TestClock.adjust("1 minute")
      // The previous process admitted run 1 and died before advancing the row.
      yield* sessions.prompt({ sessionID, id: messageID(schedule, 1), text: "once", resume: false })

      yield* schedules.tick
      expect(yield* pending).toEqual([messageID(schedule, 1)])
      expect(wakes).toEqual([sessionID])
      expect(yield* schedules.get(schedule.id)).toMatchObject({ status: "done", runCount: 1 })
    }),
  )

  it.effect("removes a Session's schedules with the Session", () =>
    Effect.gen(function* () {
      const schedules = yield* setup()
      yield* schedules.create({
        sessionID,
        when: { type: "every", every: "1 hour" },
        action: { type: "prompt", prompt: "poll" },
      })
      const { db } = yield* Database.Service
      yield* db.delete(SessionTable).where(eq(SessionTable.id, sessionID)).run().pipe(Effect.orDie)
      expect(yield* schedules.list()).toEqual([])
    }),
  )

  it.effect("does nothing when experimental.schedules is off", () =>
    Effect.gen(function* () {
      const schedules = yield* setup(disabledDirectory)
      expect(
        yield* Effect.flip(
          schedules.create({
            sessionID,
            when: { type: "in", in: "1 minute" },
            action: { type: "prompt", prompt: "poll" },
          }),
        ),
      ).toMatchObject({ _tag: "Schedule.DisabledError" })

      const { db } = yield* Database.Service
      yield* db
        .insert(ScheduleTable)
        .values({
          id: Schedule.ID.create(),
          session_id: sessionID,
          action: { type: "prompt", prompt: "poll" },
          when: { type: "in", in: "1 minute" },
          tz: "UTC",
          next_due_at: 0,
          time_created: 0,
          time_updated: 0,
        })
        .run()
        .pipe(Effect.orDie)
      yield* TestClock.adjust("1 minute")
      yield* schedules.tick
      expect(yield* pending).toEqual([])
      expect((yield* schedules.list())[0]).toMatchObject({ status: "active", runCount: 0 })
    }),
  )

  it.effect("pauses and resumes at the next slot", () =>
    Effect.gen(function* () {
      const schedules = yield* setup()
      const schedule = yield* schedules.create({
        sessionID,
        when: { type: "every", every: "1 minute" },
        action: { type: "prompt", prompt: "poll" },
      })
      expect((yield* schedules.pause(schedule.id)).status).toBe("paused")
      yield* TestClock.adjust("150 seconds")
      yield* schedules.tick
      expect(yield* pending).toEqual([])

      const resumed = yield* schedules.resume(schedule.id)
      expect(resumed.status).toBe("active")
      expect(iso(resumed.nextDueAt)).toBe(new Date(180_000).toISOString())
      yield* schedules.remove(schedule.id)
      expect(yield* Effect.flip(schedules.get(schedule.id))).toMatchObject({ _tag: "Schedule.NotFoundError" })
    }),
  )

  it.effect("run sleeps until the next schedule is due", () =>
    Effect.gen(function* () {
      const schedules = yield* setup()
      const fiber = yield* Effect.forkChild(schedules.run)
      const schedule = yield* schedules.create({
        sessionID,
        when: { type: "in", in: "10 seconds" },
        action: { type: "prompt", prompt: "soon" },
      })
      yield* TestClock.adjust("9 seconds")
      expect(yield* pending).toEqual([])
      yield* TestClock.adjust("1 second")
      yield* Effect.yieldNow
      expect(yield* pending).toEqual([messageID(schedule, 1)])
      yield* Fiber.interrupt(fiber)
    }),
  )
})
