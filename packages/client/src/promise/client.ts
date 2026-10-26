export * as OpenCode from "./client.js"

import { DeprecatedAliases } from "../deprecated-aliases.js"
import { SharedEvents } from "../shared-events.js"
import { OpenCode } from "./generated/index.js"
import type { ClientOptions } from "./generated/client.js"
import { makeRpc } from "./rpc.js"

export type { ClientOptions, RequestOptions } from "./generated/client.js"

export function make(options: ClientOptions) {
  const raw = OpenCode.make(options)
  const events = SharedEvents.make((signal, onActivity) => raw.event.subscribe(undefined, { signal, onActivity }))
  const deprecated = DeprecatedAliases.make(raw)
  return {
    ...raw,
    ...deprecated,
    file: {
      ...deprecated.file,
      /** @deprecated Use `client.experimental.file.write`. Removed in the next minor. */
      write: raw.experimental.file.write,
    },
    rpc: Object.assign(makeRpc(raw, events), raw.rpc),
    event: events,
  }
}
