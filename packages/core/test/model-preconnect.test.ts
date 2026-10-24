import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { LanguageModel } from "@opencode/ai"
import { OpenAIChat } from "@opencode/ai/protocols"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Money } from "@opencode/schema/money"
import { Provider } from "@opencode/schema/provider"
import { Session } from "@opencode/schema/session"
import { Location } from "@opencode/core/location"
import { ModelPreconnect } from "@opencode/core/model-preconnect"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { Project } from "@opencode/core/project"
import { AbsolutePath } from "@opencode/core/schema"
import { SessionModelRequest } from "@opencode/core/session/model-request"
import { SessionModelTransport } from "@opencode/core/session/model-transport"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { DateTime, Effect } from "effect"
import { FetchHttpClient } from "effect/http"
import { testEffect } from "./lib/effect"
import { PluginTestLayer } from "./plugin/fixture"

// The preload turns preconnect off so session tests stay offline; this file exercises it.
const disabled = process.env.OPENCODE_DISABLE_PRECONNECT
beforeAll(() => void delete process.env.OPENCODE_DISABLE_PRECONNECT)
afterAll(() => {
  if (disabled !== undefined) process.env.OPENCODE_DISABLE_PRECONNECT = disabled
})

const resolved = (provider: string, baseURL: string, transport?: "websocket") => {
  const model = SessionRunnerModel.resolved(OpenAIChat.route.with({ endpoint: { baseURL } }).model({ id: "model" }), {
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    cost: [],
    limit: { context: 200_000, output: 32_000 },
    transport,
  })
  return { ...model, ref: { ...model.ref, providerID: Provider.ID.make(provider) } }
}

const session = (id: string, directory = "/project", model?: Model.Ref) =>
  Session.Info.make({
    id: Session.ID.make(`ses_${id}`),
    projectID: Project.ID.global,
    cost: Money.USD.zero,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
    location: Location.Ref.make({ directory: AbsolutePath.make(directory) }),
    model,
  })

const fetching = (respond: () => Promise<Response> = () => Promise.resolve(new Response(null, { status: 404 }))) => {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fetch = Object.assign(
    (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init })
      return respond()
    },
    { preconnect: globalThis.fetch.preconnect },
  )
  return {
    calls,
    urls: () => calls.map((call) => call.url),
    provide: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.provideService(FetchHttpClient.Fetch, fetch)),
    run: (effect: Effect.Effect<void>) =>
      Effect.runPromise(effect.pipe(Effect.provideService(FetchHttpClient.Fetch, fetch))),
  }
}

const serve = async (handle: (request: IncomingMessage, response: ServerResponse) => void) => {
  const requests: Array<{ method?: string; url?: string; authorization?: string }> = []
  const state = { connections: 0 }
  let seen!: () => void
  const first = new Promise<void>((resolve) => (seen = resolve))
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization })
    request.resume()
    handle(request, response)
    seen()
  })
  server.on("connection", () => state.connections++)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    state,
    first,
    [Symbol.dispose]: () => void server.close(),
  }
}

describe("ModelPreconnect", () => {
  test("the provider request reuses the warmed connection", async () => {
    using server = await serve((request, response) => {
      response.statusCode = request.method === "GET" ? 404 : 200
      response.end(request.method === "GET" ? '{"error":"not found"}' : "ok")
    })
    await Effect.runPromise(ModelPreconnect.preconnect(new URL(server.origin)))
    await server.first
    await Bun.sleep(20)
    const response = await fetch(`${server.origin}/v1/messages`, {
      method: "POST",
      headers: { authorization: "Bearer secret" },
      body: "{}",
    })
    expect(await response.text()).toBe("ok")
    expect(server.requests).toEqual([
      { method: "GET", url: "/", authorization: undefined },
      { method: "POST", url: "/v1/messages", authorization: "Bearer secret" },
    ])
    expect(server.state.connections).toBe(1)
  })

  test("does not follow redirects", async () => {
    using server = await serve((_, response) => {
      response.writeHead(302, { location: "/elsewhere" })
      response.end()
    })
    await Effect.runPromise(ModelPreconnect.preconnect(new URL(server.origin)))
    await server.first
    await Bun.sleep(50)
    expect(server.requests.map((request) => request.url)).toEqual(["/"])
  })

  test("warms each origin at most once per window", async () => {
    const fetch = fetching()
    await fetch.run(ModelPreconnect.preconnect(new URL("https://throttle.example/")))
    await fetch.run(ModelPreconnect.preconnect(new URL("https://throttle.example/")))
    await fetch.run(ModelPreconnect.preconnect(new URL("https://other.example/")))
    expect(fetch.calls.map((call) => [call.url, call.init?.method, call.init?.headers, call.init?.body])).toEqual([
      ["https://throttle.example/", undefined, undefined, undefined],
      ["https://other.example/", undefined, undefined, undefined],
    ])
    expect(fetch.calls[0]?.init?.redirect).toBe("manual")
  })

  test("retries an origin whose warm-up failed, even when fetch throws synchronously", async () => {
    const rejecting = fetching(() => Promise.reject(new Error("offline")))
    await rejecting.run(ModelPreconnect.preconnect(new URL("https://offline.example/")))
    await Bun.sleep(0)
    await rejecting.run(ModelPreconnect.preconnect(new URL("https://offline.example/")))
    expect(rejecting.calls).toHaveLength(2)

    const throwing = fetching(() => {
      throw new Error("bad fetch")
    })
    await throwing.run(ModelPreconnect.preconnect(new URL("https://throws.example/")))
    await Bun.sleep(0)
    await throwing.run(ModelPreconnect.preconnect(new URL("https://throws.example/")))
    expect(throwing.calls).toHaveLength(2)
  })

  test("warms only the origin, never credentials, query, or path", () => {
    const url = "https://user:secret@gateway.example:8443/v1/accounts/acct_1/gateways/gw_1/openai?api-key=k"
    expect(ModelPreconnect.target(resolved("p", url), {})?.href).toBe("https://gateway.example:8443/")
  })

  test("skips routes a direct warm-up would not serve", () => {
    const target = (model: SessionRunnerModel.Resolved, env: Record<string, string> = {}) =>
      ModelPreconnect.target(model, env)?.href
    expect(target(resolved("p", "https://api.example.com/v1"))).toBe("https://api.example.com/")
    expect(target(resolved("p", "http://localhost:11434/v1"))).toBeUndefined()
    expect(target(resolved("p", "https://api.example.com/v1", "websocket"))).toBeUndefined()
    for (const name of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "ALL_PROXY"])
      expect(target(resolved("p", "https://api.example.com/v1"), { [name]: "http://proxy:8080" })).toBeUndefined()
    expect(target(resolved("p", "https://api.example.com/v1"), { OPENCODE_DISABLE_PRECONNECT: "1" })).toBeUndefined()
    const model = resolved("p", "https://ai-sdk.local")
    const route = { ...model.model.route, protocol: "ai-sdk" }
    expect(target({ ...model, model: LanguageModel.update(model.model, { route }) })).toBeUndefined()
  })
})

