import type { Browser, Page } from "@playwright/test"
import type { OpenCodeEvent } from "@opencode/client/promise"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { openReviewLauncher } from "../../utils/side-panel"
import { benchmark, expect } from "../benchmark"
import { benchmarkLocation, setupTimelineBenchmark, textPartID } from "../timeline/session-timeline-benchmark.fixture"
import { largeSource, sampleReply, samples } from "./samples"

// Shiki against Pierre Highlights, switched through Knobs → Experiments ("Code highlighter"): a long code-heavy
// reply streaming into the timeline, a ~490 KB TypeScript diff opening in the review pane, and (with
// HIGHLIGHTER_STILLS set to a directory) stills plus computed token colours of the same code in light and dark.

const engines = ["shiki", "highlights"] as const

type Engine = (typeof engines)[number]

const sessionID = "ses_timeline_state_regression"

const assistantMessageID = textPartID.split(":")[0]!

const throttles = (process.env.HIGHLIGHTER_THROTTLES ?? "1,4").split(",").map(Number)

let sequence = 0

for (const engine of engines) {
  for (const throttle of throttles) {
    benchmark(`streams a code-heavy reply with ${engine} at ${throttle}x CPU`, async ({ page, browser, report }) => {
      benchmark.setTimeout(300_000)
      const loaded = await useEngine(page, engine)
      const marker = `stream-complete-${engine}`
      const reply = sampleReply(Number(process.env.HIGHLIGHTER_REPEAT ?? 3), marker)
      const deltas = chunk(reply, Number(process.env.HIGHLIGHTER_DELTA_CHARS ?? 48))
      const fixture = await setupTimelineBenchmark(page, { historyTurns: 2, eventBatch: 1 })
      fixture.transport.enqueue(textEvents(["Streaming"]))
      await expect(fixture.text).toContainText("Streaming")
      await fixture.waitForStableGeometry()

      const cdp = await page.context().newCDPSession(page)
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle })
      await browser.startTracing(page, { categories: traceCategories })
      const started = Date.now()
      fixture.transport.enqueue(deltas.map((delta) => textEvent(delta)))
      await expect(fixture.text).toContainText(marker, { timeout: 240_000 })
      const streamMs = Date.now() - started
      await fixture.waitForStableGeometry()
      const trace = summarizeTrace(await browser.stopTracing())
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 })
      const memory = await measureMemory(page, browser)

      const dom = await fixture.text.evaluate((root) => ({
        codeBlocks: root.querySelectorAll('[data-component="markdown-code"]').length,
        tokenSpans: root.querySelectorAll('[data-component="markdown-code"] code span').length,
      }))

      expect(dom.codeBlocks).toBe(samples.length * Number(process.env.HIGHLIGHTER_REPEAT ?? 3))
      report(
        { streamMs, ...trace, ...memory, ...dom, highlightsLoaded: loaded.highlights() },
        { engine, throttle, deltas: deltas.length, replyChars: reply.length },
      )
    })
  }

  benchmark(`opens a 490 KB TypeScript diff with ${engine}`, async ({ page, browser, report }) => {
    benchmark.setTimeout(480_000)
    const loaded = await useEngine(page, engine)
    const before = largeSource(Number(process.env.HIGHLIGHTER_DIFF_BYTES ?? 490_000))
    const after = before.replace(/limit = 200/g, (match, offset: number) => (offset % 7 === 0 ? "limit = 400" : match))
    const file = "src/review/large-store.ts"

    const fixture = await setupTimelineBenchmark(page, {
      historyTurns: 2,
      eventBatch: 1,
      vcsDiff: [{ file, patch: fullPatch(file, before, after), additions: 1, deletions: 1, status: "modified" }],
    })

    fixture.transport.enqueue(textEvents(["Ready"]))
    await expect(fixture.text).toContainText("Ready")
    await fixture.waitForStableGeometry()

    await page.getByRole("button", { name: "Toggle review" }).click()
    await expect(page.locator("#review-panel")).toBeVisible()
    await browser.startTracing(page, { categories: traceCategories })
    const started = Date.now()
    await openReviewLauncher(page.locator("#review-panel"))
    await page
      .waitForFunction(
        () =>
          [...document.querySelectorAll<HTMLElement>('#review-panel [data-component="file"][data-mode="diff"]')].some(
            (viewer) =>
              !!viewer
                .querySelector("diffs-container")
                ?.shadowRoot?.querySelector('[data-line] span[style*="--syntax-keyword"]'),
          ),
        undefined,
        { timeout: 300_000, polling: "raf" },
      )
      .catch(async (error) => {
        console.log("review pane", JSON.stringify(await describeReview(page)))
        throw error
      })
    const highlightedMs = Date.now() - started
    // Let the pool finish the rest of the file so its time lands in the trace.
    await page.waitForTimeout(3_000)
    const trace = summarizeTrace(await browser.stopTracing())
    const memory = await measureMemory(page, browser)
    report(
      { highlightedMs, ...trace, ...memory, highlightsLoaded: loaded.highlights() },
      { engine, diffChars: before.length, diffLines: before.split("\n").length },
    )
  })
}

