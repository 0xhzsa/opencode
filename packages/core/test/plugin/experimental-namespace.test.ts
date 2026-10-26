import { expect, test } from "bun:test"
import { PluginPromise } from "@opencode/core/plugin/promise"
import { adaptedEndpoints } from "@opencode/plugin/promise/adapter"
import type { Context } from "@opencode/plugin/promise/plugin"
import { Effect } from "effect"
import { host } from "./host"

// The Promise adapter records the endpoint and Effect host method behind every API method it builds,
// so this follows the real mapping instead of a hand-kept list of experimental methods.
test("ctx.experimental holds exactly the plugin methods backed by /api/experimental endpoints", async () => {
  const effectContext = host()
  let promiseContext: Context | undefined
  await Effect.runPromise(
    Effect.scoped(
      PluginPromise.fromPromise({
        id: "test.experimental-namespace",
        setup: (context) => {
          promiseContext = context
        },
      }).effect(effectContext),
    ),
  )

  const hostPaths = paths(effectContext)
  const methods = Array.from(paths(promiseContext)).flatMap(([value, promise]) => {
    const adapted = adaptedEndpoints.get(value)
    return adapted ? [{ promise, host: hostPaths.get(adapted.method) ?? [], endpoint: adapted.endpoint.path }] : []
  })
  const isExperimental = (endpoint: string) =>
    endpoint === "/api/experimental" || endpoint.startsWith("/api/experimental/")
  const underExperimental = (list: ReadonlyArray<string>) => list.some((path) => path.startsWith("experimental."))

  expect(methods.length).toBeGreaterThan(40)
  expect(methods.filter(({ endpoint }) => isExperimental(endpoint)).flatMap(({ promise }) => promise)).toContain(
    "experimental.session.wait",
  )
  expect(
    methods
      .filter(
        ({ promise, host, endpoint }) =>
          isExperimental(endpoint) !== underExperimental(promise) ||
          isExperimental(endpoint) !== underExperimental(host),
      )
      .map(
        ({ promise, host, endpoint }) =>
          `ctx.${promise.join("|")} (host ${host.join("|") || "unknown"}) -> ${endpoint}`,
      ),
  ).toEqual([])

  // Pre-experimental paths kept as deprecated aliases until the next minor (.github/RELEASE_REMINDERS.md).
  const deprecated = [
    "generate.text",
    "session.instructions.entry.list",
    "session.instructions.entry.put",
    "session.instructions.entry.remove",
    "session.wait",
  ]
  const outside = (pick: (method: (typeof methods)[number]) => ReadonlyArray<string>) =>
    methods
      .filter(({ endpoint }) => isExperimental(endpoint))
      .flatMap((method) => pick(method).filter((path) => !path.startsWith("experimental.")))
      .toSorted()
  expect(outside((method) => method.promise)).toEqual(deprecated)
  expect(outside((method) => method.host)).toEqual(deprecated)
})

// Every path to every function, so a method reachable from both its home and a deprecated alias lists both.
function paths(root: unknown) {
  const result = new Map<object, Array<string>>()
  const step = (value: unknown, path: ReadonlyArray<string>, ancestors: ReadonlySet<unknown>) => {
    if ((typeof value !== "object" && typeof value !== "function") || value === null || ancestors.has(value)) return
    if (typeof value === "function") result.set(value, [...(result.get(value) ?? []), path.join(".")])
    const next = new Set(ancestors).add(value)
    Object.entries(value).forEach(([key, child]) => step(child, [...path, key], next))
  }
  step(root, [], new Set())
  return result
}
