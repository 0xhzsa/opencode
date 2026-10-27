import { beforeEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const root = mkdtempSync(join(tmpdir(), "code-coach-test-"))
const IPC = join(root, "ipc")
process.env.COACH_DATA_DIR = root
process.env.COACH_VERDICT_MS = "80"
process.env.COACH_DECISION_MS = "80"

const { default: plugin } = await import("./index.ts")

type Hook = (event: any) => Promise<void> | void

function makeCtx(messages: unknown[] = []) {
  const hooks = new Map<string, Hook>()
  const ctx = {
    location: { directory: "C:/repo" },
    session: {
      hook: async (name: string, fn: Hook) => {
        hooks.set(name, fn)
        return () => {}
      },
      context: async () => messages,
    },
  }
  return { ctx, hooks }
}

async function serveOnce(action: "attach" | "hold", attachment = "", decision = "") {
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    const file = readdirSync(IPC).find((name) => name.startsWith("req-") && name.endsWith(".json"))
    if (file) {
      const id = file.slice(4, -5)
      const req = JSON.parse(readFileSync(join(IPC, file), "utf8"))
      writeFileSync(
        join(IPC, `res-${id}.json`),
        JSON.stringify(action === "attach" ? { action, attachment } : { action }),
      )
      if (action === "hold") {
        await new Promise((resolve) => setTimeout(resolve, 20))
        writeFileSync(join(IPC, `dec-${id}.json`), JSON.stringify({ action: "attach", attachment: decision }))
      }
      return req
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("plugin never wrote a request")
}

function textEvent(sessionID: string, messageID: string, text: string) {
  return { sessionID, messageID, prompt: { text } }
}

beforeEach(() => {
  rmSync(IPC, { recursive: true, force: true })
  mkdirSync(IPC, { recursive: true })
  writeFileSync(join(root, "daemon.pid"), String(process.pid))
  delete process.env.COACH_BYPASS
})

test("attach leaves the prompt byte-for-byte unchanged and injects on the same turn only", async () => {
  const text = "fix the login bug in auth.ts: the password compare is plaintext and there is no rate limiting"
  const { ctx, hooks } = makeCtx([{ id: "m1", type: "user", text: "we are working on auth.ts" }])
  await plugin.setup(ctx as never)

  const event = textEvent("s-attach", "m2", text)
  const served = serveOnce("attach", "Target: auth.ts\nCheck: npm test")
  await hooks.get("prompt")!(event)
  const req = await served

  expect(event.prompt.text).toBe(text)
  expect(req.text).toBe(text)
  expect(req.ctx.files).toContain("auth.ts")
  expect(req.ctx.turn).toBe(1)

  const system: any[] = []
  await hooks.get("context")!({
    sessionID: "s-attach",
    messages: [{ id: "m2", role: "user", content: [{ type: "text", text }] }],
    system,
  })
  expect(system).toHaveLength(1)
  expect(system[0].text).toContain("Target: auth.ts")

  const other: any[] = []
  await hooks.get("context")!({
    sessionID: "s-attach",
    messages: [{ id: "m3", role: "user", content: [{ type: "text", text: "a different turn" }] }],
    system: other,
  })
  expect(other).toHaveLength(0)
})

test("hold waits for the card decision and still sends the original words", async () => {
  const text = "fix the login bug in auth.ts, it fails on the second try and there is no rate limiting"
  const { ctx, hooks } = makeCtx()
  await plugin.setup(ctx as never)

  const event = textEvent("s-hold", "m4", text)
  const served = serveOnce("hold", "", "Target: auth.ts")
  await hooks.get("prompt")!(event)
  await served

  expect(event.prompt.text).toBe(text)
  const system: any[] = []
  await hooks.get("context")!({
    sessionID: "s-hold",
    messages: [{ id: "m4", role: "user", content: [{ type: "text", text }] }],
    system,
  })
  expect(system).toHaveLength(1)
  expect(system[0].text).toContain("Target: auth.ts")
})

test("a dead daemon sends the prompt untouched without writing a request", async () => {
  const text = "fix the login bug in auth.ts, it fails and there is no rate limiting"
  const { ctx, hooks } = makeCtx()
  await plugin.setup(ctx as never)
  rmSync(join(root, "daemon.pid"), { force: true })

  const event = textEvent("s-dead", "m5", text)
  const start = Date.now()
  await hooks.get("prompt")!(event)

  expect(Date.now() - start).toBeLessThan(500)
  expect(event.prompt.text).toBe(text)
  expect(readdirSync(IPC).filter((name) => name.startsWith("req-"))).toHaveLength(0)
})

test("COACH_BYPASS and system-shaped payloads never gate", async () => {
  const { ctx, hooks } = makeCtx()
  await plugin.setup(ctx as never)

  process.env.COACH_BYPASS = "1"
  await hooks.get("prompt")!(textEvent("s-bypass", "m6", "fix the login bug in auth.ts"))
  delete process.env.COACH_BYPASS

  await hooks.get("prompt")!(textEvent("s-system", "m7", "<system>compact the session summary</system>"))
  await hooks.get("prompt")!(textEvent("s-slash", "m8", "/review the auth.ts change"))

  expect(readdirSync(IPC).filter((name) => name.startsWith("req-"))).toHaveLength(0)
})
