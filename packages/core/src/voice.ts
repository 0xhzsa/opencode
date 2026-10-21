export * as Voice from "./voice.js"

import { type AIError } from "@opencode/ai"
import {
  Realtime,
  type RealtimeSession,
  type RealtimeTransport,
  type RealtimeTransportInput,
  type RealtimeTransportType,
} from "@opencode/ai/experimental"
import { RequestExecutor } from "@opencode/ai/route"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { httpClient } from "@opencode/util/effect/app-node-platform"
import { Cache, Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { requestExecutor } from "./effect/app-node-platform.js"
import { Config } from "./config.js"
import { Integration } from "./integration.js"
import { IntegrationConnection } from "./integration/connection.js"
import { VoiceCalls } from "./voice-calls.js"

export type Route =
  | { readonly type: "key" }
  | {
      readonly type: "console"
      readonly workspace: { readonly id: string; readonly name: string }
    }

export interface ModelInfo {
  readonly model: string
  readonly provider: string
  readonly transports: readonly RealtimeTransportType[]
  readonly available: boolean
  readonly route?: Route
  readonly unavailableReason?: string
}

export interface Models {
  readonly models: readonly ModelInfo[]
  readonly default?: string
}

export interface SessionInput {
  readonly model: string
  readonly session?: RealtimeSession
  readonly transport: RealtimeTransportInput
  /** Pin the advertised payer; a changed route requires a new choice by the caller. */
  readonly route?: Route
}

export interface SessionResult {
  readonly transport: RealtimeTransport
  readonly route: Route
  readonly call?: { readonly id: string }
}

export class InvalidRequestError extends Schema.TaggedError<InvalidRequestError>()("Voice.InvalidRequestError", {
  message: Schema.String,
}) {}

export class UnavailableError extends Schema.TaggedError<UnavailableError>()("Voice.UnavailableError", {
  message: Schema.String,
  service: Schema.optional(Schema.String),
}) {}

export class ForbiddenError extends Schema.TaggedError<ForbiddenError>()("Voice.ForbiddenError", {
  message: Schema.String,
}) {}

export type Error = InvalidRequestError | UnavailableError | ForbiddenError

export interface Interface {
  readonly models: () => Effect.Effect<Models>
  readonly session: (input: SessionInput, caller: string) => Effect.Effect<SessionResult, Error>
  readonly instructions: (
    input: { readonly id: string; readonly instructions: string },
    caller: string,
  ) => Effect.Effect<void, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Voice") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const executor = yield* RequestExecutor.Service
    const integrations = yield* Integration.Service
    const config = yield* Config.Service
    const http = yield* HttpClient.HttpClient
    const calls = yield* VoiceCalls.Service

    const consoleCredential = Effect.fn("Voice.consoleCredential")(function* (connection: IntegrationConnection.Info) {
      // resolve owns the integration's five-minute refresh window and persists rotated tokens.
      const credential = yield* integrations.connection
        .resolve(connection)
        .pipe(
          Effect.mapError(
            () => new UnavailableError({ service: "opencode", message: "Reconnect OpenCode Console on the server" }),
          ),
        )
      if (!credential || credential.type === "external")
        return yield* new UnavailableError({ service: "opencode", message: "Connect OpenCode Console on the server" })
      const metadata = yield* Schema.decodeUnknownEffect(ConsoleMetadata)(credential.metadata).pipe(
        Effect.mapError(
          () =>
            new UnavailableError({
              service: "opencode",
              message: "Select an OpenCode Console workspace on the server",
            }),
        ),
      )
      const server = URL.parse(metadata.server ?? "https://opencode.ai/console")
      if (!server || server.protocol !== "https:" || server.username || server.password)
        return yield* new UnavailableError({
          service: "opencode",
          message: "Configure an HTTPS OpenCode Console address",
        })
      return {
        token: Redacted.make(credential.type === "oauth" ? credential.access : credential.key),
        workspace: { id: metadata.orgID, name: metadata.orgName ?? metadata.orgID },
        account: metadata.accountID,
        url: `${server.origin}/inference/openai/v1/live/sessions`,
      }
    })

    type ConsoleCredential = Effect.Success<ReturnType<typeof consoleCredential>>

    const post = (credential: ConsoleCredential, path: string, body: Record<string, unknown>) =>
      HttpClientRequest.post(`${credential.url}${path}`).pipe(
        HttpClientRequest.bearerToken(credential.token),
        HttpClientRequest.setHeader("x-opencode-org-id", credential.workspace.id),
        HttpClientRequest.bodyJson(body),
        Effect.flatMap((request) => HttpClient.withScope(http).execute(request)),
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
        Effect.mapError(
          () => new UnavailableError({ service: "opencode", message: "Couldn’t reach OpenCode Console" }),
        ),
        Effect.flatMap((response) =>
          response.status >= 200 && response.status < 300
            ? Effect.succeed(response)
            : Effect.fail(
                new UnavailableError({
                  service: "opencode",
                  message: `OpenCode Console refused the voice request (HTTP ${response.status})`,
                }),
              ),
        ),
      )

    // Integration lists the active credential first, then newer stored credentials, then non-empty env vars.
    const findConnection = (provider: string) =>
      integrations
        .get(Integration.ID.make(provider))
        .pipe(Effect.map((info) => info?.connections.find((item) => item.type === "env" || item.method === "key")))

    const resolve = Effect.fn("Voice.resolve")(function* (engine: (typeof Realtime.engines)[number]) {
      const preference = Config.latest(yield* config.entries(), "experimental")?.voice?.route
      const key = yield* findConnection(engine.provider)
      if (key && preference !== "console") return { type: "key" as const, connection: key }
      if (preference !== "key" && engine.id === "openai-live") {
        // Only the selected Console connection may pay, never another stored account.
        const connection = yield* integrations.connection.active(Integration.ID.make("opencode"))
        if (connection)
          return { type: "console" as const, connection, credential: yield* consoleCredential(connection) }
      }
      return yield* new UnavailableError({
        service: engine.provider,
        message:
          preference === "console"
            ? engine.id === "openai-live"
              ? "Connect OpenCode Console and select a workspace on the server"
              : "OpenCode Console voice supports GPT-Live only"
            : missingKeyMessage[engine.provider],
      })
    })

    const models = Effect.fn("Voice.models")(function* () {
      const list = yield* Effect.forEach(Realtime.engines, (engine) =>
        resolve(engine).pipe(
          Effect.match({
            onSuccess: (resolved) => ({
              model: engine.model,
              provider: engine.provider,
              transports: engine.transports,
              available: true,
              route:
                resolved.type === "console"
                  ? { type: "console" as const, workspace: resolved.credential.workspace }
                  : { type: "key" as const },
            }),
            onFailure: (error) => ({
              model: engine.model,
              provider: engine.provider,
              transports: engine.transports,
              available: false,
              unavailableReason: error.message,
            }),
          }),
        ),
      )
      const first = list.find((item) => item.available)?.model
      return first ? { models: list, default: first } : { models: list }
    })

    const session = Effect.fn("Voice.session")(function* (input: SessionInput, caller: string) {
      const engine = Realtime.engine(input.model)
      if (!engine) return yield* new InvalidRequestError({ message: `Unsupported voice model: ${input.model}` })

      if (!engine.transports.some((type) => type === input.transport.type))
        return yield* new InvalidRequestError({
          message: `${input.model} only supports ${engine.transports.join(", ")} transport`,
        })
      const resolved = yield* resolve(engine)
      if (
        input.route &&
        (input.route.type !== resolved.type ||
          (input.route.type === "console" &&
            resolved.type === "console" &&
            input.route.workspace.id !== resolved.credential.workspace.id))
      )
        return yield* new UnavailableError({ message: "The voice payer changed; select the voice route again" })
      if (resolved.type === "console") {
        const credential = resolved.credential
        const response = yield* post(credential, "", {
          session: { ...input.session, model: input.model },
          transport: input.transport,
        }).pipe(
          Effect.flatMap((response) =>
            HttpClientResponse.schemaBodyJson(ConsoleSession)(response).pipe(
              Effect.mapError(
                () =>
                  new UnavailableError({
                    service: "opencode",
                    message: "OpenCode Console returned an invalid voice session",
                  }),
              ),
            ),
          ),
          Effect.scoped,
        )
        yield* Cache.set(calls, response.session.id, {
          caller,
          connection: resolved.connection,
          workspace: credential.workspace.id,
          account: credential.account,
          url: credential.url,
        })
        return {
          transport: { type: "webrtc" as const, sdp: response.transport.sdp },
          route: { type: "console" as const, workspace: credential.workspace },
          call: { id: response.session.id },
        }
      }
      const credential = yield* integrations.connection
        .resolve(resolved.connection)
        .pipe(Effect.mapError((error) => new UnavailableError({ service: engine.provider, message: error.message })))
      if (credential?.type !== "key")
        return yield* new UnavailableError({
          service: engine.provider,
          message: missingKeyMessage[engine.provider],
        })

      const transport = yield* Realtime.connect({ ...input, apiKey: Redacted.make(credential.key) }).pipe(
        Effect.provideService(RequestExecutor.Service, executor),
        Effect.mapError(
          (error: AIError): Error =>
            error.reason._tag === "InvalidRequest" || error.reason._tag === "UnsupportedOperation"
              ? new InvalidRequestError({ message: error.message })
              : new UnavailableError({ message: error.message, service: engine.provider }),
        ),
      )
      return { transport, route: { type: "key" as const } }
    })

    const instructions = Effect.fn("Voice.instructions")(function* (
      input: { readonly id: string; readonly instructions: string },
      caller: string,
    ) {
      const call = Option.getOrUndefined(yield* Cache.getOption(calls, input.id))
      if (!call || call.caller !== caller)
        return yield* new ForbiddenError({ message: "This voice call does not belong to this pairing" })
      const credential = yield* consoleCredential(call.connection)
      if (
        credential.workspace.id !== call.workspace ||
        credential.account !== call.account ||
        credential.url !== call.url
      )
        return yield* new UnavailableError({
          service: "opencode",
          message: "The voice call’s Console connection changed; start a new call",
        })
      yield* post(credential, `/${encodeURIComponent(input.id)}/instructions`, {
        instructions: input.instructions,
      }).pipe(Effect.asVoid, Effect.scoped)
    })

    return Service.of({ models, session, instructions })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Integration.node, Config.node, requestExecutor, httpClient, VoiceCalls.node],
})

const missingKeyMessage = {
  openai:
    "Voice needs an OpenAI API key on the server (a stored key or OPENAI_API_KEY), or an OpenCode Console workspace for GPT-Live. ChatGPT sign-in can't start voice sessions.",
  xai: "Voice needs an xAI API key on the server (a stored key or XAI_API_KEY).",
  google:
    "Voice needs a Google API key on the server (a stored key, GEMINI_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY, or GOOGLE_API_KEY).",
} as const

const ConsoleMetadata = Schema.Struct({
  orgID: Schema.String.check(Schema.isNonEmpty()),
  orgName: Schema.optional(Schema.String),
  accountID: Schema.optional(Schema.String),
  server: Schema.optional(Schema.String),
})

const ConsoleSession = Schema.Struct({
  session: Schema.Struct({ id: Schema.String.check(Schema.isNonEmpty()) }),
  transport: Schema.Struct({ sdp: Schema.String.check(Schema.isNonEmpty()) }),
})
