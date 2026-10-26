import { describe, expect } from "bun:test"
import path from "path"
import { pathToFileURL } from "url"
import { Deferred, Effect, Layer, Option, Schedule, Schema, Stream } from "effect"
import { LanguageModel, type LLMRequest } from "@opencode/ai/effect"
import { OpenAIChat } from "@opencode/ai/protocols/openai-chat"
import { TestLLM } from "@opencode/ai/testing"
import { Agent } from "@opencode/core/agent"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode/core/effect/app-node-platform"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { Job } from "@opencode/core/job"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { Model } from "@opencode/core/model"
import { Provider } from "@opencode/core/provider"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { SessionGoal } from "@opencode/schema/session-goal"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { tempGlobalLayer } from "../fixture/global"
import { offlineModels } from "../fixture/models"
import { tmpdirScoped } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const llmLayer = TestLLM.testLayer({ fallback: TestLLM.text("Working on it", "work") })
const it = testEffect(
  Layer.merge(
    llmLayer,
    AppNodeBuilder.build(LayerNode.group([Session.node, LocationServiceMap.node, Job.node]), [
      Global.node.replace(tempGlobalLayer),
      offlineModels,
      Watcher.node.replace(Watcher.configured({ enabled: false })),
      LayerNodePlatform.llmClient.replace(llmLayer),
      SessionRunnerModel.node.replace(
        Layer.succeed(SessionRunnerModel.Service, {
          resolve: () =>
            Effect.succeed(
              SessionRunnerModel.resolved(
                LanguageModel.make({ id: "goal", provider: "test", route: OpenAIChat.route }),
                {
                  capabilities: { tools: true, input: ["text"], output: ["text"] },
                  cost: [],
                  limit: { context: 200_000, output: 32_000 },
                },
              ),
            ),
        }),
      ),
    ]),
  ),
)

const model = Model.Ref.make({ id: Model.ID.make("goal"), providerID: Provider.ID.make("test") })

