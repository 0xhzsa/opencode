import { Location } from "@opencode/core/location"
import { LocationServiceMap } from "@opencode/core/location-services"
import { AbsolutePath } from "@opencode/core/schema"
import { Voice } from "@opencode/core/voice"
import { ForbiddenError, InvalidRequestError, ServiceUnavailableError } from "@opencode/protocol/errors"
import { Global } from "@opencode/util/global"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "../api"
import { ServerAuth } from "../auth"
import { awaitPlugins, locationErrors } from "../location"
import { pairedCaller } from "../middleware/authorization"

const voiceError = (error: Voice.Error) => {
  if (error._tag === "Voice.ForbiddenError") return new ForbiddenError({ message: error.message })
  if (error._tag === "Voice.InvalidRequestError") return new InvalidRequestError({ message: error.message })
  return new ServiceUnavailableError({ message: error.message, service: error.service })
}

export const VoiceHandler = HttpApiBuilder.group(Api, "server.voice", (handlers) =>
  Effect.gen(function* () {
    const auth = yield* ServerAuth.Config
    const global = yield* Global.Service
    const locations = yield* LocationServiceMap.Service
    const services = locations.get(Location.Ref.make({ directory: AbsolutePath.make(global.config) }))
    return handlers
      .handle(
        "voice.models",
        Effect.fn("server.voice.models")(
          function* () {
            yield* pairedCaller(auth)
            yield* awaitPlugins
            const voice = yield* Voice.Service
            return { data: yield* voice.models() }
          },
          Effect.provide(services),
          locationErrors,
        ),
      )
      .handle(
        "voice.session",
        Effect.fn("server.voice.session")(
          function* (request) {
            const caller = yield* pairedCaller(auth)
            yield* awaitPlugins
            const voice = yield* Voice.Service
            return { data: yield* voice.session(request.payload, caller).pipe(Effect.mapError(voiceError)) }
          },
          Effect.provide(services),
          locationErrors,
        ),
      )
      .handle(
        "voice.instructions",
        Effect.fn("server.voice.instructions")(
          function* (request) {
            const caller = yield* pairedCaller(auth)
            yield* awaitPlugins
            const voice = yield* Voice.Service
            yield* voice
              .instructions({ id: request.params.id, ...request.payload }, caller)
              .pipe(Effect.mapError(voiceError))
            return { data: true }
          },
          Effect.provide(services),
          locationErrors,
        ),
      )
  }),
)
