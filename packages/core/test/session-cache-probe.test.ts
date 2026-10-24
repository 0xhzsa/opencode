import { describe, expect, test } from "bun:test"
import { CacheHint, Media, Message, SystemPart, ToolDefinition } from "@opencode/ai"
import { CacheProbe } from "@opencode/core/session/cache-probe"

const tool = (name: string, description = `${name} tool`) =>
  new ToolDefinition({ name, description, inputSchema: { type: "object", properties: {} } })

const usage = (input: { input?: number; read?: number; write?: number }) => ({
  input: input.input ?? 0,
  output: 100,
  reasoning: 0,
  cache: { read: input.read ?? 0, write: input.write ?? 0 },
})

const history = [
  Message.make({ id: "msg_1", role: "user", content: "Fix the bug" }),
  Message.make({ id: "msg_2", role: "assistant", content: "Looking" }),
  Message.make({
    id: "msg_3",
    role: "user",
    content: [Message.text("Here"), Message.media(Media.base64("aGVsbG8=", "image/png"))],
  }),
]

const base: CacheProbe.Request = {
  system: [SystemPart.make("You are opencode. Tools: read, edit"), SystemPart.make("AGENTS.md: be brief")],
  tools: [tool("read"), tool("edit")],
  messages: history,
  promptCacheKey: "key",
}

const step = (request: CacheProbe.Request, at = 0, model = "anthropic/claude#high") => ({
  print: CacheProbe.fingerprint({ request, model, at }),
  // The previous step wrote its whole 50k prompt; the current step read back only 2k.
  usage: at === 0 ? usage({ input: 10, write: 50_000 }) : usage({ read: 2_000, write: 48_010 }),
})

const diagnose = (current: CacheProbe.Request, options: { at?: number; model?: string } = {}) =>
  CacheProbe.diagnose(step(base), step(current, options.at ?? 1_000, options.model))

describe("CacheProbe.diagnose", () => {
  test("ignores a step that reads back the previous prompt", () => {
    const previous = step(base)
    const current = { ...step({ ...base, messages: [...history, Message.user("next")] }, 1_000) }
    expect(CacheProbe.diagnose(previous, { ...current, usage: usage({ read: 50_000, input: 20 }) })).toBeUndefined()
  })

  test("ignores drops within OpenAI's cache block size", () => {
    expect(CacheProbe.diagnose(step(base), { ...step(base, 1_000), usage: usage({ read: 49_500 }) })).toBeUndefined()
  })

  test("model switch", () => {
    expect(diagnose(base, { model: "openai/gpt" })).toEqual({
      missed: 48_010,
      reason: "model-switch",
      detail: "anthropic/claude#high→openai/gpt",
    })
  })

  test("tools changed names what was added and removed", () => {
    expect(diagnose({ ...base, tools: [tool("read"), tool("mcp_linear_create")] })).toMatchObject({
      reason: "tools-changed",
      detail: "+mcp_linear_create -edit",
    })
    expect(diagnose({ ...base, tools: [tool("read"), tool("edit", "new description")] })).toMatchObject({
      reason: "tools-changed",
      detail: "~edit",
    })
    expect(diagnose({ ...base, tools: [tool("edit"), tool("read")] })).toMatchObject({
      reason: "tools-changed",
      detail: "reordered",
    })
  })

  test("instructions changed", () => {
    expect(diagnose({ ...base, system: [base.system[0]!, SystemPart.make("AGENTS.md: be thorough")] })).toMatchObject({
      reason: "instructions-changed",
      detail: "system[1]",
    })
  })

  test("options changed", () => {
    expect(diagnose({ ...base, promptCacheKey: "other" })).toMatchObject({
      reason: "options-changed",
      detail: "promptCacheKey",
    })
  })

  test("compaction", () => {
    const checkpoint = Message.make({
      id: "msg_c",
      role: "user",
      content: "<conversation-checkpoint>\n<summary>fixed it</summary>\n</conversation-checkpoint>",
    })
    expect(diagnose({ ...base, messages: [checkpoint, Message.user("next")] })).toMatchObject({
      reason: "compaction",
      detail: "messages 3→2",
    })
  })

  test("history rewritten when an old image is cut", () => {
    const cut = Message.make({ id: "msg_3", role: "user", content: [Message.text("Here"), Message.text("[removed]")] })
    expect(diagnose({ ...base, messages: [history[0]!, history[1]!, cut] })).toMatchObject({
      reason: "history-rewritten",
      detail: "messages[2] user media-removed",
    })
  })

  test("history rewritten when a message is edited in place", () => {
    const edited = Message.make({ id: "msg_2", role: "assistant", content: "Lookinh" })
    expect(diagnose({ ...base, messages: [history[0]!, edited, history[2]!] })).toMatchObject({
      reason: "history-rewritten",
      detail: "messages[1] assistant edited",
    })
  })

  test("idle past the cache lifetime", () => {
    expect(diagnose(base, { at: 432_000 })).toEqual({ missed: 48_010, reason: "idle-ttl", idle: "7m12s" })
  })

  test("otherwise provider eviction", () => {
    expect(diagnose({ ...base, messages: [...history, Message.user("next")] })).toEqual({
      missed: 48_010,
      reason: "provider-eviction",
    })
  })

  test("a change still reports idle time when both apply", () => {
    expect(diagnose(base, { at: 600_000, model: "openai/gpt" })).toMatchObject({
      reason: "model-switch",
      idle: "10m0s",
    })
  })
})