benchmark.describe("stills", () => {
  benchmark.skip(!process.env.HIGHLIGHTER_STILLS, "set HIGHLIGHTER_STILLS to a directory")

  for (const engine of engines) {
    for (const scheme of ["light", "dark"] as const) {
      benchmark(`code in ${scheme} with ${engine}`, async ({ page, report }) => {
        benchmark.setTimeout(240_000)
        const directory = process.env.HIGHLIGHTER_STILLS!
        await mkdir(directory, { recursive: true })
        await useEngine(page, engine)
        await page.addInitScript((scheme) => localStorage.setItem("opencode-color-scheme", scheme), scheme)
        const marker = `stills-complete-${engine}`
        const before = samples[0].code
        const after = before.replace("limit = 200", "limit = 400").replace('"Untitled"', '"New session"')
        const file = "src/store.ts"

        const fixture = await setupTimelineBenchmark(page, {
          historyTurns: 0,
          eventBatch: 10_000,
          vcsDiff: [{ file, patch: fullPatch(file, before, after), additions: 2, deletions: 2, status: "modified" }],
        })

        await page.setViewportSize({ width: 1500, height: 1800 })
        fixture.transport.enqueue(textEvents(["Stills", ...chunk(sampleReply(1, marker), 400)]))
        await expect(fixture.text).toContainText(marker, { timeout: 60_000 })
        await fixture.waitForStableGeometry()

        const blocks = fixture.text.locator('[data-component="markdown-code"]')
        await expect(blocks).toHaveCount(samples.length)
        const tokens: Record<string, [string, string, string, string][]> = {}

        for (const [index, sample] of samples.entries()) {
          const block = blocks.nth(index)
          await block.scrollIntoViewIfNeeded()
          await page.waitForTimeout(150)
          await block.screenshot({ path: path.join(directory, `${engine}-${scheme}-${sample.lang}.png`) })
          tokens[sample.lang] = await block.evaluate((root) =>
            [...root.querySelectorAll<HTMLElement>("code span")].flatMap((span): [string, string, string, string][] => {
              if (span.children.length > 0) return []
              const style = getComputedStyle(span)

              return [[span.textContent ?? "", style.color, style.fontStyle, style.fontWeight]]
            }),
          )
        }

        await page.getByRole("button", { name: "Toggle review" }).click()
        await openReviewLauncher(page.locator("#review-panel"))
        const viewer = page.locator('#review-panel [data-component="file"][data-mode="diff"]').first()
        await expect
          .poll(() =>
            viewer.evaluate(
              (element) =>
                !!element
                  .querySelector("diffs-container")
                  ?.shadowRoot?.querySelector('span[style*="--syntax-keyword"]'),
            ),
          )
          .toBe(true)
          .catch(async (error) => {
            console.log("review pane", JSON.stringify(await describeReview(page)))
            throw error
          })
        await page.waitForTimeout(500)
        await page.locator("#review-panel").screenshot({ path: path.join(directory, `${engine}-${scheme}-review.png`) })
        tokens.review = await viewer.evaluate((element) =>
          [
            ...(element
              .querySelector("diffs-container")
              ?.shadowRoot?.querySelectorAll<HTMLElement>('[data-line] span[style*="color"]') ?? []),
          ]
            .slice(0, 400)
            .map((span) => {
              const style = getComputedStyle(span)

              return [span.textContent ?? "", style.color, style.fontStyle, style.fontWeight]
            }),
        )
        await writeFile(path.join(directory, `${engine}-${scheme}-tokens.json`), JSON.stringify(tokens))
        report({ blocks: samples.length }, { engine, scheme })
      })
    }
  }
})

