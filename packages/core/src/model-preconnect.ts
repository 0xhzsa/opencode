export * as ModelPreconnect from "./model-preconnect.js"

import type { Provider } from "@opencode/schema/provider"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Context, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import type { ModelResolver } from "./model-resolver.js"
import type { SessionSchema } from "./session/schema.js"

// Bun closes idle keep-alive sockets after five minutes; warming sooner only repeats a live handshake.
const WARM_FOR = 240_000
const TIMEOUT = 5_000
const PROXIES = ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY"]

type Selection = Pick<SessionSchema.Info, "agent" | "location"> & {
  readonly model?: { readonly providerID: Provider.ID }
}

export interface Interface {
  /** Records the origin a session's primary request went to, or forgets it when there is nothing to warm. */
  readonly remember: (session: Selection, providerID: Provider.ID, url: URL | undefined) => Effect.Effect<void>
  /** Opens a connection to the origin remembered for a session. Sends no credentials, headers, or prompt data. */
  readonly warm: (session: Selection) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ModelPreconnect") {}

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

// A session without a model runs its agent's model, or the project's default, so it shares a target with every
// other such session on that agent and directory.
const key = (session: Selection) =>
  session.model ? `provider:${session.model.providerID}` : `agent:${session.location.directory}:${session.agent ?? ""}`

export const layer = Layer.sync(Service, () => {
  const targets = new Map<string, URL | undefined>()
  const warmed = new Map<string, number>()

  const preconnect = (url: URL) =>
    Effect.gen(function* () {
      if (typeof Bun === "undefined") return
      const now = Date.now()
      if (now - (warmed.get(url.origin) ?? -Infinity) < WARM_FOR) return
      warmed.set(url.origin, now)
      const fetch = yield* FetchHttpClient.Fetch
      // Bun 1.4.4's fetch.preconnect rejects every URL, and its HEAD handling either drops the socket or, with a
      // Content-Length, can leave it unusable. A GET of the origin lands in the pool; APIs answer with a small 404.
      // The body is drained so HTTP/1.1 can reuse the socket.
      void Promise.try(() => fetch(url, { redirect: "manual", signal: AbortSignal.timeout(TIMEOUT) }))
        .then((response) => response.arrayBuffer())
        .catch(() => warmed.delete(url.origin))
    })

  return Service.of({
    remember: (session, providerID, url) =>
      Effect.sync(() => {
        targets.set(key(session), url)
        targets.set(key({ ...session, model: { providerID } }), url)
      }),
    warm: (session) => {
      const url = targets.get(key(session))
      return url ? preconnect(url) : Effect.void
    },
  })
})

export const noopLayer = Layer.succeed(Service, Service.of({ remember: () => Effect.void, warm: () => Effect.void }))

export const node = makeGlobalNode({ service: Service, layer, deps: [] })
