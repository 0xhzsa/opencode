import { describe, expect } from "bun:test"
import { DateTime, Duration, Effect, Queue, Stream } from "effect"
import { TestClock } from "effect/testing"
import type { Plugin } from "@opencode/plugin/effect"
import type { CommandDefinition } from "@opencode/plugin/effect/command"
import { Event } from "@opencode/schema/event"
import { SessionGoal } from "@opencode/schema/session-goal"
import { GoalPlugin } from "@opencode/core/plugin/goal"
import { Session } from "@opencode/core/session"
import type { SessionEvent } from "@opencode/core/session/event"
import { it } from "../lib/effect"
import { host } from "./host"

const sessionID = Session.ID.make("ses_goal_watchdog")

type Execution = SessionEvent.Execution.Started | SessionEvent.Execution.Succeeded

const execution = (type: Execution["type"]): Execution => ({
  id: Event.ID.create(),
  created: 0,
  durable: { aggregateID: sessionID, seq: Event.Seq.make(0), version: Event.Version.make(1) },
  type,
  data: { sessionID },
})

/** Runs the goal plugin against stubbed domains: one Session whose metadata the plugin reads and writes. */
const run = Effect.fnUntraced(function* (metadata: Record<string, unknown> = {}) {
  const state = { metadata }
  const events = yield* Queue.unbounded<Execution>()
  const commands: CommandDefinition[] = []
  const hooks = new Map<string, (event: unknown) => Effect.Effect<void>>()
  const info = () =>
    // SAFETY: the plugin reads only the id, title, creation time and metadata of a Session.
    ({
      id: sessionID,
      title: "Release",
      time: { created: DateTime.makeUnsafe(0) },
      metadata: state.metadata,
    }) as unknown as Session.Info
  const session: Partial<Plugin.Context["session"]> = {
    // SAFETY: tests call the captured hooks with the event fields the plugin reads.
    hook: ((name: string, callback: (event: unknown) => Effect.Effect<void>) =>
      Effect.sync(() => void hooks.set(name, callback))) as never,
    get: () => Effect.sync(info),
    // SAFETY: the startup sweep reads only `data`.
    list: () => Effect.sync(() => ({ data: [info()], cursor: {} })) as never,
    update: (input) =>
      Effect.sync(() => {
        if (input.metadata) state.metadata = input.metadata
      }),
    synthetic: () => Effect.void as never,
  }
  yield* GoalPlugin.Plugin.effect(
    host({
      session,
      // SAFETY: the plugin only filters the stream by event type.
      event: { subscribe: () => Stream.fromQueue(events) as never },
      command: {
        list: () => Effect.die("unused command.list"),
        transform: (callback) =>
          Effect.sync(() => callback({ add: (definition) => void commands.push(definition) })) as never,
        reload: () => Effect.die("unused command.reload"),
      },
    }),
  )
  // Let the forked event watcher and startup sweep start.
  yield* Effect.yieldNow
  return {
    goal: () => SessionGoal.fromMetadata(sessionID, state.metadata),
    command: (text: string) =>
      Effect.forEach(commands, (definition) =>
        definition.execute({ sessionID, prompt: { text }, delivery: "steer" }).pipe(Effect.orDie),
      ),
    hook: (name: string, event: unknown) => hooks.get(name)?.(event) ?? Effect.die(`no ${name} hook`),
    emit: (type: Execution["type"]) =>
      Queue.offer(events, execution(type)).pipe(Effect.andThen(Effect.yieldNow), Effect.andThen(Effect.yieldNow)),
  }
})

describe("goal plugin waiting", () => {
  it.effect("pauses a goal an earlier server process left active when the plugin starts", () =>
    Effect.gen(function* () {
      const plugin = yield* run({
        [SessionGoal.KEY]: {
          id: "goal-earlier",
          sessionID,
          objective: "Ship the release",
          status: "active",
          rounds: 1,
          maxRounds: 50,
          boot: "an-earlier-process",
          updatedAt: 0,
        },
      })

      expect(plugin.goal()).toMatchObject({
        status: "paused",
        reason: "The server restarted while the goal was active",
      })
    }),
  )

  it.effect("pauses a goal that sits idle past the limit, and not while the Session keeps running", () =>
    Effect.gen(function* () {
      const plugin = yield* run()
      yield* plugin.command("Ship the release")
      expect(plugin.goal()).toMatchObject({ status: "active" })

      // Waiting on background work: the execution ended with the goal still active.
      yield* plugin.emit("session.execution.succeeded")
      yield* TestClock.adjust(Duration.subtract(GoalPlugin.WAIT_LIMIT, Duration.minutes(1)))
      // The background work reports: the Session runs again, which cancels the wait.
      yield* plugin.emit("session.execution.started")
      yield* TestClock.adjust(Duration.minutes(5))
      expect(plugin.goal()).toMatchObject({ status: "active" })

      yield* plugin.emit("session.execution.succeeded")
      yield* TestClock.adjust(GoalPlugin.WAIT_LIMIT)
      expect(plugin.goal()).toMatchObject({
        status: "paused",
        reason: "Nothing ran for 30 minutes while the goal waited on background work",
      })
    }),
  )

  it.effect("asks a summary to keep the goal, but not in a native compaction", () =>
    Effect.gen(function* () {
      const plugin = yield* run()
      yield* plugin.command("Ship the release")
      const summary = { sessionID, messages: [] as unknown[], native: false }
      const native = { sessionID, messages: [] as unknown[], native: true }

      yield* plugin.hook("compaction", summary)
      yield* plugin.hook("compaction", native)

      expect(JSON.stringify(summary.messages)).toContain("This session has an active goal that the user set.")
      // A native window may replay this message after the goal is gone, so nothing is added.
      expect(native.messages).toEqual([])
    }),
  )

  it.effect("never overwrites what the user did after the loop decided", () =>
    Effect.gen(function* () {
      const plugin = yield* run()
      yield* plugin.command("Ship the release")
      yield* plugin.emit("session.execution.succeeded")
      yield* plugin.command("pause")

      // The wait was decided on the active goal; the user's pause since then wins.
      yield* TestClock.adjust(GoalPlugin.WAIT_LIMIT)
      expect(plugin.goal()).toMatchObject({ status: "paused", reason: "Paused by the user" })
    }),
  )
})