function describeReview(page: Page) {
  return page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>("#review-panel")
    const viewers = [...(panel?.querySelectorAll<HTMLElement>('[data-component="file"]') ?? [])]
    const shadow = panel?.querySelector("diffs-container")?.shadowRoot

    return {
      text: panel?.textContent?.slice(0, 300),
      viewers: viewers.map((viewer) => viewer.dataset.mode),
      containers: panel?.querySelectorAll("diffs-container").length,
      lines: shadow?.querySelectorAll("[data-line]").length,
      spans: [...(shadow?.querySelectorAll("[data-line] span") ?? [])].slice(0, 6).map((span) => span.outerHTML),
      html: panel?.innerHTML.slice(0, 1500),
    }
  })
}

const traceCategories = ["devtools.timeline", "toplevel", "disabled-by-default-devtools.timeline", "v8.execute"]

async function useEngine(page: Page, engine: Engine) {
  // Knobs persist the option's index: Shiki is 0, Highlights is 1.
  await page.addInitScript(
    (value) => localStorage.setItem("opencode.motion.v2", JSON.stringify(value ? { "code.highlighter": value } : {})),
    engines.indexOf(engine),
  )
  const urls: string[] = []
  page.context().on("request", (request) => urls.push(request.url()))

  return { highlights: () => urls.some((url) => /highlights/i.test(url)) }
}

function textEvents(deltas: string[]) {
  return [
    event("session.text.started", { sessionID, assistantMessageID, ordinal: 0 }, true),
    ...deltas.map((delta) => textEvent(delta)),
  ]
}

function textEvent(delta: string) {
  return event("session.text.delta", { sessionID, assistantMessageID, ordinal: 0, delta })
}

function event(
  type: "session.text.started" | "session.text.delta",
  data: { sessionID: string; assistantMessageID: string; ordinal: number; delta?: string },
  durable = false,
) {
  sequence++

  const value = {
    id: `evt_highlighter_${sequence}`,
    created: 1700000002000 + sequence,
    type,
    data,
    location: { directory: benchmarkLocation.directory },
    durable: durable ? { aggregateID: sessionID, seq: sequence, version: 1 } : undefined,
  }

  // SAFETY: the wire shape of a text event as the timeline fixture sends it; the mock server forwards it verbatim.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- see SAFETY above
  return value as unknown as OpenCodeEvent
}

function chunk(text: string, size: number) {
  return Array.from({ length: Math.ceil(text.length / size) }, (_, index) =>
    text.slice(index * size, (index + 1) * size),
  )
}

