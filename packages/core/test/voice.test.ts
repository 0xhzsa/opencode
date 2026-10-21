import { expect } from "bun:test"
import { RequestExecutor } from "@opencode/ai/route"
import { Credential } from "@opencode/core/credential"
import { Config } from "@opencode/core/config"
import { Document, Info } from "@opencode/schema/config"
import { Integration } from "@opencode/core/integration"
import { Voice } from "@opencode/core/voice"
import { VoiceCalls } from "@opencode/core/voice-calls"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { TestClock } from "effect/testing"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)
const voiceLayer = Voice.layer.pipe(Layer.provide(VoiceCalls.layer))

const consoleValue = Credential.OAuth.make({
  type: "oauth",
  methodID: Integration.MethodID.make("device"),
  access: "console-access",
  refresh: "console-refresh",
  expires: 1760000999_000,
  metadata: { orgID: "org-team", orgName: "Team", accountID: "user-one", server: "https://opencode.ai/console" },
})
const offer: Voice.SessionInput = {
  model: "gpt-live-1",
  session: { instructions: "Hello", model: "ignored" },
  transport: { type: "webrtc", sdp: "offer", dcid: 4 },
}
const consoleRoute: Voice.Route = { type: "console", workspace: { id: "org-team", name: "Team" } }

function consoleFixture(options: { key?: boolean; console?: boolean; preference?: "key" | "console" } = {}) {
  const state: { value: Credential.Value | undefined; status: number; fail: boolean } = {
    value: options.console === false ? undefined : consoleValue,
    status: 200,
    fail: false,
  }
  const requests: HttpClientRequest.HttpClientRequest[] = []
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        requests.push(request)
        return HttpClientResponse.fromWeb(
          request,
          state.status === 200
            ? request.url.endsWith("/instructions")
              ? Response.json({ ok: true })
              : Response.json({
                  session: { id: "call-one", secret: "not-returned" },
                  transport: { sdp: "answer" },
                  token: "not-returned",
                })
            : new Response("secret error body", { status: state.status }),
        )
      }),
    ),
  )
  const dependencies = Layer.mergeAll(
    http,
    RequestExecutor.layer.pipe(Layer.provide(http)),
    Config.testLayer(
      options.preference
        ? [
            new Document({
              type: "document",
              info: Info.make({ experimental: { voice: { route: options.preference } } }),
            }),
          ]
        : [],
    ),
    mockIntegration(
      (id) =>
        id === "opencode"
          ? state.value
            ? [credential("console", "oauth")]
            : []
          : id === "openai" && options.key
            ? [credential("active", "key")]
            : [],
      (connection) =>
        connection.type === "credential" && connection.id === "console"
          ? state.fail
            ? Effect.fail(new Integration.AuthorizationError({ cause: new Error("secret refresh failure") }))
            : Effect.succeed(state.value)
          : Effect.succeed(Credential.Key.make({ type: "key", key: "provider-key" })),
    ),
  )
  const local = Voice.layer.pipe(Layer.provide(dependencies))
  return { state, requests, local, layer: local.pipe(Layer.provide(VoiceCalls.layer)) }
}

const credential = (id: string, method: "key" | "oauth") => ({
  type: "credential" as const,
  id: Credential.ID.make(id),
  label: id,
  method,
})

const keys: Record<string, string> = {
  active: "sk-active",
  stored: "sk-stored",
  XAI_API_KEY: "xai-env-key",
  GEMINI_API_KEY: "gemini-env-key",
}

const unused = () => Effect.die("unused")

const mockIntegration = (
  connections: (id: Integration.ID) => Integration.Info["connections"],
  resolve: Integration.Interface["connection"]["resolve"] = () => Effect.die("Voice.models resolved a credential"),
) =>
  Layer.mock(Integration.Service, {
    revision: () => 0,
    get: (id) => Effect.succeed({ id, name: id, methods: [], connections: connections(id) }),
    connection: {
      active: (id) => Effect.succeed(connections(id)[0]),
      resolve,
      key: unused,
      external: unused,
      activate: unused,
      update: unused,
      remove: unused,
      status: unused,
    },
    oauth: { connect: unused, status: unused, complete: unused, cancel: unused },
    command: { connect: unused, status: unused, cancel: unused },
  })

