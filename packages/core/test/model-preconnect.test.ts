import { describe, expect, test } from "bun:test"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { LanguageModel } from "@opencode/ai/effect"
import { OpenAIChat } from "@opencode/ai/protocols"
import { Agent } from "@opencode/schema/agent"
import { Document, Info } from "@opencode/schema/config"
import { ConfigExperimental } from "@opencode/schema/config/experimental"
import { Model } from "@opencode/schema/model"
import { Money } from "@opencode/schema/money"
import { Provider } from "@opencode/schema/provider"
import { Session } from "@opencode/schema/session"
import { Config } from "@opencode/core/config"
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

const provider = Provider.ID.make("provider")

type Respond = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

/** Records every warm-up, answering with `respond` (a 404 by default). */
const fetching = (respond: Respond = () => Promise.resolve(new Response(null, { status: 404 }))) => {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const pending: Promise<unknown>[] = []
  const stub = Object.assign(
    (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init })
      const response = respond(input, init)
      pending.push(response)
      return response
    },
    { preconnect: globalThis.fetch.preconnect },
  )
  return {
    calls,
    urls: () => calls.map((call) => call.url),
    settled: () => Promise.allSettled(pending),
    provide: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.provideService(FetchHttpClient.Fetch, stub)),
  }
}

/** A fresh service and its state, so throttling never leaks between tests. */
const owned = () => {
  const state: ModelPreconnect.State = { targets: new Map(), lastUsed: new Map() }
  return { state, service: ModelPreconnect.make(state) }
}

const make = () => owned().service

const IDLE = 300_000

const serve = async (handle: (request: IncomingMessage, response: ServerResponse) => void) => {
  const requests: Array<{ method?: string; url?: string; authorization?: string }> = []
  const state = { connections: 0 }
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization })
    request.resume()
    handle(request, response)
  })
  server.on("connection", () => state.connections++)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    state,
    [Symbol.dispose]: () => void server.close(),
  }
}

