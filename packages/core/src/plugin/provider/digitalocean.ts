import type { IntegrationOAuthMethodRegistration } from "@opencode/plugin/effect/integration"
import { define } from "@opencode/plugin/effect/plugin"
import { Clock, Deferred, Duration, Effect, FiberHandle, Option, Schema, Semaphore, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import type { Server } from "node:http"
import { App } from "../../app.js"
import { Bus } from "../../bus.js"
import { Credential } from "../../credential.js"
import { Integration } from "../../integration.js"
import { Model } from "../../model.js"
import { OauthCallbackPage } from "../../oauth/page.js"
import { Provider } from "../../provider.js"
import type { PluginInternal } from "../internal.js"

const providerID = Provider.ID.make("digitalocean")
const integrationID = Integration.ID.make("digitalocean")
const methodID = Integration.MethodID.make("browser")

const clientID = "b1a6c5158156caac821fd1b30253ca8acb52454a48fa744420e41889cb589f82"
const authorizeEndpoint = "https://cloud.digitalocean.com/v1/oauth/authorize"
const routersEndpoint = "https://api.digitalocean.com/v2/gen-ai/models/routers"
const callbackPort = 1456
const callbackPath = "/auth/callback"
const tokenPath = "/auth/token"
const RoutersResponse = Schema.Struct({
  model_routers: Schema.Array(Schema.Struct({ name: Schema.NonEmptyString })),
})
type Routers = (typeof RoutersResponse.Type)["model_routers"]
const refreshInterval = Duration.minutes(5)
// Every open folder runs this plugin, so folders signed in with the same token share one fetch per interval. Keyed by
// the process-wide HTTP client so that separate clients, such as one per test, keep separate caches.
const fetched = new WeakMap<
  HttpClient.HttpClient,
  { lock: Semaphore.Semaphore; byToken: Map<string, { checked: number; routers: Routers }> }
>()
const decodeCallback = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      access_token: Schema.optional(Schema.String),
      expires_in: Schema.optional(Schema.String),
      state: Schema.optional(Schema.String),
      error: Schema.optional(Schema.String),
      error_description: Schema.optional(Schema.String),
    }),
  ),
)

const oauth = {
  integrationID,
  method: {
    id: methodID,
    type: "oauth",
    label: "Login with DigitalOcean",
  },
  authorize: () =>
    Effect.gen(function* () {
      const state = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")
      const token = yield* Deferred.make<{ access: string; expiresIn: number }, Error>()
      // Lazy so runtimes without a loopback listener (workerd) never evaluate node:http.
      const { createServer } = yield* Effect.promise(() => import("node:http"))
      const server = createServer((request, response) => {
        const url = new URL(request.url ?? "/", "http://localhost")
        if (request.method === "GET" && url.pathname === callbackPath) {
          response
            .writeHead(200, { "Content-Type": "text/html" })
            .end(OauthCallbackPage.bootstrap({ tokenPath, provider: "DigitalOcean" }))
          return
        }
        if (request.method === "POST" && url.pathname === tokenPath) {
          const chunks: Buffer[] = []
          request.on("data", (chunk: Buffer) => chunks.push(chunk))
          request.on("end", () => {
            const body = Option.getOrUndefined(decodeCallback(Buffer.concat(chunks).toString("utf8")))
            const error = body?.error_description || body?.error
            const access = body?.access_token
            if (error || !access || body?.state !== state) {
              const message = error || (access ? "Invalid OAuth state" : "Missing access token")
              Effect.runFork(Deferred.fail(token, new Error(message)))
              response.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: message }))
              return
            }
            const expires = Number.parseInt(body.expires_in ?? "0", 10)
            Effect.runFork(
              Deferred.succeed(token, {
                access,
                expiresIn: Number.isFinite(expires) && expires > 0 ? expires : 60 * 60 * 24 * 30,
              }),
            )
            response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }))
          })
          return
        }
        response.writeHead(404).end("Not found")
      })
      const port = yield* listen(server)
      yield* Effect.addFinalizer(() => Effect.sync(() => server.close()))
      const redirect = `http://localhost:${port}${callbackPath}`
      return {
        mode: "auto" as const,
        url: `${authorizeEndpoint}?${new URLSearchParams({
          response_type: "token",
          client_id: clientID,
          redirect_uri: redirect,
          scope: "genai:read inference:query",
          state,
        })}`,
        instructions: "Complete authorization in your browser. This window will close automatically.",
        callback: Effect.gen(function* () {
          const payload = yield* Deferred.await(token)
          return Credential.OAuth.make({
            type: "oauth",
            methodID,
            access: payload.access,
            refresh: "",
            expires: (yield* Clock.currentTimeMillis) + payload.expiresIn * 1000,
          })
        }),
      }
    }),
} satisfies IntegrationOAuthMethodRegistration

