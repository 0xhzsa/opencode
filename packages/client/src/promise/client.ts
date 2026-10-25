export * as OpenCode from "./client.js"

import { SharedEvents } from "../shared-events.js"
import { OpenCode } from "./generated/index.js"
import type { ClientOptions } from "./generated/client.js"
import { makeRpc } from "./rpc.js"

export type { ClientOptions, RequestOptions } from "./generated/client.js"

export function make(options: ClientOptions) {
  const raw = OpenCode.make(options)
  // PROTOTYPE (D-14): remember the last replay cursor and hand it back on reconnect. The generated SSE
  // parser drops `id:` lines, so the prototype server repeats the cursor in the payload.
  let cursor: string | undefined
  const events = SharedEvents.make((signal, onActivity) =>
    resumable(
      raw.event.subscribe({ signal, onActivity, headers: cursor ? { "last-event-id": cursor } : undefined }),
      (next) => (cursor = next),
    ),
  )
  return {
    ...raw,
    rpc: Object.assign(makeRpc(raw, events), raw.rpc),
    event: events,
  }
}

async function* resumable<A extends object>(source: AsyncIterable<A>, remember: (cursor: string) => void) {
  for await (const event of source) {
    if ("cursor" in event && typeof event.cursor === "string") remember(event.cursor)
    yield event
  }
}
