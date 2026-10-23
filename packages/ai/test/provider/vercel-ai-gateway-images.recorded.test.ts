import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Image } from "../../src/index.js"
import { VercelAIGateway } from "../../src/providers.js"
import { recordedTests } from "../recorded-test.js"

const model = VercelAIGateway.configure({ apiKey: process.env.AI_GATEWAY_API_KEY ?? "fixture" }).image(
  "meta/muse-image-1.0",
)

const recorded = recordedTests({
  prefix: "vercel-ai-gateway-images",
  provider: "vercel-ai-gateway",
  protocol: "vercel-ai-gateway-images",
  requires: ["AI_GATEWAY_API_KEY"],
  tags: ["image"],
})

describe("Vercel AI Gateway Images recorded", () => {
  recorded.effect(
    "generates an image",
    () =>
      Effect.gen(function* () {
        const response = yield* Image.generate({
          model,
          prompt: "A flat black square centered on a plain white background. No text.",
          size: "256x256",
          seed: 42,
          providerOptions: { gateway: { order: ["meta"], tags: ["opencode-image-test"] } },
        })

        expect(response.images).toHaveLength(1)
        expect(response.image.mediaType).toBe("image/webp")
        expect(response.usage?.type === "tokens" ? response.usage.output : undefined).toBeGreaterThan(0)
        expect(response.providerMetadata?.gateway?.cost).toBeString()
        // Muse Image ignores `seed`; the Gateway reports that as a warning instead of failing.
        expect(response.notices).toEqual([
          {
            type: "other",
            message: "Vercel AI Gateway Images reported unsupported seed",
            providerMetadata: { gateway: { type: "unsupported", feature: "seed" } },
          },
        ])
      }),
    60_000,
  )
})
