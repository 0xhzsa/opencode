import { LocationServiceMap } from "@opencode/core/location-service-map"
import { Effect, RcMap } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "../api"
import { requestRef } from "../location"

export const DebugHandler = HttpApiBuilder.group(Api, "server.debug", (handlers) =>
  Effect.gen(function* () {
    const locations = yield* LocationServiceMap.Service
    return handlers
      .handle(
        "debug.location",
        Effect.fn(function* () {
          return Array.from(yield* RcMap.keys(locations.rcMap))
        }),
      )
      .handle(
        "debug.location.evict",
        Effect.fn(function* (ctx) {
          // Resolve through requestRef so the key matches the shape the location
          // middleware cached the services under.
          yield* locations.invalidate(requestRef(ctx.request))
        }),
      )
  }),
)
