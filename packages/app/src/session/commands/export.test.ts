import { describe, expect, test } from "bun:test"
import type { SessionInfo, SessionMessageInfo } from "@opencode/client/promise"
import { createApiForServer } from "@/runtime/server/api"
import type { Platform } from "@/runtime/platform/platform"
import { fetchSessionExport, saveSessionExport, sessionExportFilename } from "./export"

const info: SessionInfo = {
  id: "ses_1",
  title: "Test Session",
  projectID: "project_test",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
  location: { directory: "/fixture" },
}

describe("sessionExportFilename", () => {
  test.each([
    [{ id: "ses_123", title: "Clone PR in worktree from fork" }, "clone-pr-in-worktree-from-fork.json"],
    [{ id: "ses_123", slug: "my-session-slug" }, "my-session-slug.json"],
    [{ id: "ses_123" }, "ses_123.json"],
  ])("names %o as %s", (session, filename) => {
    expect(sessionExportFilename(session)).toBe(filename)
  })
})

describe("fetchSessionExport", () => {
  test("export preserves original bytes on every page", async () => {
    const first: SessionMessageInfo = {
      id: "msg_1",
      type: "user",
      text: "one",
      time: { created: 1 },
      files: [{ name: "one.txt", mime: "text/plain", data: "YWJj", source: { type: "inline" } }],
    }

    const second: SessionMessageInfo = { ...first, id: "msg_2", text: "two" }
    const calls: Record<string, string>[] = []

    const api = createApiForServer({
      server: { url: "http://fixture" },
      fetch: Object.assign(
        async (input: string | URL | Request) => {
          const url = new URL(input instanceof Request ? input.url : String(input))

          if (!url.pathname.endsWith("/message")) return Response.json({ data: info })
          calls.push(Object.fromEntries(url.searchParams))
          const message = url.searchParams.has("cursor") ? second : first

          return Response.json({
            data: [{ ...message, files: url.searchParams.get("attachments") === "inline" ? message.files : [] }],
            cursor: url.searchParams.has("cursor") ? {} : { next: "page-2" },
          })
        },
        { preconnect: fetch.preconnect },
      ),
    })

    const result = await fetchSessionExport({
      sessionID: "ses_1",
      api,
    })

    expect(result).toEqual({ info, messages: [first, second] })
    expect(result).not.toHaveProperty("cursor")
    expect(calls).toEqual([
      { limit: "200", order: "asc", attachments: "inline" },
      { limit: "200", cursor: "page-2", attachments: "inline" },
    ])
  })
})

describe("saveSessionExport", () => {
  test.each([true, false])("writes pretty JSON to the native save dialog and returns %p", async (saved) => {
    const writes: string[][] = []

    const platform: Pick<Platform, "saveFile"> = {
      saveFile: async (options, content) => {
        writes.push([options.defaultPath ?? "", content])

        return saved
      },
    }

    expect(await saveSessionExport("session.json", { info, messages: [] }, platform)).toBe(saved)
    expect(writes).toEqual([["session.json", JSON.stringify({ info, messages: [] }, null, 2)]])
  })
})
