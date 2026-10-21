import { expect } from "bun:test"
import { RequestExecutor } from "@opencode/ai/route"
import { Credential } from "@opencode/core/credential"
import { Integration } from "@opencode/core/integration"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { OpencodePlugin } from "@opencode/core/plugin/provider/opencode"
import { Voice } from "@opencode/core/voice"
import { VoiceCalls } from "@opencode/core/voice-calls"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { testEffect } from "./lib/effect"
import { PluginTestLayer } from "./plugin/fixture"

const it = testEffect(PluginTestLayer)

it.effect(
  "refreshes near-expiry Console credentials through the registered integration before setup and control",
  () => {
    const requests: HttpClientRequest.HttpClientRequest[] = []
    const http = HttpClient.make((request) =>
      Effect.sync(() => {
        requests.push(request)
        return HttpClientResponse.fromWeb(
          request,
          request.url.endsWith("/auth/device/token")
            ? Response.json({
                access_token: "new-access",
                refresh_token: "new-refresh",
                expires_in: 600,
                org_id: "org-team",
              })
            : request.url.endsWith("/api/v2/config")
              ? Response.json({ providers: {} })
              : request.url.endsWith("/instructions")
                ? Response.json({ ok: true })
                : Response.json({ session: { id: "call-refresh" }, transport: { sdp: "answer" } }),
        )
      }),
    )
    return Effect.gen(function* () {
      const now = 0
      const credentials = yield* Credential.Service
      const value = Credential.OAuth.make({
        type: "oauth",
        methodID: Integration.MethodID.make("device"),
        access: "old-access",
        refresh: "old-refresh",
        expires: now + 600_000,
        metadata: { server: "https://opencode.ai/console", orgID: "org-team", orgName: "Team", accountID: "user-one" },
      })
      const saved = yield* credentials.create({ integrationID: Integration.ID.make("opencode"), value })
      const plugin = yield* Plugin.Service
      const host = yield* PluginHost.make(plugin)
      yield* OpencodePlugin.effect(host)
      yield* credentials.update(saved.id, { value: { ...value, expires: now + 60_000 } })
      yield* Effect.gen(function* () {
        const voice = yield* Voice.Service
        yield* voice.session({ model: "gpt-live-1", transport: { type: "webrtc", sdp: "offer" } }, "phone")
        expect(requests.filter((request) => request.url.endsWith("/auth/device/token"))).toHaveLength(1)
        expect(requests.at(-1)?.headers.authorization).toBe("Bearer new-access")
        expect((yield* credentials.get(saved.id))?.value).toMatchObject({
          access: "new-access",
          refresh: "new-refresh",
        })
        const refresh = requests.find((request) => request.url.endsWith("/auth/device/token"))
        if (!refresh) throw new Error("Expected refresh")
        const web = yield* HttpClientRequest.toWeb(refresh)
        expect(yield* Effect.promise(() => web.json())).toEqual({
          grant_type: "refresh_token",
          refresh_token: "old-refresh",
          client_id: "opencode-cli",
        })
        yield* credentials.update(saved.id, {
          value: { ...value, access: "new-access", refresh: "new-refresh", expires: now + 60_000 },
        })
        yield* voice.instructions({ id: "call-refresh", instructions: "Updated" }, "phone")
        expect(requests.filter((request) => request.url.endsWith("/auth/device/token"))).toHaveLength(2)
        expect(requests.at(-1)?.headers.authorization).toBe("Bearer new-access")
        expect(requests.at(-1)?.headers["x-opencode-org-id"]).toBe("org-team")
      }).pipe(Effect.provide(Voice.layer.pipe(Layer.provide(RequestExecutor.layer), Layer.provide(VoiceCalls.layer))))
    }).pipe(Effect.provideService(HttpClient.HttpClient, http))
  },
)
