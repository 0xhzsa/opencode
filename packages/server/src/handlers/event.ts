import { Event } from "@opencode/schema/event"
import { Effect, Option, Stream } from "effect"
import { HttpServerResponse } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "../api"
import { EventFeed } from "../event-feed"
import * as ReplayRing from "../replay-ring.prototype"

export const EventHandler = HttpApiBuilder.group(Api, "server.event", (handlers) =>
  Effect.gen(function* () {
    const feed = yield* EventFeed.Service
    // PROTOTYPE (D-14): when the replay ring is provided, the route resumes from Last-Event-ID.
    const ring = yield* Effect.serviceOption(ReplayRing.Service)
    return handlers.handleRaw("event.subscribe", (ctx) =>
      Effect.gen(function* () {
        const connected = {
          id: Event.ID.create(),
          type: "server.connected",
          data: {},
        } as const
        const output = Option.isSome(ring)
          ? Stream.unwrap(
              ring.value
                .subscribe(ctx.request.headers["last-event-id"])
                .pipe(Effect.map((subscription) => subscription.stream)),
            )
          : Stream.unwrap(
              feed.subscribe.pipe(
                Effect.map((live) => Stream.make(EventFeed.frame(connected)).pipe(Stream.concat(live))),
              ),
            )
        const heartbeat = Stream.tick("15 seconds").pipe(Stream.map(() => ": heartbeat\n\n"))
        return HttpServerResponse.stream(
          output.pipe(Stream.merge(heartbeat, { haltStrategy: "left" }), Stream.encodeText),
          {
            contentType: "text/event-stream",
            headers: {
              "Cache-Control": "no-cache, no-transform",
              "X-Accel-Buffering": "no",
              "X-Content-Type-Options": "nosniff",
            },
          },
        )
      }),
    )
  }),
)