const it = testEffect(PluginTestLayer)

const transport = SessionModelTransport.Service.of({
  bind: () => ({ execute: () => Effect.die("unused WebSocket execution") }),
  close: () => Effect.void,
  closeAll: Effect.void,
})

const primary = (info: Session.Info, model: SessionRunnerModel.Resolved) =>
  Effect.gen(function* () {
    const requests = yield* SessionModelRequest.Service.pipe(Effect.provide(SessionModelRequest.layer))
    yield* requests.primary({ session: info, agent: Agent.ID.make("build"), model, system: [], messages: [] })
  }).pipe(Effect.provideService(SessionModelTransport.Service, transport))

describe("ModelPreconnect from primary requests", () => {
  it.effect("warms a default-model session at its next admission", () =>
    Effect.gen(function* () {
      const fetch = fetching()
      const info = session("preconnect_default", "/default-project")
      yield* fetch.provide(ModelPreconnect.warm(info))
      expect(fetch.calls).toEqual([])

      yield* primary(info, resolved("default-provider", "https://default.example/v1"))
      yield* fetch.provide(ModelPreconnect.warm(info))
      // Another default-model session on the same agent and directory shares the target; another directory does not.
      yield* fetch.provide(ModelPreconnect.warm(session("preconnect_other", "/elsewhere")))
      expect(fetch.urls()).toEqual(["https://default.example/"])
    }),
  )

  it.effect("warms a switched-to provider once a primary request has used it", () =>
    Effect.gen(function* () {
      const fetch = fetching()
      yield* primary(
        session("preconnect_used", "/switch-project"),
        resolved("switch-provider", "https://switch.example/v1"),
      )
      const info = session("preconnect_switch", "/switch-project")
      yield* fetch.provide(
        ModelPreconnect.warm({
          ...info,
          model: Model.Ref.make({ providerID: Provider.ID.make("switch-provider"), id: Model.ID.make("model") }),
        }),
      )
      expect(fetch.urls()).toEqual(["https://switch.example/"])
    }),
  )

  it.effect("warms the origin a model.request hook rewrote the route to", () =>
    Effect.gen(function* () {
      const hooks = yield* PluginHooks.Service
      yield* hooks.register("session", "model.request", (event) =>
        Effect.sync(() => {
          event.baseURL = "https://rewritten.example/backend-api/codex?key=k"
        }),
      )
      const fetch = fetching()
      const info = session("preconnect_rewrite", "/rewrite-project")
      yield* primary(info, resolved("rewrite-provider", "https://original.example/v1"))
      yield* fetch.provide(ModelPreconnect.warm(info))
      expect(fetch.urls()).toEqual(["https://rewritten.example/"])
    }),
  )

  it.effect("skips providers with HTTP hooks", () =>
    Effect.gen(function* () {
      const hooks = yield* PluginHooks.Service
      yield* hooks.register("session", "http.request", () => Effect.void)
      const fetch = fetching()
      const info = session("preconnect_http_hooks", "/hooked-project")
      yield* primary(info, resolved("hooked-provider", "https://hooked.example/v1"))
      yield* fetch.provide(ModelPreconnect.warm(info))
      expect(fetch.calls).toEqual([])
    }),
  )
})
