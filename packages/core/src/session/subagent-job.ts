export * as SubagentJob from "./subagent-job.js"

import { Context, Effect, Layer, Scope, Stream } from "effect"
import { Node } from "@opencode/util/effect/app-node"
import type { LayerNode } from "@opencode/util/effect/layer-node"
import { Bus } from "../bus.js"
import { Job } from "../job.js"
import { Session } from "../session.js"
import { SessionEvent } from "./event.js"
import { SessionMessage } from "./message.js"
import type { SessionSchema } from "./schema.js"
import { SubagentCompletion } from "./subagent-completion.js"

type Recovery = Extract<Job.Recovery, { kind: "subagent" }>

/**
 * A background child whose parent hears about its results. `pending` counts job generations
 * whose result is still being delivered; `reported` is the idle marker of the newest busy
 * period the parent has heard about.
 */
type Watch = {
  recovery: Recovery
  pending: number
  reported?: SessionMessage.ID
}

type Idle = Pick<SessionMessage.Idle, "id" | "outcome" | "error">

const TURN_PAGE = 50

export interface Interface {
  start: (recovery: Recovery) => Effect.Effect<Job.Info>
  background: (recovery: Recovery) => Effect.Effect<void>
  notify: (recovery: Recovery, startedAt: number) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SubagentJob") {}

const make: Effect.Effect<Interface, never, Session.Service | Job.Service | Bus.Service | Scope.Scope> = Effect.gen(
  function* () {
    const sessions = yield* Session.Service
    const jobs = yield* Job.Service
    const bus = yield* Bus.Service
    const scope = yield* Scope.Scope
    // Jobs and their completion observers outlive the plugin that launched them.
    // Fork with the global context too, rather than retaining the caller's location.
    const context = yield* Effect.context<never>()
    // One observer per job generation, including continuations of the same child.
    const notifications = new Set<string>()
    const watches = new Map<SessionSchema.ID, Watch>()
    // The idle marker each job generation's result was read from, handed from `start` to `notify`.
    const settled = new Map<SessionSchema.ID, SessionMessage.ID>()

    const isNewer = (watch: Watch, idle: SessionMessage.ID) => watch.reported === undefined || idle > watch.reported

    // The busy period that ended at `idle`, read back to the idle marker that precedes it.
    const turnBefore = Effect.fnUntraced(function* (sessionID: SessionSchema.ID, idle: SessionMessage.ID) {
      let assistant: SessionMessage.Info | undefined
      let prompted = false
      let cursor = { id: idle, direction: "next" as const }
      while (true) {
        const page = yield* sessions.messages({ sessionID, order: "desc", limit: TURN_PAGE, cursor })
        for (const message of page) {
          if (message.type === "idle") return { assistant, prompted }
          if (message.type === "user") prompted = true
          if (
            !assistant &&
            message.type === "assistant" &&
            message.time.completed !== undefined &&
            message.error === undefined
          )
            assistant = message
        }
        const last = page.at(-1)
        if (page.length < TURN_PAGE || !last) return { assistant, prompted }
        cursor = { id: last.id, direction: "next" }
      }
    })

    // A child can start a new busy period without the subagent tool: a plugin continuing an
    // empty step, or a background shell or nested subagent result arriving after the child
    // went idle. Its parent already heard about the previous busy period, so report this one
    // when it brings news. Empty successes and interruptions are not news, and turns that
    // contain a user prompt are a conversation someone else started with the child.
    const followUp = Effect.fnUntraced(function* (sessionID: SessionSchema.ID, idle: Idle) {
      const watch = watches.get(sessionID)
      if (!watch || watch.pending > 0 || !isNewer(watch, idle.id)) return
      const turn = yield* turnBefore(sessionID, idle.id)
      if (watch.pending > 0 || !isNewer(watch, idle.id)) return
      watch.reported = idle.id
      if (turn.prompted || idle.outcome === "interrupted") return
      if (idle.outcome === "failed") {
        yield* SubagentCompletion.deliver(sessions, jobs, {
          recovery: watch.recovery,
          status: "error",
          error: idle.error?.message ?? "Subagent failed",
        })
        return
      }
      const output = SubagentCompletion.text(turn.assistant)
      if (output === SubagentCompletion.NO_TEXT) return
      yield* SubagentCompletion.deliver(sessions, jobs, { recovery: watch.recovery, status: "completed", output })
    })

    // A busy period that ended while a job generation was being delivered is reported afterwards.
    const catchUp = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
      const [idle] = yield* sessions.messages({ sessionID, type: "idle", order: "desc", limit: 1 })
      if (idle?.type === "idle") yield* followUp(sessionID, idle)
    })

