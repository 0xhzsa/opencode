import fs from "node:fs/promises"
import path from "node:path"
import { expect } from "bun:test"
import { Voice } from "@opencode/core/voice"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Effect, Layer, Option } from "effect"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"
import { ServerAuth } from "../src/auth"

const auth = { username: "opencode", password: Option.some("test-password") }
const authorization = (token = ServerAuth.issueSession(auth)) =>
  `Basic ${Buffer.from(`opencode:${token}`).toString("base64")}`

const voice = makeLocationNode({
  service: Voice.Service,
  layer: Layer.sync(Voice.Service, () => {
    const owners = new Map<string, string>()
    return Voice.Service.of({
      models: () =>
        Effect.succeed({
          models: [
            { model: "gpt-live-1", provider: "openai", transports: ["webrtc"], available: true },
            { model: "gpt-realtime-2.1", provider: "openai", transports: ["webrtc", "websocket"], available: true },
            { model: "grok-voice-3.0", provider: "xai", transports: ["websocket"], available: false },
            { model: "gemini-3.8-live", provider: "google", transports: ["websocket"], available: false },
          ],
          default: "gpt-live-1",
        }),
      session: (input, caller) => {
        if (input.model === "invalid")
          return Effect.fail(new Voice.InvalidRequestError({ message: "Unsupported voice model" }))
        if (input.model === "unavailable")
          return Effect.fail(new Voice.UnavailableError({ message: "OpenAI API key is required", service: "openai" }))
        owners.set("call-test", caller)
        return Effect.succeed({
          route: { type: "key" as const },
          call: { id: "call-test" },
          transport:
            input.transport.type === "webrtc"
              ? { type: "webrtc" as const, sdp: `answer:${input.model}:${input.transport.sdp}` }
              : {
                  type: "websocket" as const,
                  url: `wss://api.x.ai/v1/realtime?model=${input.model}`,
                  token: "ek_test",
                  expiresAt: 1760000000,
                },
        })
      },
      instructions: (input, caller) =>
        owners.get(input.id) === caller
          ? Effect.void
          : Effect.fail(new Voice.ForbiddenError({ message: "This voice call does not belong to this pairing" })),
    })
  }),
  deps: [],
})

it.live("routes experimental voice models and session endpoints", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-voice-endpoint-")))
    const global = path.join(tmp.path, "global")
    yield* Effect.promise(() => fs.mkdir(global))
    const handler = yield* ServerFetch.make(
      {
        database: { path: ":memory:" },
        config: { directory: global },
        fs: { filewatcher: false },
        models: { fetch: false },
        password: "test-password",
      },
      { overrides: [Voice.node.replace(voice)] },
    )
    const owner = authorization()
    const modelsRes = yield* Effect.promise(() =>
      handler(
        new Request("http://opencode.local/api/experimental/voice/models", { headers: { authorization: owner } }),
      ),
    )
    expect(modelsRes.status).toBe(200)
    expect(yield* Effect.promise(() => modelsRes.json())).toEqual({
      data: {
        models: [
          { model: "gpt-live-1", provider: "openai", transports: ["webrtc"], available: true },
          { model: "gpt-realtime-2.1", provider: "openai", transports: ["webrtc", "websocket"], available: true },
          { model: "grok-voice-3.0", provider: "xai", transports: ["websocket"], available: false },
          { model: "gemini-3.8-live", provider: "google", transports: ["websocket"], available: false },
        ],
        default: "gpt-live-1",
      },
    })

    const post = (body: unknown, token: string | undefined = owner, endpoint = "session") =>
      Effect.promise(() =>
        handler(
          new Request(`http://opencode.local/api/experimental/voice/${endpoint}`, {
            method: "POST",
            headers: { "content-type": "application/json", ...(token ? { authorization: token } : {}) },
            body: JSON.stringify(body),
          }),
        ),
      )

    const rtcRes = yield* post({
      model: "gpt-live-1",
      session: { voice: "marin" },
      transport: { type: "webrtc", sdp: "v=0", dcid: 4 },
    })
    expect(rtcRes.status).toBe(200)
    expect(yield* Effect.promise(() => rtcRes.json())).toEqual({
      data: {
        transport: { type: "webrtc", sdp: "answer:gpt-live-1:v=0" },
        route: { type: "key" },
        call: { id: "call-test" },
      },
    })

    const wsRes = yield* post({ model: "grok-voice-3.0", transport: { type: "websocket" } })
    expect(wsRes.status).toBe(200)
    expect(yield* Effect.promise(() => wsRes.json())).toEqual({
      data: {
        route: { type: "key" },
        call: { id: "call-test" },
        transport: {
          type: "websocket",
          url: "wss://api.x.ai/v1/realtime?model=grok-voice-3.0",
          token: "ek_test",
          expiresAt: 1760000000,
        },
      },
    })

    expect((yield* post({ model: "invalid", transport: { type: "websocket" } })).status).toBe(400)
    expect((yield* post({ model: "unavailable", transport: { type: "websocket" } })).status).toBe(503)
    const update = { instructions: "New instructions" }
    expect((yield* post(update, owner, "session/call-test/instructions")).status).toBe(200)
    expect((yield* post(update, authorization(), "session/call-test/instructions")).status).toBe(403)
    expect((yield* post(update, owner, "session/unknown/instructions")).status).toBe(403)
    expect((yield* post(update, "", "session/call-test/instructions")).status).toBe(401)
    expect((yield* post(update, authorization("test-password"), "session/call-test/instructions")).status).toBe(401)
    expect((yield* post({ model: "gpt-live-1", transport: { type: "webrtc", sdp: "offer" } }, "")).status).toBe(401)
    expect((yield* post({ instructions: "" }, owner, "session/call-test/instructions")).status).toBe(400)
    const noAuth = yield* Effect.promise(() =>
      handler(new Request("http://opencode.local/api/experimental/voice/models")),
    )
    expect(noAuth.status).toBe(401)
    const cookie = `${ServerAuth.sessionCookieName("opencode.local")}=${ServerAuth.issueSession(auth)}`
    const cookieModels = (origin: string) =>
      Effect.promise(() =>
        handler(
          new Request("http://opencode.local/api/experimental/voice/models", {
            headers: { host: "opencode.local", cookie, origin },
          }),
        ),
      )
    expect((yield* cookieModels("http://opencode.local")).status).toBe(200)
    expect((yield* cookieModels("http://other.local")).status).toBe(401)
  }),
)

it.live("requires pairing for voice even when general server authentication is disabled", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-voice-auth-")))
    const handler = yield* ServerFetch.make(
      {
        database: { path: ":memory:" },
        config: { directory: tmp.path },
        fs: { filewatcher: false },
        models: { fetch: false },
      },
      { overrides: [Voice.node.replace(voice)] },
    )
    const response = yield* Effect.promise(() =>
      handler(
        new Request("http://opencode.local/api/experimental/voice/session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "gpt-live-1", transport: { type: "webrtc", sdp: "offer" } }),
        }),
      ),
    )
    expect(response.status).toBe(401)
  }),
)