describe("ModelPreconnect", () => {
  test("the provider request reuses the warmed connection", async () => {
    using server = await serve((request, response) => {
      response.statusCode = request.method === "GET" ? 404 : 200
      response.end(request.method === "GET" ? '{"error":"not found"}' : "ok")
    })
    const preconnect = make()
    const info = session("reuse")
    const drained = Promise.withResolvers<void>()
    // Real fetch, with a signal once the warm-up body is drained and its socket is back in the pool.
    const stub = fetching(async (input, init) => {
      const response = await globalThis.fetch(input, init)
      const read = response.arrayBuffer.bind(response)
      return Object.defineProperty(response, "arrayBuffer", { value: () => read().finally(drained.resolve) })
    })
    await Effect.runPromise(preconnect.remember(info, provider, new URL(server.origin)))
    await Effect.runPromise(stub.provide(preconnect.warm(info)))
    await drained.promise
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
    const preconnect = make()
    const info = session("redirect")
    const fetch = fetching(globalThis.fetch)
    await Effect.runPromise(preconnect.remember(info, provider, new URL(server.origin)))
    await Effect.runPromise(fetch.provide(preconnect.warm(info)))
    await fetch.settled()
    expect(fetch.calls[0]?.init?.redirect).toBe("manual")
    expect(server.requests.map((request) => request.url)).toEqual(["/"])
  })

  test("warms each origin at most once per window, with no headers or body", async () => {
    const preconnect = make()
    const fetch = fetching()
    const first = session("throttle_a", "/a")
    const second = session("throttle_b", "/b")
    const other = session("throttle_c", "/c")
    await Effect.runPromise(preconnect.remember(first, provider, new URL("https://throttle.example")))
    await Effect.runPromise(preconnect.remember(second, provider, new URL("https://throttle.example")))
    await Effect.runPromise(preconnect.remember(other, provider, new URL("https://other.example")))
    for (const info of [first, second, first, other]) await Effect.runPromise(fetch.provide(preconnect.warm(info)))
    expect(fetch.calls.map((call) => [call.url, call.init?.method, call.init?.headers, call.init?.body])).toEqual([
      ["https://throttle.example/", undefined, undefined, undefined],
      ["https://other.example/", undefined, undefined, undefined],
    ])
  })

  test("retries an origin whose warm-up failed, even when fetch throws synchronously", async () => {
    const failures: Record<string, Respond> = {
      rejects: () => Promise.reject(new Error("offline")),
      throws: () => {
        throw new Error("bad fetch")
      },
    }
    for (const [name, respond] of Object.entries(failures)) {
      const preconnect = make()
      const fetch = fetching(respond)
      const info = session(name)
      await Effect.runPromise(preconnect.remember(info, provider, new URL(`https://${name}.example`)))
      await Effect.runPromise(fetch.provide(preconnect.warm(info)))
      // The failed warm-up releases its origin once the rejection is handled.
      await Bun.sleep(0)
      await Effect.runPromise(fetch.provide(preconnect.warm(info)))
      expect(fetch.calls).toHaveLength(2)
    }
  })

  test("skips an origin a real request used within the idle window", async () => {
    const { state, service: preconnect } = owned()
    const fetch = fetching()
    const info = session("used")
    const url = new URL("https://used.example")
    await Effect.runPromise(preconnect.remember(info, provider, url))
    await Effect.runPromise(preconnect.used(url))
    // Its pooled socket is still alive, so a warm-up would only compete with the next real request for it.
    await Effect.runPromise(fetch.provide(preconnect.warm(info)))
    expect(fetch.calls).toEqual([])

    state.lastUsed.set(url.origin, Date.now() - IDLE)
    await Effect.runPromise(fetch.provide(preconnect.warm(info)))
    expect(fetch.urls()).toEqual(["https://used.example/"])
  })

  test("prunes idle origins and drops targets that cannot be warmed", async () => {
    const { state, service: preconnect } = owned()
    state.lastUsed.set("https://stale.example", Date.now() - IDLE)
    await Effect.runPromise(preconnect.used(new URL("https://fresh.example")))
    expect([...state.lastUsed.keys()]).toEqual(["https://fresh.example"])

    const info = session("drop", "/drop")
    await Effect.runPromise(preconnect.remember(info, provider, new URL("https://drop.example")))
    expect(state.targets.size).toBe(1)
    await Effect.runPromise(preconnect.remember(info, provider, undefined))
    expect(state.targets.size).toBe(0)
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

const configure = (preconnect: boolean | undefined) =>
  Effect.gen(function* () {
    const config = yield* Config.Test
    const experimental = preconnect === undefined ? undefined : new ConfigExperimental.Info({ preconnect })
    yield* config.setEntries([new Document({ type: "document", info: new Info(experimental ? { experimental } : {}) })])
  })

const primary = (preconnect: ModelPreconnect.Interface, info: Session.Info, model: SessionRunnerModel.Resolved) =>
  Effect.gen(function* () {
    const requests = yield* SessionModelRequest.Service.pipe(Effect.provide(SessionModelRequest.layer))
    return yield* requests.primary({ session: info, agent: Agent.ID.make("build"), model, system: [], messages: [] })
  }).pipe(
    Effect.provideService(SessionModelTransport.Service, transport),
    Effect.provideService(ModelPreconnect.Service, preconnect),
  )

/** Each primary request stamps its origin, so tests that expect a warm-up first let it go idle. */
const idle = (state: ModelPreconnect.State) => Effect.sync(() => state.lastUsed.clear())

describe("ModelPreconnect from primary requests", () => {
  it.effect("keeps nothing unless experimental.preconnect is on", () =>
    Effect.gen(function* () {
      const { state, service: preconnect } = owned()
      const fetch = fetching()
      for (const [index, flag] of [undefined, false].entries()) {
        yield* configure(flag)
        for (const request of [0, 1, 2]) {
          const info = session(`preconnect_off_${index}_${request}`, `/off-${index}-${request}`)
          yield* primary(preconnect, info, resolved(`off-provider-${request}`, "https://off.example/v1"))
          yield* fetch.provide(preconnect.warm(info))
        }
      }
      expect(fetch.calls).toEqual([])
      expect(state.targets.size).toBe(0)
      expect(state.lastUsed.size).toBe(0)
    }),
  )

  it.effect("stamps the origin when a primary request uses it and when its response settles", () =>
    Effect.gen(function* () {
      yield* configure(true)
      const { state, service: preconnect } = owned()
      const fetch = fetching()
      const info = session("preconnect_stamp", "/stamp")
      const prepared = yield* primary(preconnect, info, resolved("stamp-provider", "https://stamp.example/v1"))
      // The next admission borrows nothing: the request's own socket is still pooled.
      yield* fetch.provide(preconnect.warm(info))
      expect(fetch.calls).toEqual([])

      state.lastUsed.set("https://stamp.example", Date.now() - IDLE)
      yield* prepared.settled ?? Effect.void
      yield* fetch.provide(preconnect.warm(info))
      expect(fetch.calls).toEqual([])
    }),
  )

  it.effect("turning preconnect off drops every origin for that location", () =>
    Effect.gen(function* () {
      yield* configure(true)
      const { state, service: preconnect } = owned()
      const fetch = fetching()
      const model = (id: string) => Model.Ref.make({ providerID: Provider.ID.make(id), id: Model.ID.make("model") })
      const byAgent = session("preconnect_drop_agent", "/drop")
      const first = session("preconnect_drop_first", "/drop", model("drop-first"))
      const second = session("preconnect_drop_second", "/drop", model("drop-second"))
      const elsewhere = session("preconnect_drop_elsewhere", "/kept", model("drop-first"))
      yield* primary(preconnect, byAgent, resolved("drop-agent", "https://agent.example/v1"))
      yield* primary(preconnect, first, resolved("drop-first", "https://first.example/v1"))
      yield* primary(preconnect, second, resolved("drop-second", "https://second.example/v1"))
      yield* primary(preconnect, elsewhere, resolved("drop-first", "https://kept.example/v1"))

      yield* configure(false)
      yield* primary(preconnect, first, resolved("drop-first", "https://first.example/v1"))
      yield* idle(state)
      for (const info of [byAgent, first, second, elsewhere]) yield* fetch.provide(preconnect.warm(info))
      expect(fetch.urls()).toEqual(["https://kept.example/"])
    }),
  )

  it.effect("warms a default-model session at its next admission", () =>
    Effect.gen(function* () {
      yield* configure(true)
      const { state, service: preconnect } = owned()
      const fetch = fetching()
      const info = session("preconnect_default", "/default-project")
      yield* fetch.provide(preconnect.warm(info))
      expect(fetch.calls).toEqual([])

      yield* primary(preconnect, info, resolved("default-provider", "https://default.example/v1"))
      yield* idle(state)
      yield* fetch.provide(preconnect.warm(info))
      // Another default-model session on the same agent and directory shares the target; another directory does not.
      yield* fetch.provide(preconnect.warm(session("preconnect_other", "/elsewhere")))
      expect(fetch.urls()).toEqual(["https://default.example/"])
    }),
  )

  it.effect("warms a switched-to provider once a primary request has used it", () =>
    Effect.gen(function* () {
      yield* configure(true)
      const { state, service: preconnect } = owned()
      const fetch = fetching()
      yield* primary(
        preconnect,
        session("preconnect_used", "/switch"),
        resolved("switch-provider", "https://switch.example/v1"),
      )
      const model = Model.Ref.make({ providerID: Provider.ID.make("switch-provider"), id: Model.ID.make("model") })
      yield* idle(state)
      yield* fetch.provide(preconnect.warm({ ...session("preconnect_switch", "/switch"), model }))
      expect(fetch.urls()).toEqual(["https://switch.example/"])
    }),
  )

  it.effect("keeps each project's opt-in and origins separate for the same provider", () =>
    Effect.gen(function* () {
      const { state, service: preconnect } = owned()
      const fetch = fetching()
      const model = Model.Ref.make({ providerID: Provider.ID.make("shared-provider"), id: Model.ID.make("model") })
      const on = session("preconnect_project_on", "/project-on", model)
      const off = session("preconnect_project_off", "/project-off", model)
      const gateway = session("preconnect_project_gateway", "/project-gateway", model)
      yield* configure(true)
      yield* primary(preconnect, on, resolved("shared-provider", "https://shared.example/v1"))
      yield* configure(false)
      yield* primary(preconnect, off, resolved("shared-provider", "https://shared-off.example/v1"))
      yield* configure(true)
      yield* primary(preconnect, gateway, resolved("shared-provider", "https://gateway.example/v1"))
      yield* idle(state)

      // A project with preconnect off, or one that never ran the provider, is not warmed by another project's request.
      yield* fetch.provide(preconnect.warm(off))
      yield* fetch.provide(preconnect.warm(session("preconnect_project_unused", "/project-unused", model)))
      expect(fetch.calls).toEqual([])

      yield* fetch.provide(preconnect.warm(on))
      yield* fetch.provide(preconnect.warm(gateway))
      expect(fetch.urls()).toEqual(["https://shared.example/", "https://gateway.example/"])
    }),
  )

  it.effect("warms the origin a model.request hook rewrote the route to", () =>
    Effect.gen(function* () {
      yield* configure(true)
      const hooks = yield* PluginHooks.Service
      yield* hooks.register("session", "model.request", (event) =>
        Effect.sync(() => {
          event.baseURL = "https://rewritten.example/backend-api/codex?key=k"
        }),
      )
      const { state, service: preconnect } = owned()
      const fetch = fetching()
      const info = session("preconnect_rewrite", "/rewrite")
      yield* primary(preconnect, info, resolved("rewrite-provider", "https://original.example/v1"))
      yield* idle(state)
      yield* fetch.provide(preconnect.warm(info))
      expect(fetch.urls()).toEqual(["https://rewritten.example/"])
    }),
  )

  it.effect("skips providers with HTTP hooks", () =>
    Effect.gen(function* () {
      yield* configure(true)
      const hooks = yield* PluginHooks.Service
      yield* hooks.register("session", "http.request", () => Effect.void)
      const { state, service: preconnect } = owned()
      const fetch = fetching()
      const info = session("preconnect_http_hooks", "/hooked")
      yield* primary(preconnect, info, resolved("hooked-provider", "https://hooked.example/v1"))
      yield* fetch.provide(preconnect.warm(info))
      expect(fetch.calls).toEqual([])
      expect(state.targets.size).toBe(0)
    }),
  )
})
