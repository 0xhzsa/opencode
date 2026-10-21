import { WorkerPoolManager } from "@pierre/diffs/worker"
import ShikiWorkerUrl from "@pierre/diffs/worker/worker.js?worker&url"
import { registerOpenCodeTheme } from "@opencode/ui/context/marked-theme-register"
import { codeHighlighter, type CodeHighlighter } from "./highlighter"

registerOpenCodeTheme()

export function workerFactory(): Worker {
  return new Worker(ShikiWorkerUrl, { type: "module" })
}

function createPool(lineDiffType: "none" | "word-line", highlighter: CodeHighlighter) {
  const pool = new WorkerPoolManager(
    {
      workerFactory,
      // poolSize defaults to 8. More workers = more parallelism but
      // also more memory. Too many can actually slow things down.
      // NOTE: 2 is probably better for OpenCode, as I think 8 might be
      // a bit overkill, especially because Safari has a significantly slower
      // boot up time for workers
      poolSize: 2,
    },
    {
      theme: "OpenCode",
      lineDiffType,
      // Pierre renders with the pool's options, not the viewer's, whenever the pool works. The "none" pool only
      // serves diffs above the large-file threshold, so it carries the plain-text fallback the viewer requests.
      ...(lineDiffType === "none" && { maxLineDiffLength: 0, tokenizeMaxLineLength: 1 }),
      preferredHighlighter: highlighter === "highlights" ? "highlights" : "shiki-wasm",
    },
  )

  void pool.initialize()

  return pool
}

// One pool per diff mode and highlighter: a worker loads a single highlighter type, so switching highlighters
// moves viewers to another pool rather than reconfiguring this one.
const pools = new Map<string, WorkerPoolManager>()

export function getWorkerPool(lineDiffType: "none" | "word-line" = "word-line"): WorkerPoolManager | undefined {
  if (typeof window === "undefined") return

  const highlighter = codeHighlighter()
  const key = `${lineDiffType}:${highlighter}`
  const existing = pools.get(key)

  if (existing) return existing

  const pool = createPool(lineDiffType, highlighter)
  pools.set(key, pool)

  return pool
}

export function getWorkerPools() {
  const pool = getWorkerPool()

  return {
    unified: pool,
    split: pool,
  }
}
