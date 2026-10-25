// PROTOTYPE (D-14): publish five events, reconnect from the second cursor, then from a cursor the ring has evicted.
import { Event } from "@opencode/schema/event"
import { Effect, Stream } from "effect"
import * as ReplayRing from "../src/replay-ring.prototype"

const program = Effect.gen(function* () {
  let publish: ((event: Event.Payload) => Effect.Effect<void>) | undefined
  const ring = yield* ReplayRing.make(
    (subscriber) =>
      Effect.sync(() => {
        publish = subscriber as typeof publish
        return Effect.void
      }),
    { capacity: 3 },
  )
  const first = yield* ring.subscribe(undefined)
  for (let index = 0; index < 5; index++)
    yield* publish!({ id: Event.ID.create(), type: "rpc.prototype", data: {} } as unknown as Event.Payload)
  const seen = yield* first.stream.pipe(Stream.take(6), Stream.runCollect)
  const cursors = [...seen].map((frame) => frame.split("\n")[0]!.slice(4))
  console.log("first connect", { resumed: first.resumed, cursors })

  const resumed = yield* ring.subscribe(cursors[3])
  console.log("resume from", cursors[3], { resumed: resumed.resumed, replayed: resumed.replayed })
  const evicted = yield* ring.subscribe(cursors[1])
  console.log("resume from", cursors[1], { resumed: evicted.resumed, replayed: evicted.replayed })
})

await Effect.runPromise(Effect.scoped(program))
