import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClientRequest } from "effect/http"
import { Image, ImageClient, Media } from "../../src/index.js"
import { VercelAIGateway } from "../../src/providers.js"
import { it } from "../lib/effect.js"
import { dynamicResponse, fixedResponse } from "../lib/http.js"

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

describe("Vercel AI Gateway Images", () => {
  it.effect("generates through the native image-model endpoint", () =>
    Effect.gen(function* () {
      const response = yield* Image.generate({
        model: VercelAIGateway.configure({
          apiKey: "test",
          baseURL: "https://gateway.test/v1",
          headers: { "x-default": "yes" },
        }).image("bfl/flux-kontext-pro"),
        prompt: "Make the circle blue",
        images: [Media.bytes(PNG, "image/png"), Media.url("https://example.test/style.webp")],
        mask: Media.bytes(PNG, "image/png"),
        n: 2,
        aspectRatio: "16:9",
        seed: 42,
        providerOptions: {
          gateway: { order: ["bfl"] },
          blackForestLabs: { safetyTolerance: 2 },
        },
        http: { body: { future: true } },
      })

      expect(response.images.map((image) => image.mediaType)).toEqual(["image/png", "image/png"])
      expect(response.usage).toEqual({ type: "tokens", input: 12, output: 272, total: 284 })
      expect(response.notices).toEqual([
        {
          type: "other",
          message: "Vercel AI Gateway Images reported unsupported mask: Applied to the whole image",
          providerMetadata: {
            gateway: { type: "unsupported", feature: "mask", details: "Applied to the whole image" },
          },
        },
        {
          type: "other",
          message: "Use aspectRatio",
          providerMetadata: { gateway: { type: "deprecated", setting: "size", message: "Use aspectRatio" } },
        },
      ])
      expect(response.providerMetadata).toEqual({
        blackForestLabs: { images: [{ seed: 42 }] },
        gateway: { cost: "0.08", generationId: "gen_1" },
      })
    }).pipe(
      Effect.provide(
        ImageClient.layer.pipe(
          Layer.provide(
            dynamicResponse((input) =>
              Effect.gen(function* () {
                const request = yield* HttpClientRequest.toWeb(input.request).pipe(Effect.orDie)
                expect(request.url).toBe("https://gateway.test/v4/ai/image-model")
                expect(request.headers.get("authorization")).toBe("Bearer test")
                expect(request.headers.get("x-default")).toBe("yes")
                expect(request.headers.get("ai-model-id")).toBe("bfl/flux-kontext-pro")
                expect(request.headers.get("ai-gateway-protocol-version")).toBe("0.0.1")
                expect(request.headers.get("ai-image-model-specification-version")).toBe("4")
                expect(JSON.parse(input.text)).toEqual({
                  prompt: "Make the circle blue",
                  n: 2,
                  aspectRatio: "16:9",
                  seed: 42,
                  providerOptions: { gateway: { order: ["bfl"] }, blackForestLabs: { safetyTolerance: 2 } },
                  files: [
                    { type: "file", mediaType: "image/png", data: "iVBORw0KGgo=" },
                    { type: "url", url: "https://example.test/style.webp" },
                  ],
                  mask: { type: "file", mediaType: "image/png", data: "iVBORw0KGgo=" },
                  future: true,
                })
                return input.respond(
                  JSON.stringify({
                    images: ["iVBORw0KGgo=", "iVBORw0KGgo="],
                    warnings: [
                      { type: "unsupported", feature: "mask", details: "Applied to the whole image" },
                      { type: "deprecated", setting: "size", message: "Use aspectRatio" },
                    ],
                    providerMetadata: {
                      blackForestLabs: { images: [{ seed: 42 }] },
                      gateway: { cost: "0.08", generationId: "gen_1" },
                    },
                    usage: { inputTokens: 12, outputTokens: 272, totalTokens: 284 },
                  }),
                  { headers: { "content-type": "application/json" } },
                )
              }),
            ),
          ),
        ),
      ),
    ),
  )

  it.effect("rejects format and invalid responses", () =>
    Effect.gen(function* () {
      const model = VercelAIGateway.configure({ apiKey: "test" }).image("openai/gpt-image-2")
      const unsupported = yield* Image.generate({ model, prompt: "test", format: "webp" }).pipe(
        Effect.provide(ImageClient.layer.pipe(Layer.provide(fixedResponse("{}")))),
        Effect.flip,
      )
      expect(unsupported.reason._tag).toBe("UnsupportedOperation")

      yield* Effect.forEach([{}, { images: [] }, { images: [1] }, { images: ["%%%"] }], (payload) =>
        Image.generate({ model, prompt: "test" }).pipe(
          Effect.provide(
            ImageClient.layer.pipe(
              Layer.provide(
                fixedResponse(JSON.stringify(payload), { headers: { "content-type": "application/json" } }),
              ),
            ),
          ),
          Effect.flip,
          Effect.tap((error) => Effect.sync(() => expect(error.reason._tag).toBe("InvalidProviderOutput"))),
        ),
      )
    }),
  )
})
