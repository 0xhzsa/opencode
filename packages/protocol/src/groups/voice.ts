import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api"
import {
  ForbiddenError,
  InvalidRequestError,
  LocationNotFoundError,
  ServiceUnavailableError,
  UnauthorizedError,
} from "../errors.js"

export const VoiceRoute = Schema.Union([
  Schema.Struct({ type: Schema.Literal("key") }),
  Schema.Struct({
    type: Schema.Literal("console"),
    workspace: Schema.Struct({ id: Schema.String, name: Schema.String }),
  }),
]).annotate({ identifier: "VoiceRoute" })

export const VoiceTransportType = Schema.Literals(["webrtc", "websocket"]).annotate({
  identifier: "VoiceTransportType",
})

export const VoiceModel = Schema.Struct({
  model: Schema.String,
  provider: Schema.String,
  transports: Schema.Array(VoiceTransportType),
  available: Schema.Boolean,
  route: Schema.optional(VoiceRoute),
  unavailableReason: Schema.optional(Schema.String),
}).annotate({ identifier: "VoiceModel" })

export const VoiceWebRTCTransportInput = Schema.Struct({
  type: Schema.Literal("webrtc"),
  sdp: Schema.String,
  dcid: Schema.optional(Schema.Number),
}).annotate({ identifier: "VoiceWebRTCTransportInput" })

export const VoiceWebSocketTransportInput = Schema.Struct({
  type: Schema.Literal("websocket"),
}).annotate({ identifier: "VoiceWebSocketTransportInput" })

export const VoiceTransportInput = Schema.Union([VoiceWebRTCTransportInput, VoiceWebSocketTransportInput]).annotate({
  identifier: "VoiceTransportInput",
})

export const VoiceWebRTCTransport = Schema.Struct({
  type: Schema.Literal("webrtc"),
  sdp: Schema.String,
}).annotate({ identifier: "VoiceWebRTCTransport" })

export const VoiceWebSocketTransport = Schema.Struct({
  type: Schema.Literal("websocket"),
  url: Schema.String,
  token: Schema.String,
  expiresAt: Schema.Number,
}).annotate({ identifier: "VoiceWebSocketTransport" })

export const VoiceTransport = Schema.Union([VoiceWebRTCTransport, VoiceWebSocketTransport]).annotate({
  identifier: "VoiceTransport",
})

export const VoiceGroup = HttpApiGroup.make("server.voice")
  .add(
    HttpApiEndpoint.get("voice.models", "/api/experimental/voice/models", {
      success: Schema.Struct({
        data: Schema.Struct({
          models: Schema.Array(VoiceModel),
          default: Schema.optional(Schema.String),
        }),
      }).annotate({ identifier: "VoiceModelsResponse" }),
      error: [UnauthorizedError, ServiceUnavailableError, LocationNotFoundError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "experimental.voice.models",
        summary: "List voice models",
        description:
          "List voice models, available credential routes and the selected Console workspace. Console entitlement and budget are checked when creating a call. Requires pairing authorization.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("voice.session", "/api/experimental/voice/session", {
      payload: Schema.Struct({
        model: Schema.String,
        session: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
        transport: VoiceTransportInput,
        route: Schema.optional(VoiceRoute),
      }),
      success: Schema.Struct({
        data: Schema.Struct({
          transport: VoiceTransport,
          route: VoiceRoute,
          call: Schema.optional(Schema.Struct({ id: Schema.String })),
        }),
      }).annotate({ identifier: "VoiceSessionResponse" }),
      error: [UnauthorizedError, ForbiddenError, InvalidRequestError, ServiceUnavailableError, LocationNotFoundError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "experimental.voice.session",
        summary: "Create voice session",
        description:
          "Create a paired server-brokered voice session using a provider key or the selected Console workspace. Returns transport details and, for Console, a call reference for instruction updates. Audio connects directly to the provider. Pass the discovered route to pin the payer.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("voice.instructions", "/api/experimental/voice/session/:id/instructions", {
      params: Schema.Struct({ id: Schema.String }),
      payload: Schema.Struct({ instructions: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(65_536)) }),
      success: Schema.Struct({ data: Schema.Boolean }),
      error: [UnauthorizedError, ForbiddenError, InvalidRequestError, ServiceUnavailableError, LocationNotFoundError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "experimental.voice.instructions",
        summary: "Update voice instructions",
        description:
          "Forward backend instructions to Console as the call's original account and workspace. Only the pairing that created the call may update it. Call references last up to 24 hours and are lost when the server restarts.",
      }),
    ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "voice",
      description: "Experimental server-brokered voice session routes.",
    }),
  )
