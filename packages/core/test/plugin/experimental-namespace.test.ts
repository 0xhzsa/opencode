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

  const hostPaths = new Map<object, string>()
  walk(effectContext, (path, value) => hostPaths.set(value, path))
  const methods: Array<{ readonly promise: string; readonly host: string | undefined; readonly endpoint: string }> = []
  walk(promiseContext, (path, value) => {
    const adapted = adaptedEndpoints.get(value)
    if (adapted) methods.push({ promise: path, host: hostPaths.get(adapted.method), endpoint: adapted.endpoint.path })
  })
  const isExperimental = (endpoint: string) =>
    endpoint === "/api/experimental" || endpoint.startsWith("/api/experimental/")

  expect(methods.length).toBeGreaterThan(40)
  expect(methods.filter(({ endpoint }) => isExperimental(endpoint)).map(({ promise }) => promise)).toContain(
    "experimental.session.wait",
  )
  expect(
    methods
      .filter(
        ({ promise, host, endpoint }) =>
          isExperimental(endpoint) !== promise.startsWith("experimental.") ||
          isExperimental(endpoint) !== Boolean(host?.startsWith("experimental.")),
      )
      .map(({ promise, host, endpoint }) => `ctx.${promise} (host ${host ?? "unknown"}) -> ${endpoint}`),
  ).toEqual([])
})

function walk(root: unknown, visit: (path: string, value: object) => void) {
  const seen = new Set<unknown>()
  const step = (value: unknown, path: ReadonlyArray<string>) => {
    if ((typeof value !== "object" && typeof value !== "function") || value === null || seen.has(value)) return
    seen.add(value)
    if (typeof value === "function") visit(path.join("."), value)
    Object.entries(value).forEach(([key, child]) => step(child, [...path, key]))
  }
  step(root, [])
}
