// PROTOTYPE (D-14, "One Client Reducer, Resumable SSE"). Throwaway; lives on proto/client-reducer only.
//
// The event feed with memory: the last `Capacity` frames are kept with a server-wide sequence number,
// every frame carries `id: <cursor>`, and a reconnect that sends `Last-Event-ID` gets the frames it
// missed instead of refetching every loaded transcript. Durable `seq` is per aggregate, so it can't be
// the cursor; the cursor is `<epoch>.<seq>` so a restarted server never mistakes an old cursor for its own.

import { Bus } from "@opencode/core/bus"
import { Event } from "@opencode/schema/event"
import { isOpenCodeEvent, type OpenCodeEvent } from "@opencode/protocol/groups/event"
import { Cause, Context, Effect, Layer, Queue, Scope, Stream } from "effect"
import { EventFeed } from "./event-feed"

export const Capacity = 2_048

export interface Subscription {
  /** False when the cursor was missing, from another epoch, or older than the ring: the client must refetch. */
  readonly resumed: boolean
  readonly replayed: number
  readonly stream: Stream.Stream<string, EventFeed.Error>
}

export interface Interface {
  readonly subscribe: (lastEventID: string | undefined) => Effect.Effect<Subscription, never, Scope.Scope>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/server/ReplayRing") {}

export function frame(cursor: string, event: OpenCodeEvent | { readonly id: string; readonly type: string }) {
  // The generated client's SSE parser drops `id:`, so the cursor is repeated in the payload.
  return `id: ${cursor}\ndata: ${JSON.stringify({ ...event, cursor })}\n\n`
}

export const make = Effect.fn("ReplayRing.make")(function* (
  observe: (subscriber: Bus.Subscriber) => Effect.Effect<Bus.Unsubscribe>,
  options?: { readonly capacity?: number; readonly subscriberCapacity?: number },
) {
  const capacity = options?.capacity ?? Capacity
  const queueCapacity = options?.subscriberCapacity ?? EventFeed.SubscriberCapacity
  const epoch = Event.ID.create().slice(-8)
  const frames = new Array<string>(capacity)
  let seq = 0
  const subscribers = new Set<Queue.Queue<string, EventFeed.Error>>()

  const publish = (event: Event.Payload) =>
    Effect.sync(() => {
      if (!isOpenCodeEvent(event)) return
      seq += 1
      const encoded = frame(`${epoch}.${seq}`, event)
      frames[seq % capacity] = encoded
      for (const subscriber of subscribers) {
        if (Queue.offerUnsafe(subscriber, encoded)) continue
        subscribers.delete(subscriber)
        Queue.failCauseUnsafe(subscriber, Cause.fail(new EventFeed.SubscriberOverflowError({ capacity: queueCapacity })))
      }
    })

  // Runs synchronously with publish, so no frame lands between the backlog snapshot and the live queue.
  const since = (lastEventID: string | undefined) => {
    const [from, raw] = lastEventID?.split(".") ?? []
    const after = Number(raw)
    const oldest = Math.max(1, seq - capacity + 1)
    if (from !== epoch || !Number.isInteger(after) || after > seq || after < oldest - 1) return undefined
    return Array.from({ length: seq - after }, (_, offset) => frames[(after + 1 + offset) % capacity]!)
  }

  const unsubscribe = yield* observe(publish)
  yield* Effect.addFinalizer(() => unsubscribe)

  return Service.of({
    subscribe: (lastEventID) =>
      Effect.acquireRelease(
        Queue.dropping<string, EventFeed.Error>(queueCapacity).pipe(
          Effect.map((queue) => {
            const backlog = since(lastEventID)
            subscribers.add(queue)
            return { queue, backlog }
          }),
        ),
        ({ queue }) =>
          Effect.sync(() => subscribers.delete(queue)).pipe(Effect.andThen(Queue.shutdown(queue)), Effect.asVoid),
      ).pipe(
        Effect.map(({ queue, backlog }) => {
          const connected = frame(`${epoch}.${seq}`, {
            id: Event.ID.create(),
            type: "server.connected",
            data: { resumed: backlog !== undefined },
          } as { readonly id: string; readonly type: string })
          return {
            resumed: backlog !== undefined,
            replayed: backlog?.length ?? 0,
            stream: Stream.make(connected, ...(backlog ?? [])).pipe(Stream.concat(Stream.fromQueue(queue))),
          }
        }),
      ),
  })
})

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    return yield* make(bus.listen)
  }),
)