export const DigitalOceanPlugin = define({
  id: "opencode.provider.digitalocean",
  effect: Effect.fn(function* (ctx) {
    const bus = yield* Bus.Service
    const client = yield* HttpClient.HttpClient
    const http = HttpClient.filterStatusOk(client)
    const shared = fetched.get(client) ?? { lock: Semaphore.makeUnsafe(1), byToken: new Map() }
    fetched.set(client, shared)
    const loading = Semaphore.makeUnsafe(1)
    const polling = yield* FiberHandle.make<void, never>()
    const loaded: { access?: string; routers: Routers } = { routers: [] }

    // Returns whether the active connection can sync routers.
    const load = Effect.fn("DigitalOceanPlugin.load")(function* () {
      const connection = yield* ctx.integration.connection.active(integrationID)
      const credential = connection
        ? yield* ctx.integration.connection.resolve(connection).pipe(Effect.orElseSucceed(() => undefined))
        : undefined
      if (credential?.type !== "oauth" || credential.methodID !== methodID) {
        loaded.access = undefined
        loaded.routers = []
        return false
      }
      if (loaded.access !== credential.access) {
        loaded.access = credential.access
        loaded.routers = []
      }
      if (credential.expires !== 0 && credential.expires <= (yield* Clock.currentTimeMillis)) return false
      const routers = yield* shared.lock.withPermit(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          const cached = shared.byToken.get(credential.access)
          if (cached && now - cached.checked < Duration.toMillis(refreshInterval)) return cached.routers
          const result = yield* http
            .execute(
              HttpClientRequest.get(routersEndpoint).pipe(
                HttpClientRequest.bearerToken(credential.access),
                HttpClientRequest.acceptJson,
                HttpClientRequest.setHeader("User-Agent", App.useragent(ctx.app)),
              ),
            )
            .pipe(
              Effect.flatMap(HttpClientResponse.schemaBodyJson(RoutersResponse)),
              Effect.timeout("10 seconds"),
              Effect.catch((cause) =>
                Effect.logWarning("failed to sync DigitalOcean routers", { cause }).pipe(Effect.as(undefined)),
              ),
            )
          if (!result) return undefined
          shared.byToken.set(credential.access, { checked: now, routers: result.model_routers })
          return result.model_routers
        }),
      )
      if (routers) loaded.routers = routers
      return true
    })

    yield* ctx.integration.transform((draft) => {
      draft.method.update(oauth)
    })
    yield* ctx.provider.transform((evt) => {
      if (!evt.get(providerID)) return
      for (const router of loaded.routers) {
        const id = `router:${router.name}`
        if (evt.get(providerID)?.models.has(Model.ID.make(id))) continue
        evt.models.update(providerID, id, (draft) => {
          draft.name = router.name
          draft.family = Model.Family.make("digitalocean-inference-routers")
          draft.capabilities = { tools: true, input: ["text"], output: ["text"] }
          draft.limit = { context: 128_000, output: 8_192 }
        })
      }
    })
    const tick = loading.withPermit(
      Effect.gen(function* () {
        const before = JSON.stringify(loaded.routers)
        const active = yield* load()
        if (JSON.stringify(loaded.routers) !== before) yield* ctx.provider.reload()
        return active
      }),
    )
    // Routers change without a credential event, so refresh them on an interval, but only while signed in.
    const sync = Effect.fnUntraced(function* () {
      if (!(yield* tick)) return yield* FiberHandle.clear(polling)
      yield* FiberHandle.run(
        polling,
        tick.pipe(Effect.delay(refreshInterval), Effect.repeat({ while: (active) => active }), Effect.asVoid),
        { onlyIfMissing: true },
      )
    })
    yield* bus.subscribe(Credential.Event.Switched).pipe(
      Stream.filter((event) => event.data.integrationID === integrationID),
      Stream.runForEach(() => sync()),
      Effect.forkScoped({ startImmediately: true }),
    )
    yield* sync().pipe(Effect.forkScoped)
  }),
} satisfies PluginInternal.InternalPlugin)

function listen(server: Server) {
  return Effect.callback<number, Error>((resume) => {
    const onError = (error: Error) => resume(Effect.fail(error))
    server.once("error", onError)
    server.listen(callbackPort, "localhost", () => {
      server.off("error", onError)
      resume(Effect.succeed(callbackPort))
    })
  }).pipe(
    Effect.mapError((cause) =>
      "code" in cause && cause.code === "EADDRINUSE"
        ? new Error(
            `DigitalOcean login needs local port ${callbackPort}, but it is already in use. Stop the process using that port and try again.`,
          )
        : cause,
    ),
  )
}
