import { Effect, Schema } from "effect"
import type { HttpClientResponse } from "effect/http"
import { ImageModel, ImageResponse, type ImageRequestFor } from "../image.js"
import type { Media } from "../media.js"
import { MediaProtocol } from "../route/media-protocol.js"
import { MediaRoute } from "../route/media.js"
import { ProviderMetadata, mergeJsonRecords } from "../schema/index.js"
import { JsonObject, ProviderShared, optionalNullish } from "./shared.js"
import type { GatewayOptions } from "./utils/gateway-options.js"
import { MediaInput } from "./utils/media-input.js"

const route = MediaProtocol.identity({
  id: "vercel-ai-gateway-images",
  name: "Vercel AI Gateway Images",
  provider: "vercel-ai-gateway",
})
export const DEFAULT_BASE_URL = "https://ai-gateway.vercel.sh/v4/ai"
export const PATH = "/image-model"

// ---------------------------------------------------------------------------
// 1. Public model input
// ---------------------------------------------------------------------------

/**
 * Sent as the Gateway's `providerOptions`: `gateway` holds routing, fallback, BYOK, and attribution options, and every
 * other key is an upstream namespace such as `openai` or `blackForestLabs`.
 */
export type VercelAIGatewayImageOptions = {
  readonly gateway?: GatewayOptions
} & Record<string, unknown>

export type Request = ImageRequestFor<VercelAIGatewayImageOptions>

// ---------------------------------------------------------------------------
// 2. Response schema
// ---------------------------------------------------------------------------

const Warning = Schema.StructWithRest(
  Schema.Struct({
    type: Schema.String,
    feature: optionalNullish(Schema.String),
    details: optionalNullish(Schema.String),
    message: optionalNullish(Schema.String),
  }),
  [JsonObject],
)

const VercelImageResponse = Schema.Struct({
  images: Schema.Array(Schema.String),
  warnings: optionalNullish(Schema.Array(Warning)),
  providerMetadata: optionalNullish(ProviderMetadata),
  usage: optionalNullish(
    Schema.Struct({
      inputTokens: optionalNullish(Schema.Number),
      outputTokens: optionalNullish(Schema.Number),
      totalTokens: optionalNullish(Schema.Number),
    }),
  ),
})

// ---------------------------------------------------------------------------
// 5. Request body construction
// ---------------------------------------------------------------------------

const file = Effect.fnUntraced(function* (asset: Media.Asset) {
  const inline = asset.inline()
  if (inline) return { type: "file", mediaType: inline.mime, data: inline.base64 }
  const url = ProviderShared.mediaUrl(asset)
  if (url) return { type: "url", url }
  return yield* ProviderShared.invalidRequest(`${route.name} accepts inline images or http(s) URLs`)
})

const fromRequest = Effect.fn("VercelAIGatewayImages.fromRequest")(function* (request: Request) {
  const files = yield* Effect.forEach(request.images ?? [], file)
  return MediaProtocol.json(
    mergeJsonRecords(
      {
        prompt: request.prompt,
        // The Gateway rejects requests without `n`.
        n: request.n ?? 1,
        size: request.size,
        aspectRatio: request.aspectRatio,
        seed: request.seed,
        providerOptions: request.providerOptions,
        files: files.length === 0 ? undefined : files,
        mask: request.mask === undefined ? undefined : yield* file(request.mask),
      },
      request.http?.body,
    ) ?? {},
  )
})

// ---------------------------------------------------------------------------
// 6. Response decoding
// ---------------------------------------------------------------------------

const decodeDocument = route.decodeJson(VercelImageResponse)

const decodeResponse = Effect.fn("VercelAIGatewayImages.decodeResponse")(function* (
  response: HttpClientResponse.HttpClientResponse,
) {
  const output = yield* decodeDocument(response)
  const decoded = output.value
  if (decoded.images.length === 0) return yield* output.invalid(`${route.name} returned no images`)
  const warnings = decoded.warnings ?? []
  const usage = decoded.usage
  return new ImageResponse({
    // The Gateway returns bare base64 without a media type; the bytes are sniffed instead.
    images: yield* Effect.forEach(decoded.images, (image, index) =>
      MediaInput.decodedAsset(output.invalid, `${route.name} result ${index}`, image, undefined),
    ),
    usage: usage && { type: "tokens", input: usage.inputTokens, output: usage.outputTokens, total: usage.totalTokens },
    // Upstreams that ignore a field (such as `seed` or `aspectRatio`) report it here instead of failing.
    notices:
      warnings.length === 0
        ? undefined
        : warnings.map((warning) => ({
            type: "other" as const,
            message:
              warning.message ??
              `${route.name} reported ${warning.type} ${warning.feature}${
                warning.details === undefined ? "" : `: ${warning.details}`
              }`,
            providerMetadata: { gateway: warning },
          })),
    providerMetadata: decoded.providerMetadata,
  })
})

// ---------------------------------------------------------------------------
// 7. Protocol and route
// ---------------------------------------------------------------------------

export const protocol = MediaProtocol.inline<Request, ImageResponse>(route, {
  unsupported: ["format"],
  body: { from: fromRequest },
  response: { decode: decodeResponse },
})

export const model = (input: MediaRoute.ModelInput) =>
  ImageModel.fromRoute<VercelAIGatewayImageOptions>(
    {
      protocol,
      baseURL: DEFAULT_BASE_URL,
      path: PATH,
      headers: {
        "ai-gateway-protocol-version": "0.0.1",
        "ai-image-model-specification-version": "4",
        "ai-model-id": input.id,
      },
    },
    input,
  )

export const VercelAIGatewayImages = {
  protocol,
  model,
} as const
