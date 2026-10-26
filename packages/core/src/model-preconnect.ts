export * as ModelPreconnect from "./model-preconnect.js"

import type { Provider } from "@opencode/schema/provider"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Context, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { Config } from "./config.js"
import type { ModelResolver } from "./model-resolver.js"
import type { SessionSchema } from "./session/schema.js"

// Bun drops a pooled keep-alive socket after five idle minutes. Until then the next request reuses it, and a warm-up
// would only hold that socket while the real request opens a cold one, so an origin is warmed only once it has gone
// that long without a request.
const IDLE = 300_000
const TIMEOUT = 5_000
const PROXIES = ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY"]

type Selection = Pick<SessionSchema.Info, "agent" | "location"> & {
  readonly model?: { readonly providerID: Provider.ID }
}

export interface Interface {
  /** Records the origin a session's primary request goes to, or drops it when that route cannot be warmed. */
  readonly remember: (session: Selection, providerID: Provider.ID, url: URL | undefined) => Effect.Effect<void>
  /** Marks an origin as just used by a real request, so no warm-up competes for its pooled socket. */
  readonly used: (url: URL) => Effect.Effect<void>
  /** Drops every origin remembered for a location, once its config has preconnect off. */
  readonly forget: (location: Selection["location"]) => Effect.Effect<void>
  /** Opens a connection to the origin remembered for a session. Sends no credentials, headers, or prompt data. */
  readonly warm: (session: Selection) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ModelPreconnect") {}

/** Whether a location's config turns preconnect on. */
export const enabled = (config: Config.Interface) =>
  config.entries().pipe(Effect.map((entries) => Config.latest(entries, "experimental")?.preconnect === true))

/** The origin worth warming for a resolved model, or undefined when a warm-up would not be reused. */
export const target = (resolved: ModelResolver.Resolved, env: Record<string, string | undefined> = process.env) => {
  const route = resolved.model.route
  if (resolved.transport === "websocket" || route.protocol === "ai-sdk" || !route.endpoint.baseURL) return
  const url = URL.parse(route.endpoint.baseURL)
  if (url?.protocol !== "https:") return
  // Proxied requests tunnel through their own sockets, so a direct warm-up would never be reused.
  if (PROXIES.some((name) => env[name] || env[name.toLowerCase()])) return
  // Only the origin: base URLs can carry credentials, query parameters, and account IDs in the path.
  return new URL(url.origin)
}

// Targets are per location, because experimental.preconnect and provider base URLs come from that location's config.
const locationKey = (location: Selection["location"]) => `${location.directory}\0${location.workspaceID ?? ""}`

// A session without a model runs its agent's model, or the project's default, so it shares a target with every other
// such session on that agent and location.
const targetKey = (session: Selection) =>
  session.model ? `provider:${session.model.providerID}` : `agent:${session.agent ?? ""}`

export interface State {
  /** Remembered origins by location, then by provider or agent. */
  readonly targets: Map<string, Map<string, URL>>
  /** When each origin last carried a request, real or warm-up. Entries older than IDLE are pruned on insert. */
  readonly lastUsed: Map<string, number>
}

export const make = (state: State = { targets: new Map(), lastUsed: new Map() }) => {
  const { targets, lastUsed } = state

  const stamp = (url: URL) => {
    const now = Date.now()
    for (const [origin, time] of lastUsed) if (now - time >= IDLE) lastUsed.delete(origin)
    lastUsed.set(url.origin, now)
    return now
  }

  const preconnect = (url: URL) =>
    Effect.gen(function* () {
      if (typeof Bun === "undefined") return
      if (Date.now() - (lastUsed.get(url.origin) ?? -Infinity) < IDLE) return
      const time = stamp(url)
      const fetch = yield* FetchHttpClient.Fetch
      // Bun 1.4.4's fetch.preconnect rejects every URL, and its HEAD handling either drops the socket or, with a
      // Content-Length, can leave it unusable. A GET of the origin lands in the pool; APIs answer with a small 404.
      // The body is drained so HTTP/1.1 can reuse the socket.
      void Promise.try(() => fetch(url, { redirect: "manual", signal: AbortSignal.timeout(TIMEOUT) }))
        .then((response) => response.arrayBuffer())
        .catch(() => {
          // A real request since then keeps its stamp.
          if (lastUsed.get(url.origin) === time) lastUsed.delete(url.origin)
        })
    })

  return Service.of({
    remember: (session, providerID, url) =>
      Effect.sync(() => {
        const location = locationKey(session.location)
        const keys = [targetKey(session), targetKey({ ...session, model: { providerID } })]
        const known = targets.get(location)
        if (url) {
          const next = known ?? new Map<string, URL>()
          for (const key of keys) next.set(key, url)
          targets.set(location, next)
          return
        }
        if (!known) return
        for (const key of keys) known.delete(key)
        if (known.size === 0) targets.delete(location)
      }),
    used: (url) => Effect.sync(() => void stamp(url)),
    forget: (location) => Effect.sync(() => void targets.delete(locationKey(location))),
    warm: (session) => {
      const url = targets.get(locationKey(session.location))?.get(targetKey(session))
      return url ? preconnect(url) : Effect.void
    },
  })
}

export const layer = Layer.sync(Service, () => make())

export const noopLayer = Layer.succeed(
  Service,
  Service.of({
    remember: () => Effect.void,
    used: () => Effect.void,
    forget: () => Effect.void,
    warm: () => Effect.void,
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [] })