function fullPatch(file: string, before: string, after: string) {
  const left = before.split("\n")
  const right = after.split("\n")

  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -1,${left.length} +1,${right.length} @@`,
    ...left.flatMap((line, index) => (line === right[index] ? [` ${line}`] : [`-${line}`, `+${right[index]}`])),
  ].join("\n")
}

type TraceEvent = {
  ph: string
  name: string
  pid: number
  tid: number
  ts: number
  dur?: number
  args?: { name?: string }
}

// Busy time per thread from top-level tasks: the renderer main thread, and every dedicated worker in that renderer.
function summarizeTrace(buffer: Buffer) {
  // SAFETY: Chrome's trace format, which `stopTracing` returns as JSON.
  const parsed = JSON.parse(buffer.toString()) as { traceEvents: TraceEvent[] } | TraceEvent[]
  const events = Array.isArray(parsed) ? parsed : parsed.traceEvents

  const names = new Map(
    events
      .filter((item) => item.ph === "M" && item.name === "thread_name")
      .map((item) => [`${item.pid}:${item.tid}`, item.args?.name ?? ""]),
  )

  const tasks = events
    .filter((item) => item.ph === "X" && /RunTask$/.test(item.name) && item.dur)
    .toSorted((a, b) => a.ts - b.ts)

  const threads = new Map<string, number[]>()
  const ends = new Map<string, number>()
  // Only outermost tasks: a RunTask nested inside another one is already part of its duration.
  tasks.forEach((item) => {
    const key = `${item.pid}:${item.tid}`

    if (item.ts < (ends.get(key) ?? 0)) return
    ends.set(key, item.ts + item.dur!)
    threads.set(key, [...(threads.get(key) ?? []), item.dur! / 1000])
  })

  const main = [...threads.entries()]
    .filter(([key]) => names.get(key) === "CrRendererMain")
    .toSorted((a, b) => sum(b[1]) - sum(a[1]))[0]

  const pid = main?.[0].split(":")[0]

  const workers = [...threads.entries()].filter(
    ([key]) => key.startsWith(`${pid}:`) && /DedicatedWorker/i.test(names.get(key) ?? ""),
  )

  const mainTasks = main?.[1] ?? []
  const workerTasks = workers.flatMap(([, durations]) => durations)

  return {
    mainBusyMs: round(sum(mainTasks)),
    mainLongTasks: mainTasks.filter((value) => value > 50).length,
    mainLongTaskMs: round(sum(mainTasks.filter((value) => value > 50))),
    mainBlockingMs: round(sum(mainTasks.map((value) => Math.max(0, value - 50)))),
    mainMaxTaskMs: round(Math.max(0, ...mainTasks)),
    workerBusyMs: round(sum(workerTasks)),
    workerLongTasks: workerTasks.filter((value) => value > 50).length,
    workerMaxTaskMs: round(Math.max(0, ...workerTasks)),
    workerThreads: workers.length,
  }
}

// JS heap of the page and of each dedicated worker, including array buffers such as WebAssembly memory.
async function measureMemory(page: Page, browser: Browser) {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send("HeapProfiler.collectGarbage")
  const main: HeapUsage = await cdp.send("Runtime.getHeapUsage")
  await cdp.detach()
  const session = await browser.newBrowserCDPSession()
  const targets = await session.send("Target.getTargets")
  const pending = new Map<number, (value: HeapUsage | undefined) => void>()
  session.on("Target.receivedMessageFromTarget", (message) => {
    // SAFETY: a worker's CDP reply to one of the requests below.
    const reply = JSON.parse(message.message) as { id: number; result?: HeapUsage }
    pending.get(reply.id)?.(reply.result)
  })

  const workers = await Promise.all(
    targets.targetInfos
      .filter((target) => target.type === "worker")
      .map(async (target, index) => {
        const attached = await session.send("Target.attachToTarget", { targetId: target.targetId, flatten: false })

        const call = (id: number, method: string) =>
          new Promise<HeapUsage | undefined>((resolve) => {
            pending.set(id, resolve)
            void session.send("Target.sendMessageToTarget", {
              sessionId: attached.sessionId,
              message: JSON.stringify({ id, method }),
            })
            setTimeout(() => resolve(undefined), 5_000)
          })

        await call(index * 10 + 1, "HeapProfiler.collectGarbage")

        return call(index * 10 + 2, "Runtime.getHeapUsage")
      }),
  )

  await session.detach()
  const heap = (usage: HeapUsage | undefined) => (usage ? usage.usedSize + (usage.backingStorageSize ?? 0) : 0)

  return {
    mainHeapMB: mb(heap(main)),
    workerHeapMB: mb(workers.reduce((total, usage) => total + heap(usage), 0)),
    workerHeaps: workers.map((usage) => mb(heap(usage))),
  }
}

type HeapUsage = { usedSize: number; totalSize: number; backingStorageSize?: number }

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0)
}

function round(value: number) {
  return Math.round(value * 10) / 10
}

function mb(bytes: number) {
  return Math.round((bytes / 1024 / 1024) * 10) / 10
}
