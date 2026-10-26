import { Schema } from "effect"
import { HttpApiEndpoint, OpenApi } from "effect/http-api"

export const DebugRuntime = Schema.Struct({
  pid: Schema.Number,
  uptimeSeconds: Schema.Number,
  memory: Schema.Struct({
    rss: Schema.Number,
    heapTotal: Schema.Number,
    heapUsed: Schema.Number,
    external: Schema.Number,
    arrayBuffers: Schema.Number,
  }),
  locations: Schema.Number,
  gauges: Schema.Record(Schema.String, Schema.Number),
}).annotate({ identifier: "DebugRuntime" })
export type DebugRuntime = typeof DebugRuntime.Type

/** Lives in the `server.experimental` group (see `groups/experimental.ts`). */
export const DebugRuntimeEndpoint = HttpApiEndpoint.get("debug.runtime", "/api/experimental/debug/runtime", {
  success: DebugRuntime,
}).annotateMerge(
  OpenApi.annotations({
    identifier: "experimental.debug.runtime",
    summary: "Read runtime memory statistics",
    description:
      "Process memory, loaded locations, and the sizes of long-lived server structures (event bus buffers, plugin registries, jobs, event feed subscribers), read from counters the server already holds. Never walks the heap. Experimental: may change without compatibility guarantees.",
    transform: (operation) => ({ ...operation, tags: ["experimental"] }),
  }),
)
