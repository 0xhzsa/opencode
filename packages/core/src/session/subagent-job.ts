export * as SubagentJob from "./subagent-job.js"

import { Context, Effect, Layer, Scope, Stream } from "effect"
import { Node } from "@opencode/util/effect/app-node"
import type { LayerNode } from "@opencode/util/effect/layer-node"
import { Bus } from "../bus.js"
import { Job } from "../job.js"
import { Session } from "../session.js"
import { SessionEvent } from "./event.js"
import type { SessionMessage } from "./message.js"
import type { SessionSchema } from "./schema.js"
import { SubagentCompletion } from "./subagent-completion.js"

type Recovery = Extract<Job.Recovery, { kind: "subagent" }>

/**
 * A child the subagent tool has run. `tracked` is set while a Job generation owns its
 * execution; `reported` is the idle marker of the last busy period the parent heard about.
 */
type Watch = {
  recovery: Recovery
  tracked: boolean
  reported?: SessionMessage.ID
}

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

    const notify = Effect.fn("SubagentJob.notify")(function* (recovery: Recovery, startedAt: number) {
      const key = `${recovery.childSessionID}:${startedAt}`
      if (notifications.has(key)) return
      notifications.add(key)
      yield* Effect.gen(function* () {
        const info = (yield* jobs.wait({ id: recovery.childSessionID })).info
        if (info) yield* SubagentCompletion.deliver(sessions, jobs, { ...info, recovery })
      }).pipe(
        Effect.ensuring(Effect.sync(() => notifications.delete(key))),
        Effect.forkIn(scope, { startImmediately: true }),
        Effect.setContext(context),
      )
    })

    // The newest busy period of a child, read back to the idle marker that precedes it.
    const latestTurn = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
      let idle: Extract<SessionMessage.Info, { type: "idle" }> | undefined
      let assistant: SessionMessage.Info | undefined
      let prompted = false
      let cursor: { id: SessionMessage.ID; direction: "next" } | undefined
      while (true) {
        const page = yield* sessions.messages({ sessionID, order: "desc", limit: TURN_PAGE, cursor })
        for (const message of page) {
          if (message.type === "idle") {
            if (idle) return { idle, assistant, prompted }
            idle = message
            continue
          }
          // Work recorded after the newest idle marker means a newer busy period is running.
          if (!idle) return undefined
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
        if (page.length < TURN_PAGE || !last) return idle ? { idle, assistant, prompted } : undefined
        cursor = { id: last.id, direction: "next" }
      }
    })

    // A child can start a new busy period without the subagent tool: a plugin continuing an
    // empty step, or a background shell or nested subagent result arriving after the child
    // went idle. Its parent already heard about the previous busy period, so report this one too.
    // Turns that contain a user prompt are a conversation someone else started with the child.
    const followUp = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
      const watch = watches.get(sessionID)
      if (!watch || watch.tracked) return
      const turn = yield* latestTurn(sessionID)
      if (!turn || turn.idle.id === watch.reported || watch.tracked) return
      watch.reported = turn.idle.id
      if (turn.prompted) return
      yield* SubagentCompletion.deliver(sessions, jobs, {
        recovery: watch.recovery,
        ...(turn.idle.outcome === "succeeded"
          ? { status: "completed" as const, output: SubagentCompletion.text(turn.assistant) }
          : turn.idle.outcome === "failed"
            ? { status: "error" as const, error: turn.idle.error?.message ?? "Subagent failed" }
            : { status: "cancelled" as const }),
      })
    })

    yield* bus
      .subscribe([SessionEvent.Execution.Succeeded, SessionEvent.Execution.Failed, SessionEvent.Execution.Interrupted])
      .pipe(
        Stream.runForEach((event) =>
          followUp(event.data.sessionID).pipe(
            Effect.catchTag("Session.NotFoundError", () => Effect.sync(() => watches.delete(event.data.sessionID))),
            Effect.catchCause((cause) =>
              Effect.logError("Failed to report subagent continuation", cause).pipe(
                Effect.annotateLogs({ sessionID: event.data.sessionID }),
              ),
            ),
          ),
        ),
        Effect.forkIn(scope, { startImmediately: true }),
      )

    return Service.of({
      start: (recovery: Recovery) => {
        const watch = watches.get(recovery.childSessionID) ?? { recovery, tracked: true }
        watch.recovery = recovery
        watch.tracked = true
        watches.set(recovery.childSessionID, watch)
        return jobs
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
              const assistant = messages.find(
                (message) =>
                  message.type === "assistant" && message.time.completed !== undefined && message.error === undefined,
              )
              return SubagentCompletion.text(assistant)
            }).pipe(
              // This generation reports its own busy period, whichever way it ends.
              Effect.ensuring(
                sessions.messages({ sessionID: recovery.childSessionID, type: "idle", order: "desc", limit: 1 }).pipe(
                  Effect.map(([idle]) => {
                    if (idle) watch.reported = idle.id
                  }),
                  Effect.ignore,
                  Effect.ensuring(Effect.sync(() => (watch.tracked = false))),
                ),
              ),
            ),
          })
          .pipe(Effect.setContext(context))
      },
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