describe("CacheProbe.fingerprint", () => {
  test("reuses hashes for unchanged messages instead of rehashing history", () => {
    const previous = CacheProbe.fingerprint({ request: base, model: "m", at: 0 })
    const current = CacheProbe.fingerprint(
      { request: { ...base, messages: [...history, Message.user("next")] }, model: "m", at: 1 },
      previous,
    )
    previous.messages.forEach((message, index) => expect(current.messages[index]).toBe(message))
  })

  test("ignores cache hints, which only move breakpoints", () => {
    const hinted = Message.make({
      id: "msg_1",
      role: "user",
      content: [{ type: "text", text: "Fix the bug", cache: new CacheHint({ type: "ephemeral" }) }],
    })
    expect(
      CacheProbe.fingerprint({ request: { ...base, messages: [hinted] }, model: "m", at: 0 }).messages[0]!.hash,
    ).toBe(
      CacheProbe.fingerprint({ request: { ...base, messages: [history[0]!] }, model: "m", at: 0 }).messages[0]!.hash,
    )
  })
})

describe("CacheProbe.Tracker", () => {
  test("stays quiet for providers that never report cache activity", () => {
    const tracker = new CacheProbe.Tracker()
    const first = tracker.observe("ses_1", { request: base, model: "m", at: 0 })!
    expect(tracker.settle("ses_1", first, usage({ input: 50_000 }))).toBeUndefined()
    const second = tracker.observe("ses_1", { request: base, model: "other", at: 1 })!
    expect(tracker.settle("ses_1", second, usage({ input: 50_100 }))).toBeUndefined()
  })

  test("reports a miss against the last settled step and forgets deleted sessions", () => {
    const tracker = new CacheProbe.Tracker()
    const first = tracker.observe("ses_1", { request: base, model: "m", at: 0 })!
    tracker.settle("ses_1", first, usage({ write: 50_000 }))
    const second = tracker.observe("ses_1", { request: { ...base, tools: [tool("read")] }, model: "m", at: 1 })!
    expect(tracker.settle("ses_1", second, usage({ read: 0, write: 49_000 }))).toMatchObject({
      reason: "tools-changed",
      detail: "-edit",
    })
    tracker.delete("ses_1")
    expect(tracker.size).toBe(0)
  })

  test("keeps at most 256 sessions", () => {
    const tracker = new CacheProbe.Tracker()
    const print = tracker.observe("ses", { request: base, model: "m", at: 0 })!
    for (let index = 0; index < 300; index++) tracker.settle(`ses_${index}`, print, usage({ write: 1 }))
    expect(tracker.size).toBe(256)
  })
})
