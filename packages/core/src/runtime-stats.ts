export * as RuntimeStats from "./runtime-stats.js"

import { Effect } from "effect"

/**
 * Pull-based sizes of long-lived structures, read by `GET /api/experimental/debug/runtime`. A
 * structure registers a closure over sizes it already holds; nothing runs until a client reads.
 * Gauges must be O(entries) reads at most, never IO.
 */
export type Gauge = () => number | Readonly<Record<string, number>>

const gauges = new Map<string, Set<Gauge>>()

/** Register a gauge for the current scope. Same-named gauges (one per Location, say) are summed. */
export const gauge = (name: string, read: Gauge) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const set = gauges.get(name) ?? new Set()
      gauges.set(name, set.add(read))
      return set
    }),
    (set) =>
      Effect.sync(() => {
        set.delete(read)
        if (set.size === 0 && gauges.get(name) === set) gauges.delete(name)
      }),
  ).pipe(Effect.asVoid)

/** Every gauge's current value. Gauges with several instances also report `<name>.instances`. */
export function read(): Record<string, number> {
  const out: Record<string, number> = {}
  const add = (key: string, n: number) => (out[key] = (out[key] ?? 0) + n)
  for (const [name, set] of [...gauges].sort(([a], [b]) => a.localeCompare(b))) {
    if (set.size > 1) out[`${name}.instances`] = set.size
    for (const gauge of set) {
      const value = safe(gauge)
      if (typeof value === "number") add(name, value)
      else for (const [key, n] of Object.entries(value)) add(`${name}.${key}`, n)
    }
  }
  return out
}

function safe(gauge: Gauge) {
  try {
    return gauge()
  } catch {
    // JSON has no NaN; -1 marks a gauge that threw.
    return -1
  }
}
