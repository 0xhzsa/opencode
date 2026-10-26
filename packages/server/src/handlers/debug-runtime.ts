import { LocationServiceMap } from "@opencode/core/location-service-map"
import { RuntimeStats } from "@opencode/core/runtime-stats"
import { Effect, Option, RcMap } from "effect"

/** `debug.runtime` in the `server.experimental` group: counters only, never a heap walk. */
export const debugRuntime = Effect.fn("server.debug.runtime")(function* () {
  const locations = yield* Effect.serviceOption(LocationServiceMap.Service)
  const { rss, heapTotal, heapUsed, external, arrayBuffers } = process.memoryUsage()
  return {
    pid: process.pid,
    uptimeSeconds: Math.round(process.uptime()),
    memory: { rss, heapTotal, heapUsed, external, arrayBuffers },
    locations: Option.isSome(locations) ? Array.from(yield* RcMap.keys(locations.value.rcMap)).length : 0,
    gauges: RuntimeStats.read(),
  }
})