    const forget = (sessionID: SessionSchema.ID) => {
      watches.delete(sessionID)
      settled.delete(sessionID)
      for (const [childID, watch] of watches) if (watch.recovery.parentSessionID === sessionID) watches.delete(childID)
    }

    const guarded = (sessionID: SessionSchema.ID) => (effect: ReturnType<typeof followUp>) =>
      effect.pipe(
        Effect.catchTag("Session.NotFoundError", () => Effect.sync(() => forget(sessionID))),
        Effect.catchCause((cause) =>
          Effect.logError("Failed to report subagent continuation", cause).pipe(Effect.annotateLogs({ sessionID })),
        ),
      )

    yield* bus.subscribe([SessionEvent.Execution.Succeeded, SessionEvent.Execution.Failed, SessionEvent.Deleted]).pipe(
      Stream.runForEach((event) => {
        const sessionID = event.data.sessionID
        if (event.type === SessionEvent.Deleted.type) return Effect.sync(() => forget(sessionID))
        const id = SessionMessage.ID.fromEvent(event.id)
        return followUp(
          sessionID,
          event.type === SessionEvent.Execution.Failed.type
            ? { id, outcome: "failed", error: event.data.error }
            : { id, outcome: "succeeded" },
        ).pipe(guarded(sessionID))
      }),
      Effect.forkIn(scope, { startImmediately: true }),
    )

    const notify = Effect.fn("SubagentJob.notify")(function* (recovery: Recovery, startedAt: number) {
      const key = `${recovery.childSessionID}:${startedAt}`
      if (notifications.has(key)) return
      notifications.add(key)
      const watch = watches.get(recovery.childSessionID) ?? { recovery, pending: 0 }
      watch.recovery = recovery
      watch.pending++
      watches.set(recovery.childSessionID, watch)
      yield* Effect.gen(function* () {
        const info = (yield* jobs.wait({ id: recovery.childSessionID })).info
        const idle = settled.get(recovery.childSessionID)
        settled.delete(recovery.childSessionID)
        if (idle && isNewer(watch, idle)) watch.reported = idle
        if (info) yield* SubagentCompletion.deliver(sessions, jobs, { ...info, recovery })
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            notifications.delete(key)
            watch.pending--
          }).pipe(
            Effect.andThen(
              Effect.suspend(() =>
                watch.pending === 0 && watches.get(recovery.childSessionID) === watch
                  ? catchUp(recovery.childSessionID).pipe(guarded(recovery.childSessionID))
                  : Effect.void,
              ),
            ),
          ),
        ),
        Effect.forkIn(scope, { startImmediately: true }),
        Effect.setContext(context),
      )
    })

    return Service.of({
      start: (recovery: Recovery) =>
        jobs
          .start({
            id: recovery.childSessionID,
            type: "subagent",
            title: recovery.description,
            metadata: {},
            recovery,
            run: Effect.gen(function* () {
              yield* sessions.resume(recovery.childSessionID)
              const messages = yield* sessions.messages({
                sessionID: recovery.childSessionID,
                order: "desc",
                limit: 20,
              })
              const idle = messages.find((message) => message.type === "idle")
              if (idle) settled.set(recovery.childSessionID, idle.id)
              const assistant = messages.find(
                (message) =>
                  message.type === "assistant" && message.time.completed !== undefined && message.error === undefined,
              )
              return SubagentCompletion.text(assistant)
            }),
          })
          .pipe(Effect.setContext(context)),
      background: Effect.fn("SubagentJob.background")(function* (recovery: Recovery) {
        const info = yield* jobs.background(recovery.childSessionID)
        if (info) yield* notify(recovery, info.started_at)
      }),
      notify,
    })
  },
)

export const node: LayerNode.Provider<Service, never, typeof Node.tags.values.global> = Node.makeGlobalNode({
  service: Service,
  layer: Layer.effect(Service, make),
  deps: [Session.node, Job.node, Bus.node],
})
