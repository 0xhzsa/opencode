export * as SessionGoal from "./session-goal.js"

import { Option, Schema } from "effect"

/** Session metadata key holding the goal that `/goal` set. */
export const KEY = "opencode.goal"

export const Status = Schema.Literals(["active", "paused", "complete"])
export type Status = typeof Status.Type

export const State = Schema.Struct({
  id: Schema.String,
  sessionID: Schema.String,
  objective: Schema.String,
  status: Status,
  /** Why the goal last changed: the reviewer's reason, or what paused it. */
  reason: Schema.optionalKey(Schema.String),
  /** Continuations sent since the goal was set or last resumed. */
  rounds: Schema.Number,
  /** A backstop for loops that stall detection misses. */
  maxRounds: Schema.Number,
  /** Rounds in a row without progress: no tool calls, or the same reason as the round before. */
  stalls: Schema.optionalKey(Schema.Number),
  /** The server process that armed the goal. */
  boot: Schema.String,
  updatedAt: Schema.Number,
}).annotate({ identifier: "SessionGoal.State" })
export type State = typeof State.Type

const decode = Schema.decodeUnknownOption(State)

/**
 * The goal a Session set for itself. Children and forks copy their parent's metadata, so a copied
 * goal names another Session and is ignored.
 */
export function fromMetadata(sessionID: string, metadata: Readonly<Record<string, unknown>> | undefined) {
  const goal = Option.getOrUndefined(decode(metadata?.[KEY]))
  return goal?.sessionID === sessionID ? goal : undefined
}