it.effect("uses the first key or env connection Integration lists and never a ChatGPT sign-in", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(1760000000_000)
    const auths: string[] = []
    const call = (model: string, connections: Integration.Info["connections"]) =>
      Effect.flatMap(Voice.Service, (voice) =>
        voice.session(
          {
            model,
            transport:
              model.startsWith("grok-") || model.startsWith("gemini-")
                ? { type: "websocket" }
                : { type: "webrtc", sdp: "v=0" },
          },
          "phone",
        ),
      ).pipe(
        Effect.provide(
          voiceLayer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Config.testLayer(),
                Layer.succeed(
                  HttpClient.HttpClient,
                  HttpClient.make(() => Effect.die("Unexpected Console request")),
                ),
                mockIntegration(
                  (id) => (id === "opencode" ? [] : connections),
                  (connection) =>
                    connection.type === "credential" && connection.method === "oauth"
                      ? Effect.die("a ChatGPT sign-in was resolved")
                      : Effect.succeed(
                          Credential.Key.make({
                            type: "key",
                            key: keys[connection.type === "env" ? connection.name : connection.id],
                          }),
                        ),
                ),
                RequestExecutor.layer.pipe(
                  Layer.provide(
                    Layer.succeed(
                      HttpClient.HttpClient,
                      HttpClient.make((req: HttpClientRequest.HttpClientRequest) =>
                        Effect.sync(() => {
                          auths.push(req.headers.authorization ?? req.headers["x-goog-api-key"] ?? "")
                          return HttpClientResponse.fromWeb(
                            req,
                            model.startsWith("gemini-")
                              ? Response.json({ name: "auth_tokens/ek_gemini" })
                              : model.startsWith("grok-")
                                ? Response.json({ value: "ek_xai", expires_at: 1760000999 })
                                : Response.json({ transport: { sdp: "v=0\r\no=answer\r\n" } }),
                          )
                        }),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      )

    yield* call("gpt-live-1", [credential("active", "key"), credential("stored", "key")])
    yield* call("gpt-live-1", [credential("chatgpt", "oauth"), credential("stored", "key")])
    const grok = yield* call("grok-voice-3.0", [{ type: "env", name: "XAI_API_KEY" }])
    const gemini = yield* call("gemini-3.8-live", [{ type: "env", name: "GEMINI_API_KEY" }])
    expect(auths).toEqual(["Bearer sk-active", "Bearer sk-stored", "Bearer xai-env-key", "gemini-env-key"])
    expect(grok.transport).toEqual({
      type: "websocket",
      url: "wss://api.x.ai/v1/realtime?model=grok-voice-3.0",
      token: "ek_xai",
      expiresAt: 1760000999,
    })
    expect(gemini.transport).toEqual({
      type: "websocket",
      url: "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained",
      token: "auth_tokens/ek_gemini",
      expiresAt: 1760000060,
    })

    const signInOnly = yield* call("gpt-live-1", [credential("chatgpt", "oauth")]).pipe(Effect.flip)
    expect(signInOnly._tag).toBe("Voice.UnavailableError")
    expect(signInOnly.message).toContain("OpenAI API key")

    const missingGoogle = yield* call("gemini-3.8-live", []).pipe(Effect.flip)
    expect(missingGoogle).toMatchObject({ _tag: "Voice.UnavailableError", service: "google" })
    expect(missingGoogle.message).toContain("GEMINI_API_KEY")
  }),
)

it.effect("lists voice models with availability and default without resolving credentials", () =>
  Effect.gen(function* () {
    const list = (connections: Partial<Record<string, Integration.Info["connections"]>>) =>
      Effect.flatMap(Voice.Service, (voice) => voice.models()).pipe(
        Effect.provide(
          voiceLayer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Config.testLayer(),
                Layer.succeed(
                  HttpClient.HttpClient,
                  HttpClient.make(() => Effect.die("Unexpected Console request")),
                ),
                mockIntegration((id) => connections[id] ?? []),
                Layer.mock(RequestExecutor.Service, {}),
              ),
            ),
          ),
        ),
      )

    expect(
      yield* list({
        openai: [credential("chatgpt", "oauth")],
        xai: [{ type: "env", name: "XAI_API_KEY" }],
        google: [credential("gemini", "key")],
      }),
    ).toMatchObject({
      models: [
        { model: "gpt-live-1", provider: "openai", transports: ["webrtc"], available: false },
        { model: "gpt-realtime-2.1", provider: "openai", transports: ["webrtc", "websocket"], available: false },
        { model: "grok-voice-3.0", provider: "xai", transports: ["websocket"], available: true },
        { model: "gemini-3.8-live", provider: "google", transports: ["websocket"], available: true },
      ],
      default: "grok-voice-3.0",
    })

    const none = yield* list({ openai: [credential("chatgpt", "oauth")] })
    expect(none).toMatchObject({
      models: [
        { model: "gpt-live-1", provider: "openai", transports: ["webrtc"], available: false },
        { model: "gpt-realtime-2.1", provider: "openai", transports: ["webrtc", "websocket"], available: false },
        { model: "grok-voice-3.0", provider: "xai", transports: ["websocket"], available: false },
        { model: "gemini-3.8-live", provider: "google", transports: ["websocket"], available: false },
      ],
    })
    expect("default" in none).toBe(false)
  }),
)

