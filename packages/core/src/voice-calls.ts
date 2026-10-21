export * as VoiceCalls from "./voice-calls.js"

import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Cache, Context, Effect, Layer } from "effect"
import type { IntegrationConnection } from "./integration/connection.js"

export interface Info {
  readonly caller: string
  readonly connection: IntegrationConnection.Info
  readonly workspace: string
  readonly account: string | undefined
  readonly url: string
}

// Call ownership outlives location reloads and idle eviction, but never the server process.
// Store connection identity, not the credential itself, so updates resolve rotated tokens.
export class Service extends Context.Service<Service, Cache.Cache<string, Info>>()("@opencode/VoiceCalls") {}

export const layer = Layer.effect(
  Service,
  Cache.make<string, Info>({
    capacity: 1_000,
    timeToLive: "24 hours",
    lookup: () => Effect.die("Voice calls must be created before use"),
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [] })
