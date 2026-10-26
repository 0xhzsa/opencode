export * as GoalPlugin from "./goal.js"

import { define } from "@opencode/plugin/effect/plugin"
import type { SessionIdleBackground } from "@opencode/plugin/effect/session"
import type { Session } from "@opencode/schema/session"
import type { SessionEvent } from "@opencode/schema/session-event"
import { SessionGoal } from "@opencode/schema/session-goal"
import { Cause, Clock, Effect, Option, Schema, Stream } from "effect"
import CONTINUATION from "./goal/continuation.txt"
import JUDGE from "./goal/judge.txt"
import KICKOFF from "./goal/kickoff.txt"

export const MAX_OBJECTIVE = 4_000
export const MAX_ROUNDS = 20
// Identifies this server process. A goal armed by an earlier process comes back paused instead of resuming on its own.
const boot = crypto.randomUUID()

type State = SessionGoal.State

const Verdict = Schema.Struct({
  verdict: Schema.Literals(["done", "continue", "blocked", "paused", "wait"]),
  reason: Schema.String,
  next_step: Schema.optionalKey(Schema.String),
})
type Verdict = typeof Verdict.Type
const decodeVerdict = Schema.decodeUnknownOption(Schema.fromJsonString(Verdict))

const USAGE = "Usage: /goal <objective> | pause | resume | clear"

export const Plugin = define({
  id: "opencode.goal",
  effect: Effect.fn(function* (ctx) {
    const read = Effect.fn("GoalPlugin.read")(function* (sessionID: Session.ID) {
      return SessionGoal.fromMetadata(sessionID, (yield* ctx.session.get({ sessionID })).metadata)
    })

    // Metadata updates replace the whole record, so keep the keys other writers own.
    const write = Effect.fn("GoalPlugin.write")(function* (sessionID: Session.ID, goal: State | undefined) {
      const metadata = (yield* ctx.session.get({ sessionID })).metadata ?? {}
      const others = Object.fromEntries(Object.entries(metadata).filter(([key]) => key !== SessionGoal.KEY))
      yield* ctx.session.update({ sessionID, metadata: goal ? { ...others, [SessionGoal.KEY]: goal } : others })
    })

    const settle = Effect.fn("GoalPlugin.settle")(function* (
      sessionID: Session.ID,
      goal: State,
      status: "paused" | "complete",
      reason: string,
    ) {
      yield* write(sessionID, { ...goal, status, reason, updatedAt: yield* Clock.currentTimeMillis })
    })

    const pauseActive = (sessionID: Session.ID, reason: string) =>
      read(sessionID).pipe(
        Effect.flatMap((goal) => (goal?.status === "active" ? settle(sessionID, goal, "paused", reason) : Effect.void)),
      )

    const judge = Effect.fn("GoalPlugin.judge")(function* (
      sessionID: Session.ID,
      goal: State,
      background: ReadonlyArray<SessionIdleBackground>,
    ) {
      const shells = background.flatMap((work) => (work.kind === "shell" ? [work.command] : []))
      const prompt = render(JUDGE, {
        objective: escape(goal.objective),
        background:
          shells.length === 0
            ? "No background shells are running."
            : [
                "Background shells still running:",
                ...shells.map((command) => `- ${command}`),
                "",
                'Answer "wait" only when the goal needs the result of one of these shells. Never wait for a long-running server such as a dev server.',
              ].join("\n"),
        wait:
          shells.length === 0 ? "" : '{"verdict":"wait","reason":"<the running shell whose result the goal needs>"}\n',
      })
      const attempt = ctx.session
        .generate({ sessionID, prompt })
        .pipe(Effect.map((result) => parseVerdict(result.text)))
      const first = yield* attempt
      if (first !== undefined) return first
      return yield* attempt
    })

    // Stop-hook style loop: the runner fires this only once the Session would go idle with nothing pending, and input
    // admitted here continues the same execution.
    const idle = Effect.fn("GoalPlugin.idle")(function* (
      sessionID: Session.ID,
      background: ReadonlyArray<SessionIdleBackground>,
    ) {
      const goal = yield* read(sessionID)
      if (goal?.status !== "active") return
      if (goal.boot !== boot)
        return yield* settle(sessionID, goal, "paused", "The server restarted while the goal was active")
      // A running subagent's result wakes the Session, and the hook runs again then.
      if (background.some((work) => work.kind === "subagent")) return
      if (goal.rounds >= goal.maxRounds)
        return yield* settle(sessionID, goal, "paused", `Reached the limit of ${goal.maxRounds} rounds`)

      const verdict = yield* judge(sessionID, goal, background)
      // `/goal pause`, `clear` or a new goal may have landed while the reviewer ran.
      const latest = yield* read(sessionID)
      if (latest?.id !== goal.id || latest.status !== "active") return
      if (verdict === undefined)
        return yield* settle(sessionID, latest, "paused", "The goal reviewer gave no usable verdict")
      if (verdict.verdict === "wait" && background.length > 0) return
      if (verdict.verdict === "done") return yield* settle(sessionID, latest, "complete", verdict.reason)
      if (verdict.verdict !== "continue") return yield* settle(sessionID, latest, "paused", verdict.reason)

      const next = {
        ...latest,
        rounds: latest.rounds + 1,
        reason: verdict.reason,
        updatedAt: yield* Clock.currentTimeMillis,
      }
      yield* write(sessionID, next)
      yield* ctx.session.synthetic({
        sessionID,
        text: continuation(next, [verdict.reason, verdict.next_step && `Next step: ${verdict.next_step}`]),
        description: `Continuing goal (${next.rounds}/${next.maxRounds})`,
        metadata: { source: "goal", goalID: next.id },
      })
    })

    yield* ctx.session.hook("idle", (event) =>
      idle(event.sessionID, event.background).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning("goal continuation failed", { sessionID: event.sessionID, cause }).pipe(
                Effect.andThen(pauseActive(event.sessionID, "The goal stopped after an error")),
                Effect.catchCause(() => Effect.void),
              ),
        ),
      ),
    )

    yield* ctx.event.subscribe().pipe(
      Stream.filter(
        (event): event is SessionEvent.Execution.Interrupted | SessionEvent.Execution.Failed =>
          event.type === "session.execution.interrupted" || event.type === "session.execution.failed",
      ),
      Stream.runForEach((event) => {
        // Shutdown keeps the goal active; the next process sees the boot change and pauses it.
        if (event.type === "session.execution.interrupted" && event.data.reason !== "user") return Effect.void
        const reason =
          event.type === "session.execution.failed"
            ? `The session failed: ${event.data.error.message}`
            : "Stopped by the user"
        return pauseActive(event.data.sessionID, reason).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("failed to pause goal", { sessionID: event.data.sessionID, cause }),
          ),
        )
      }),
      Effect.forkScoped({ startImmediately: true }),
    )

    yield* ctx.command.transform((editor) => {
      editor.add({
        name: "goal",
        description: "keep working until an objective is met [pause|resume|clear]",
        execute: (input) =>
          Effect.gen(function* () {
            const text = unquote(input.prompt.text.trim())
            const control = text.toLowerCase()
            const goal = yield* read(input.sessionID)
            if (text === "") return yield* Effect.fail(new Error(goal ? `${describe(goal)}\n${USAGE}` : USAGE))

            if (control === "pause") {
              if (goal?.status !== "active") return yield* Effect.fail(new Error("No active goal to pause."))
              return yield* settle(input.sessionID, goal, "paused", "Paused by the user")
            }
            if (control === "resume") {
              if (goal?.status !== "paused") return yield* Effect.fail(new Error("No paused goal to resume."))
              const resumed: State = {
                id: goal.id,
                sessionID: goal.sessionID,
                objective: goal.objective,
                status: "active",
                // The resume continuation is the first round of the new budget.
                rounds: 1,
                maxRounds: goal.maxRounds,
                boot,
                updatedAt: yield* Clock.currentTimeMillis,
              }
              yield* write(input.sessionID, resumed)
              return yield* ctx.session.synthetic({
                sessionID: input.sessionID,
                text: continuation(resumed, ["The user resumed the goal."]),
                description: "Resuming goal",
                metadata: { source: "goal", goalID: resumed.id },
              })
            }
            if (control === "clear") {
              if (!goal) return yield* Effect.fail(new Error("No goal is set."))
              return yield* write(input.sessionID, undefined)
            }

            if (text.length > MAX_OBJECTIVE)
              return yield* Effect.fail(
                new Error(`A goal objective is limited to ${MAX_OBJECTIVE} characters (got ${text.length}).`),
              )
            const created: State = {
              id: crypto.randomUUID(),
              sessionID: input.sessionID,
              objective: text,
              status: "active",
              rounds: 0,
              maxRounds: MAX_ROUNDS,
              boot,
              updatedAt: yield* Clock.currentTimeMillis,
            }
            yield* write(input.sessionID, created)
            const kickoff = render(KICKOFF, { objective: escape(text) })
            const metadata = { source: "goal", goalID: created.id }
            const attached = [input.prompt.files, input.prompt.agents, input.prompt.skills].some(
              (items) => items !== undefined && items.length > 0,
            )
            // Timelines show a described synthetic message as one notice row instead of the whole kickoff. Only a
            // prompt can carry attachments, so those still go through as the user's message.
            if (attached)
              return yield* ctx.session.prompt({
                ...input.prompt,
                sessionID: input.sessionID,
                text: kickoff,
                metadata,
                delivery: input.delivery,
              })
            yield* ctx.session.synthetic({
              sessionID: input.sessionID,
              text: kickoff,
              description: `Goal: ${text.length > 120 ? `${text.slice(0, 119)}…` : text}`,
              metadata,
              delivery: input.delivery,
            })
          }).pipe(Effect.asVoid),
      })
    })
  }),
})