it.effect("chooses key before Console, honors explicit payer selection, and explains unavailable routes", () =>
  Effect.gen(function* () {
    for (const scenario of [
      { key: true, expected: "key" },
      { key: false, expected: "console" },
      { key: true, preference: "console" as const, expected: "console" },
      { key: false, preference: "key" as const, expected: undefined },
      { key: true, console: false, preference: "console" as const, expected: undefined },
      { key: false, console: false, expected: undefined },
    ] as const) {
      const fixture = consoleFixture(scenario)
      yield* Effect.gen(function* () {
        const voice = yield* Voice.Service
        const models = yield* voice.models()
        expect(models.models[0].route?.type).toBe(scenario.expected)
        expect(models.models[0].available).toBe(Boolean(scenario.expected))
        if (!scenario.expected) {
          expect(models.models[0].unavailableReason).toBeString()
          expect((yield* voice.session(offer, "phone").pipe(Effect.flip))._tag).toBe("Voice.UnavailableError")
          expect(fixture.requests).toHaveLength(0)
          return
        }
        const call = yield* voice.session(offer, "phone")
        expect(call.route.type).toBe(scenario.expected)
        expect(fixture.requests[0].url).toBe(
          scenario.expected === "key"
            ? "https://api.openai.com/v1/live/sessions"
            : "https://opencode.ai/inference/openai/v1/live/sessions",
        )
      }).pipe(Effect.provide(fixture.layer))
    }
  }),
)

it.effect("brokers SDP and instructions with the original workspace and pairing, without exposing credentials", () => {
  const fixture = consoleFixture()
  return Effect.gen(function* () {
    const voice = yield* Voice.Service
    const models = yield* voice.models()
    expect(models.models[0].route).toEqual(consoleRoute)
    expect(models.models[1].available).toBe(false)
    const call = yield* voice.session({ ...offer, route: consoleRoute }, "phone-one")
    expect(call).toEqual({
      transport: { type: "webrtc", sdp: "answer" },
      route: consoleRoute,
      call: { id: "call-one" },
    })
    expect(fixture.requests[0].headers.authorization).toBe("Bearer console-access")
    expect(fixture.requests[0].headers["x-opencode-org-id"]).toBe("org-team")
    const request = yield* HttpClientRequest.toWeb(fixture.requests[0])
    expect(yield* Effect.promise(() => request.json())).toEqual({
      session: { instructions: "Hello", model: "gpt-live-1" },
      transport: offer.transport,
    })
    const update = { id: "call-one", instructions: "New instructions" }
    expect((yield* voice.instructions(update, "phone-two").pipe(Effect.flip))._tag).toBe("Voice.ForbiddenError")
    expect((yield* voice.instructions({ ...update, id: "missing" }, "phone-one").pipe(Effect.flip))._tag).toBe(
      "Voice.ForbiddenError",
    )
    expect(fixture.requests).toHaveLength(1)
    fixture.state.value = { ...consoleValue, access: "rotated-access" }
    yield* voice.instructions(update, "phone-one")
    expect(fixture.requests[1].url).toBe("https://opencode.ai/inference/openai/v1/live/sessions/call-one/instructions")
    expect(fixture.requests[1].headers.authorization).toBe("Bearer rotated-access")
    expect(fixture.requests[1].headers["x-opencode-org-id"]).toBe("org-team")
    const instructions = yield* HttpClientRequest.toWeb(fixture.requests[1])
    expect(yield* Effect.promise(() => instructions.json())).toEqual({ instructions: update.instructions })
    yield* TestClock.adjust("24 hours")
    expect((yield* voice.instructions(update, "phone-one").pipe(Effect.flip))._tag).toBe("Voice.ForbiddenError")
  }).pipe(Effect.provide(fixture.layer))
})