describe("goal plugin", () => {
  it.live("keeps working in one execution until the reviewer finds the goal met", () =>
    Effect.gen(function* () {
      const session = yield* project()
      const sessions = yield* Session.Service
      const verdicts = reviewer(
        '{"verdict":"continue","reason":"The parser test still fails.","next_step":"Fix the date parser."}',
        '```json\n{"verdict":"done","reason":"All 12 tests pass."}\n```',
      )
      yield* serve(verdicts.respond)

      yield* sessions.command({ sessionID: session.id, command: "goal", text: "  Make the test suite pass  " })
      yield* sessions.wait(session.id)

      expect(verdicts.asked()).toBe(2)
      expect(yield* goal(session.id)).toMatchObject({
        sessionID: session.id,
        objective: "Make the test suite pass",
        status: "complete",
        reason: "All 12 tests pass.",
        rounds: 1,
      })
      const messages = yield* sessions.messages({ sessionID: session.id, order: "asc" })
      // The kickoff is a notice, so timelines show the objective rather than the whole template.
      expect(messages.filter((message) => message.type === "user")).toEqual([])
      const notices = messages.filter((message) => message.type === "synthetic")
      expect(notices).toMatchObject([
        { description: "Goal: Make the test suite pass", metadata: { source: "goal", goalID: expect.any(String) } },
        { description: "Continuing goal (1/20)", metadata: { source: "goal", goalID: expect.any(String) } },
      ])
      expect(notices[0]?.type === "synthetic" && notices[0].text).toContain(
        "<untrusted_objective>\nMake the test suite pass\n</untrusted_objective>",
      )
      expect(notices[1]?.type === "synthetic" && notices[1].text).toContain(
        "The parser test still fails.\nNext step: Fix the date parser.",
      )
      // Continuations run inside the same execution, so the Session went idle once.
      expect(messages.filter((message) => message.type === "idle")).toMatchObject([{ outcome: "succeeded" }])
    }),
  )

  it.live("pauses when the reviewer reports a blocker", () =>
    Effect.gen(function* () {
      const session = yield* project()
      const sessions = yield* Session.Service
      yield* serve(reviewer('{"verdict":"blocked","reason":"It needs the production API key."}').respond)

      yield* sessions.command({ sessionID: session.id, command: "goal", text: "Deploy the service" })
      yield* sessions.wait(session.id)

      expect(yield* goal(session.id)).toMatchObject({ status: "paused", reason: "It needs the production API key." })
    }),
  )

  it.live("pauses when the reviewer gives no usable verdict twice", () =>
    Effect.gen(function* () {
      const session = yield* project()
      const sessions = yield* Session.Service
      const verdicts = reviewer("Looks good to me.", "I think so.")
      yield* serve(verdicts.respond)

      yield* sessions.command({ sessionID: session.id, command: "goal", text: "Ship it" })
      yield* sessions.wait(session.id)

      expect(verdicts.asked()).toBe(2)
      expect(yield* goal(session.id)).toMatchObject({
        status: "paused",
        reason: "The goal reviewer gave no usable verdict",
      })
    }),
  )

  it.live("waits for a background subagent instead of judging", () =>
    Effect.gen(function* () {
      const session = yield* project()
      const sessions = yield* Session.Service
      const jobs = yield* Job.Service
      const child = yield* sessions.create({ parentID: session.id, title: "Explore", agent: Agent.ID.make("build") })
      const done = yield* Deferred.make<string>()
      yield* jobs.start({
        id: child.id,
        type: "subagent",
        recovery: {
          kind: "subagent",
          parentSessionID: session.id,
          childSessionID: child.id,
          agent: "explore",
          description: "Explore",
        },
        run: Deferred.await(done),
      })
      yield* jobs.background(child.id)
      const verdicts = reviewer('{"verdict":"done","reason":"The report is written."}')
      yield* serve(verdicts.respond)

      yield* sessions.command({ sessionID: session.id, command: "goal", text: "Write the report" })
      yield* sessions.wait(session.id)
      expect(verdicts.asked()).toBe(0)
      expect(yield* goal(session.id)).toMatchObject({ status: "active", rounds: 0 })

      // The subagent's notice wakes the Session, and the reviewer runs once nothing is outstanding.
      yield* Deferred.succeed(done, "Found everything")
      yield* jobs.wait({ id: child.id })
      yield* sessions.synthetic({ sessionID: session.id, text: "Subagent finished" })
      yield* sessions.wait(session.id)
      expect(verdicts.asked()).toBe(1)
      expect(yield* goal(session.id)).toMatchObject({ status: "complete" })
    }),
  )

  it.live("drops the reviewer's verdict when the goal is paused while it runs", () =>
    Effect.gen(function* () {
      const session = yield* project()
      const sessions = yield* Session.Service
      const judging = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      yield* serve((request) =>
        isReview(request)
          ? Stream.fromEffect(Deferred.succeed(judging, undefined).pipe(Effect.andThen(Deferred.await(release)))).pipe(
              Stream.flatMap(() =>
                Stream.fromIterable(TestLLM.text('{"verdict":"continue","reason":"More to do."}', "review")),
              ),
            )
          : TestLLM.text("Working on it", "work"),
      )

      yield* sessions.command({ sessionID: session.id, command: "goal", text: "Rename the module" })
      yield* Deferred.await(judging)
      yield* sessions.command({ sessionID: session.id, command: "goal", text: "pause" })
      yield* Deferred.succeed(release, undefined)
      yield* sessions.wait(session.id)

      expect(yield* goal(session.id)).toMatchObject({ status: "paused", reason: "Paused by the user", rounds: 0 })
      expect(
        (yield* sessions.messages({ sessionID: session.id, order: "asc" })).flatMap((message) =>
          message.type === "synthetic" ? [message.description] : [],
        ),
      ).toEqual(["Goal: Rename the module"])
    }),
  )

  it.live("pauses an active goal when the user stops the session", () =>
    Effect.gen(function* () {
      const session = yield* project()
      const sessions = yield* Session.Service
      const llm = yield* TestLLM.Test
      const gate = yield* llm.gate()

      yield* sessions.command({ sessionID: session.id, command: "goal", text: "Refactor the store" })
      yield* gate.started
      yield* sessions.interrupt(session.id)
      yield* sessions.wait(session.id)

      expect(yield* eventually(goal(session.id), (state) => state?.status === "paused")).toMatchObject({
        reason: "Stopped by the user",
      })
    }),
  )

  it.live("pauses a goal set by an earlier server process instead of continuing it", () =>
    Effect.gen(function* () {
      const session = yield* project()
      const sessions = yield* Session.Service
      const verdicts = reviewer('{"verdict":"continue","reason":"Not yet."}')
      yield* serve(verdicts.respond)
      yield* sessions.setMetadata({
        sessionID: session.id,
        metadata: {
          [SessionGoal.KEY]: {
            id: "goal-earlier",
            sessionID: session.id,
            objective: "Migrate the database",
            status: "active",
            rounds: 3,
            maxRounds: 20,
            boot: "an-earlier-process",
            updatedAt: 0,
          },
        },
      })

      yield* sessions.prompt({ sessionID: session.id, text: "Server came back" })
      yield* sessions.wait(session.id)

      expect(verdicts.asked()).toBe(0)
      expect(yield* goal(session.id)).toMatchObject({
        status: "paused",
        reason: "The server restarted while the goal was active",
      })
    }),
  )

  it.live("ignores the goal a child session inherits from its parent", () =>
    Effect.gen(function* () {
      const session = yield* project()
      const sessions = yield* Session.Service
      const llm = yield* TestLLM.Test
      const verdicts = reviewer('{"verdict":"blocked","reason":"Waiting on the user."}')
      yield* serve(verdicts.respond)
      const gate = yield* llm.gate()
      yield* sessions.command({ sessionID: session.id, command: "goal", text: "Tidy the docs" })
      yield* gate.started
      // Created while the parent's goal is active, so the child copies an active goal.
      const child = yield* sessions.create({ parentID: session.id, title: "Helper", agent: Agent.ID.make("build") })
      yield* gate.release
      yield* sessions.wait(session.id)
      expect(verdicts.asked()).toBe(1)

      expect(
        Option.getOrUndefined(decodeGoal((yield* sessions.get(child.id)).metadata?.[SessionGoal.KEY])),
      ).toMatchObject({ sessionID: session.id, status: "active" })
      yield* sessions.prompt({ sessionID: child.id, text: "Help out" })
      yield* sessions.wait(child.id)

      expect(verdicts.asked()).toBe(1)
    }),
  )

  it.live("sets the objective inside quotes", () =>
    Effect.gen(function* () {
      const session = yield* project()
      const sessions = yield* Session.Service
      yield* serve(reviewer('{"verdict":"done","reason":"Released."}').respond)

      yield* sessions.command({ sessionID: session.id, command: "goal", text: '"Ship the release"' })
      yield* sessions.wait(session.id)

      expect(yield* goal(session.id)).toMatchObject({ objective: "Ship the release", status: "complete" })
    }),
  )

  it.live("sends the kickoff as the user's message when the goal has attachments", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const file = path.join(tmp.path, "spec.md")
      yield* Effect.promise(() => Bun.write(file, "# Spec"))
      const session = yield* project()
      const sessions = yield* Session.Service
      yield* serve(reviewer('{"verdict":"done","reason":"Implemented."}').respond)

      yield* sessions.command({
        sessionID: session.id,
        command: "goal",
        text: "Implement the spec",
        files: [{ uri: pathToFileURL(file).href, name: "spec.md" }],
      })
      yield* sessions.wait(session.id)

      const messages = yield* sessions.messages({ sessionID: session.id, order: "asc" })
      expect(messages.filter((message) => message.type === "user")).toMatchObject([
        { metadata: { source: "goal" }, files: [{ name: "spec.md" }] },
      ])
      expect(messages.filter((message) => message.type === "synthetic")).toEqual([])
    }),
  )

  it.live("pauses, resumes and clears a goal through its subcommands", () =>
    Effect.gen(function* () {
      const session = yield* project()
      const sessions = yield* Session.Service
      const verdicts = reviewer(
        '{"verdict":"paused","reason":"The user asked to stop for now."}',
        '{"verdict":"done","reason":"The changelog lists every PR."}',
      )
      yield* serve(verdicts.respond)

      yield* sessions.command({ sessionID: session.id, command: "goal", text: "Update the changelog" })
      yield* sessions.wait(session.id)
      expect(yield* goal(session.id)).toMatchObject({ status: "paused", reason: "The user asked to stop for now." })
      const paused = yield* sessions
        .command({ sessionID: session.id, command: "goal", text: "pause" })
        .pipe(Effect.exit)
      expect(paused._tag).toBe("Failure")

      yield* sessions.command({ sessionID: session.id, command: "goal", text: "Resume" })
      expect(yield* goal(session.id)).toMatchObject({ status: "active", rounds: 1 })
      yield* sessions.wait(session.id)
      expect(yield* goal(session.id)).toMatchObject({ status: "complete", rounds: 1 })
      const resumed = (yield* sessions.messages({ sessionID: session.id, order: "asc" })).filter(
        (message) => message.type === "synthetic",
      )
      expect(resumed).toMatchObject([{ description: "Goal: Update the changelog" }, { description: "Resuming goal" }])

      yield* sessions.command({ sessionID: session.id, command: "goal", text: "clear" })
      expect(yield* goal(session.id)).toBeUndefined()
      expect((yield* sessions.get(session.id)).metadata).toEqual({})
    }),
  )
})