function continuation(goal: State, feedback: ReadonlyArray<string | undefined>) {
  return render(CONTINUATION, {
    round: String(goal.rounds),
    limit: String(goal.maxRounds),
    objective: escape(goal.objective),
    feedback: feedback.filter(Boolean).join("\n"),
  })
}

function describe(goal: State) {
  const status =
    goal.status === "active"
      ? `Goal active (round ${goal.rounds} of ${goal.maxRounds})`
      : goal.status === "paused"
        ? "Goal paused"
        : "Goal achieved"
  return [`${status}: ${goal.objective}`, goal.reason].filter(Boolean).join("\n")
}

// Reviewers sometimes wrap the JSON in a code fence or add a sentence around it.
function parseVerdict(text: string): Verdict | undefined {
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start === -1 || end < start) return undefined
  return Option.getOrUndefined(decodeVerdict(text.slice(start, end + 1)))
}

// `/goal "Ship the release"` and `/goal Ship the release` set the same objective.
function unquote(text: string) {
  const quoted = /^(["'“‘])([\s\S]*)(["'”’])$/.exec(text)
  if (!quoted) return text
  const pairs: Record<string, string> = { '"': '"', "'": "'", "“": "”", "‘": "’" }
  return pairs[quoted[1] ?? ""] === quoted[3] ? (quoted[2] ?? "").trim() : text
}

// One pass, so an objective that contains a placeholder is not expanded again.
function render(template: string, values: Record<string, string>) {
  return template.replace(/\$\{(\w+)\}/g, (match, key: string) => values[key] ?? match)
}

function escape(text: string) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}