it.effect("never falls back after provider or Console refusal, refresh failure, or an advertised payer change", () =>
  Effect.gen(function* () {
    for (const preference of ["key", "console"] as const) {
      const fixture = consoleFixture({ key: true, preference })
      fixture.state.status = 403
      yield* Effect.gen(function* () {
        const voice = yield* Voice.Service
        const error = yield* voice.session(offer, "phone").pipe(Effect.flip)
        expect(error._tag).toBe("Voice.UnavailableError")
        expect(fixture.requests).toHaveLength(1)
        expect(fixture.requests[0].headers.authorization).toBe(
          preference === "key" ? "Bearer provider-key" : "Bearer console-access",
        )
        if (preference === "console") expect(error.message).not.toContain("secret error body")
      }).pipe(Effect.provide(fixture.layer))
    }
    const fixture = consoleFixture({ key: true, preference: "console" })
    fixture.state.fail = true
    yield* Effect.gen(function* () {
      const voice = yield* Voice.Service
      expect((yield* voice.session(offer, "phone").pipe(Effect.flip)).message).toBe(
        "Reconnect OpenCode Console on the server",
      )
      expect((yield* voice.models()).models[0].unavailableReason).toContain("Reconnect")
      fixture.state.fail = false
      expect((yield* voice.session({ ...offer, route: { type: "key" } }, "phone").pipe(Effect.flip)).message).toContain(
        "payer changed",
      )
      expect(
        (yield* voice
          .session({ ...offer, route: { type: "console", workspace: { id: "other", name: "Other" } } }, "phone")
          .pipe(Effect.flip)).message,
      ).toContain("payer changed")
      expect(fixture.requests).toHaveLength(0)
    }).pipe(Effect.provide(fixture.layer))
  }),
)

it.effect("rejects missing workspaces and changed or removed call credentials", () => {
  const fixture = consoleFixture()
  return Effect.gen(function* () {
    const voice = yield* Voice.Service
    yield* voice.session(offer, "phone")
    for (const metadata of [
      { ...consoleValue.metadata, orgID: "other" },
      { ...consoleValue.metadata, accountID: "other" },
      { ...consoleValue.metadata, server: "https://other.example/console" },
    ]) {
      fixture.state.value = { ...consoleValue, metadata }
      expect(
        (yield* voice.instructions({ id: "call-one", instructions: "Hello" }, "phone").pipe(Effect.flip)).message,
      ).toContain("connection changed")
    }
    fixture.state.value = { ...consoleValue, metadata: {} }
    expect((yield* voice.models()).models[0].unavailableReason).toContain("workspace")
    fixture.state.value = undefined
    expect((yield* voice.instructions({ id: "call-one", instructions: "Hello" }, "phone").pipe(Effect.flip))._tag).toBe(
      "Voice.UnavailableError",
    )
    expect(fixture.requests).toHaveLength(1)
  }).pipe(Effect.provide(fixture.layer))
})

it.effect("rejects WebSocket Console calls before sending anything", () => {
  const fixture = consoleFixture()
  return Effect.gen(function* () {
    const voice = yield* Voice.Service
    expect((yield* voice.session({ ...offer, transport: { type: "websocket" } }, "phone").pipe(Effect.flip))._tag).toBe(
      "Voice.InvalidRequestError",
    )
    expect(fixture.requests).toHaveLength(0)
  }).pipe(Effect.provide(fixture.layer))
})

it.effect("retains call ownership when location services are rebuilt", () => {
  const fixture = consoleFixture()
  return Effect.gen(function* () {
    yield* Effect.flatMap(Voice.Service, (voice) => voice.session(offer, "phone")).pipe(Effect.provide(fixture.local))
    yield* Effect.flatMap(Voice.Service, (voice) =>
      voice.instructions({ id: "call-one", instructions: "Updated" }, "phone"),
    ).pipe(Effect.provide(Layer.fresh(fixture.local)))
    expect(fixture.requests).toHaveLength(2)
  }).pipe(Effect.provide(VoiceCalls.layer))
})