const REVIEW_MARKER = "You are now the reviewer for the session's goal"

// Answers reviewer requests from a script and every other request as ordinary assistant work.
function reviewer(...replies: ReadonlyArray<string>) {
  const queue = [...replies]
  const asked = { count: 0 }
  return {
    asked: () => asked.count,
    respond: (request: LLMRequest) => {
      if (!isReview(request)) return TestLLM.text("Working on it", "work")
      asked.count++
      return TestLLM.text(queue.shift() ?? '{"verdict":"done","reason":"Out of script."}', `review-${asked.count}`)
    },
  }
}

function isReview(request: LLMRequest) {
  return JSON.stringify(request.messages.at(-1)).includes(REVIEW_MARKER)
}

function serve(respond: (request: LLMRequest) => TestLLM.Response) {
  return TestLLM.Test.use((llm) => llm.serve(respond))
}

const decodeGoal = Schema.decodeUnknownOption(SessionGoal.State)

function goal(sessionID: Session.ID) {
  return Session.Service.use((sessions) => sessions.get(sessionID)).pipe(
    Effect.map((session) => Option.getOrUndefined(decodeGoal(session.metadata?.[SessionGoal.KEY]))),
  )
}

// The interrupt watcher reacts to the bus stream, after the interrupted execution has settled.
function eventually<A, R>(effect: Effect.Effect<A, unknown, R>, done: (value: A) => boolean) {
  return effect.pipe(
    Effect.repeat({ until: done, schedule: Schedule.spaced("10 millis") }),
    Effect.timeout("10 seconds"),
    Effect.orDie,
  )
}

function project() {
  return Effect.gen(function* () {
    const tmp = yield* tmpdirScoped()
    const sessions = yield* Session.Service
    return yield* sessions.create({
      location: { directory: AbsolutePath.make(tmp.path) },
      title: "Goal session",
      agent: Agent.ID.make("build"),
      model,
    })
  })
}
