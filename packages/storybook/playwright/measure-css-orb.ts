import { chromium } from "@playwright/test"
import { build } from "vite"
import solid from "vite-plugin-solid"
import path from "node:path"
import { mkdir, rm } from "node:fs/promises"

// Isolated production bundles, with no Storybook, recording or sampling rAF in the measured page.
const baseline = process.argv.includes("--baseline")
const out = path.resolve("captures/css-orb")
const root = path.resolve("packages/storybook/node_modules/.cache/css-orb-rig")
await mkdir(root, { recursive: true })
await Bun.write(path.join(root, "index.html"), '<div id="root"></div><script type="module" src="/entry.tsx"></script>')
await Bun.write(
  path.join(root, "entry.tsx"),
  `import { render } from "solid-js/web"
import { For } from "solid-js"
import { AgentOrb } from "${path.resolve("packages/app/src/session/agent-glyph/agent-orb.tsx")}"
${baseline ? "" : `import { CssAgentOrb } from "${path.resolve("packages/app/src/session/agent-glyph/css-agent-orb.tsx")}"`}
import "${path.resolve("packages/ui/src/styles/tokens/theme.css")}"
import "${path.resolve("packages/ui/src/styles/tokens/colors.css")}"
const params = new URLSearchParams(location.search)
document.documentElement.dataset.colorScheme = params.get("scheme") || "light"
document.body.style.cssText = "background:var(--v2-background-bg-base);display:flex;gap:12px;padding:32px"
render(() => <For each={Array.from({length:Number(params.get("count") || 1)})}>{() =>
${baseline ? '<AgentOrb activity="thinking" />' : 'params.get("variant") === "css-orb" ? <CssAgentOrb /> : <AgentOrb activity="thinking" />'}
}</For>, document.getElementById("root")!)
`,
)
await build({
  configFile: false,
  root,
  plugins: [solid()],
  resolve: { dedupe: ["solid-js"] },
  build: { outDir: "dist", emptyOutDir: true, minify: true },
})
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (request) => {
    const url = new URL(request.url)
    return new Response(Bun.file(path.join(root, "dist", url.pathname === "/" ? "index.html" : url.pathname)))
  },
})
const browser = await chromium.launch({
  args: ["--disable-background-timer-throttling", "--disable-renderer-backgrounding"],
})
const results = []
try {
  for (const count of [1, 3, 12]) {
    for (const variant of baseline ? ["orb"] : ["orb", "css-orb"]) {
      const page = await browser.newPage()
      await page.goto(`${server.url}?count=${count}&variant=${variant}`)
      await page
        .locator(`[data-component="${variant === "orb" ? "agent-orb" : "css-agent-orb"}"]`)
        .nth(count - 1)
        .waitFor()
      await page.waitForTimeout(1500)
      const cdp = await page.context().newCDPSession(page)
      await cdp.send("Performance.enable")
      const before = await cdp.send("Performance.getMetrics")
      const events: { name: string; ph: string; dur?: number }[] = []
      cdp.on("Tracing.dataCollected", (event) =>
        events.push(...event.value.map((entry) => ({ name: entry.name, ph: entry.ph, dur: Number(entry.dur ?? 0) }))),
      )
      await cdp.send("Tracing.start", { categories: "devtools.timeline", transferMode: "ReportEvents" })
      await page.waitForTimeout(5000)
      const after = await cdp.send("Performance.getMetrics")
      const complete = new Promise<void>((resolve) => cdp.once("Tracing.tracingComplete", () => resolve()))
      await cdp.send("Tracing.end")
      await complete
      const delta = (name: string) =>
        after.metrics.find((m) => m.name === name)!.value - before.metrics.find((m) => m.name === name)!.value
      const frames = delta("Timestamp") * 60
      const duration = (name: string) =>
        events.filter((e) => e.name === name && e.ph === "X").reduce((sum, e) => sum + (e.dur ?? 0), 0) / 1000 / frames
      results.push({
        count,
        variant,
        seconds: delta("Timestamp"),
        normalizedHz: 60,
        scriptMsPerFrame: (delta("ScriptDuration") * 1000) / frames,
        mainThreadMsPerFrame: (delta("TaskDuration") * 1000) / frames,
        animationCallbackMsPerFrame: duration("FireAnimationFrame"),
        styleMsPerFrame: duration("UpdateLayoutTree"),
        paintMsPerFrame: duration("Paint"),
        animationCallbacks: events.filter((e) => e.name === "FireAnimationFrame").length,
        msPerAnimationCallback:
          events
            .filter((e) => e.name === "FireAnimationFrame" && e.ph === "X")
            .reduce((sum, e) => sum + (e.dur ?? 0), 0) /
          1000 /
          Math.max(1, events.filter((e) => e.name === "FireAnimationFrame").length),
      })
      await page.close()
    }
  }
  await Bun.write(
    path.join(out, baseline ? "baseline.json" : "cost.json"),
    JSON.stringify({ browser: browser.version(), results }, null, 2),
  )
  console.log(JSON.stringify(results, null, 2))
} finally {
  await browser.close()
  server.stop()
  await rm(root, { recursive: true, force: true })
}
