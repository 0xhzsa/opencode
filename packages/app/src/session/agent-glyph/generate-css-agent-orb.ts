import { chromium } from "@playwright/test"
import { build } from "vite"
import solid from "vite-plugin-solid"
import path from "node:path"
import { mkdir, rm } from "node:fs/promises"

// Source: iOS AgentActivityGlyph.swift / ActivityGyro.swift / AgentActivityShaders.metal;
// gyro.ts is byte-identical to agents-chip@80f95c2737. Sample the actual DOM renderer, not a reimplementation.
// 1. 37 stationary sphere dots retain their own key-light shading and limb size.
// 2. A 0.2-wide Gaussian meridian rolls at 2π/1.8s on a 0.45rad tilt.
// 3. Its comet takes the maximum of the live band and 50/100/150ms trailing taps.
// 4. Light and freshness jointly drive radius, theme-specific alpha and the bright core.
// 5. Thinking has no noise: seeds only shift phase; the symmetric field repeats after 900ms.

export type OrbSample = { scale: number; base: number; core: number; x: number; y: number }
declare global {
  interface Window {
    orbSample: { step: (time: number) => void; read: () => OrbSample[] }
  }
}

const out = path.resolve("captures/css-orb-matched")
const root = path.resolve("packages/app/node_modules/.cache/orb-sampling")
await mkdir(root, { recursive: true })
await mkdir(out, { recursive: true })
await Bun.write(path.join(root, "index.html"), '<div id="root"></div><script type="module" src="/entry.tsx"></script>')
await Bun.write(
  path.join(root, "entry.tsx"),
  `
import { render } from "solid-js/web"
import { AgentOrb } from "${path.resolve("packages/app/src/session/agent-glyph/agent-orb.tsx")}"
import "${path.resolve("packages/ui/src/styles/tokens/theme.css")}"
import "${path.resolve("packages/ui/src/styles/tokens/colors.css")}"
const jobs = new Map()
let id = 0
window.requestAnimationFrame = (callback) => { jobs.set(++id, callback); return id }
window.cancelAnimationFrame = (key) => jobs.delete(key)
document.documentElement.dataset.colorScheme = new URLSearchParams(location.search).get("scheme") || "light"
window.orbSample = {
  step(time) { const next = [...jobs.values()]; jobs.clear(); next.forEach((job) => job(time)) },
  read() {
    const dots = [...document.querySelectorAll('[data-slot="agent-orb-dot"]')]
    return dots.filter((_, i) => i % 2 === 0).map((dot, i) => {
      const matrix = new DOMMatrix(dot.style.transform)
      return { scale: +matrix.a.toFixed(3), x: matrix.e, y: matrix.f, base: Number(dot.style.opacity), core: Number(dots[i*2+1].style.opacity) }
    })
  }
}
render(() => <AgentOrb activity="thinking" />, document.getElementById("root"))
`,
)
await build({
  configFile: false,
  root,
  plugins: [solid()],
  resolve: { dedupe: ["solid-js"] },
  build: { outDir: "dist" },
})
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (request) => {
    const pathname = new URL(request.url).pathname
    return new Response(Bun.file(path.join(root, "dist", pathname === "/" ? "index.html" : pathname)))
  },
})
const browser = await chromium.launch()
try {
  const samples = await Promise.all(
    ["light", "dark"].map(async (scheme) => {
      const page = await browser.newPage()
      await page.goto(`${server.url}?scheme=${scheme}`)
      await page.locator('[data-slot="agent-orb-dot"]').nth(73).waitFor()
      const sampled = await page.evaluate(() => {
        // Warm one revolution, then sample a full revolution at exactly 60Hz.
        for (let i = 1; i <= 108; i++) window.orbSample.step((i * 1000) / 60)
        const frames = [window.orbSample.read()]
        for (let i = 1; i <= 108; i++) {
          window.orbSample.step(1800 + (i * 1000) / 60)
          frames.push(window.orbSample.read())
        }
        // Core clipping creates corners between 60Hz frames. Refine at 240Hz before simplifying the curves.
        const refined = [window.orbSample.read()]
        for (let i = 1; i <= 432; i++) {
          window.orbSample.step(3600 + (i * 1000) / 240)
          refined.push(window.orbSample.read())
        }
        return { frames, refined }
      })
      await page.close()
      const still = await browser.newPage({ reducedMotion: "reduce" })
      await still.goto(`${server.url}?scheme=${scheme}`)
      await still.locator('[data-slot="agent-orb-dot"]').nth(73).waitFor()
      const rest = await still.evaluate(() => window.orbSample.read())
      await still.close()
      return { scheme, ...sampled, rest }
    }),
  )
  const periodError = Math.max(
    ...samples.flatMap((sample) =>
      sample.frames
        .slice(0, 55)
        .flatMap((frame, i) =>
          frame.flatMap((dot, j) =>
            ["scale", "base", "core"].map((key) =>
              Math.abs(dot[key as keyof OrbSample] - sample.frames[i + 54][j][key as keyof OrbSample]),
            ),
          ),
        ),
    ),
  )
  if (periodError > 0.0011) throw new Error(`900ms is not periodic: ${periodError}`)
  const css = samples[0].frames[0]
    .map((_, dot) => {
      const curve = (scheme: number, key: "scale" | "base" | "core") =>
        linear(samples[scheme].refined.slice(0, 217).map((frame) => frame[dot][key]))
      return (
        `[data-component="css-agent-orb"] > span:nth-child(${dot + 1}) {\n` +
        [
          `--orb-scale: ${curve(0, "scale")};`,
          `--orb-base-light: ${curve(0, "base")};`,
          `--orb-core-light: ${curve(0, "core")};`,
          `--orb-base-dark: ${curve(1, "base")};`,
          `--orb-core-dark: ${curve(1, "core")};`,
          `--orb-rest-scale: ${samples[0].rest[dot].scale};`,
          ...samples.flatMap((sample) => [
            `--orb-rest-base-${sample.scheme}: ${sample.rest[dot].base};`,
            `--orb-rest-core-${sample.scheme}: ${sample.rest[dot].core};`,
          ]),
        ]
          .map((line) => `  ${line}`)
          .join("\n") +
        "\n}"
      )
    })
    .join("\n\n")
  await Bun.write(
    path.join(out, "reference.json"),
    JSON.stringify({ period: 900, hz: 60, refinementHz: 240, periodError, samples }),
  )
  const generated = `/* Generated by generate-css-agent-orb.ts: 60Hz AgentOrb samples, 240Hz peak refinement. Do not hand-edit. */\n${css}\n`
  await Bun.write(path.join(import.meta.dir, "css-agent-orb.generated.css"), generated)
  await Bun.write(path.join(out, "css-agent-orb.generated.css"), generated)
  console.log(JSON.stringify({ periodMs: 900, periodError, cssBytes: css.length, gzipBytes: Bun.gzipSync(css).length }))
} finally {
  await browser.close()
  server.stop()
  await rm(root, { recursive: true, force: true })
}

// Piecewise-linear reduction; preserve corners and keep every sampled channel within 0.006.
function linear(values: number[]) {
  const keep = new Set([0, values.length - 1])
  function split(start: number, end: number) {
    const worst = values
      .slice(start + 1, end)
      .map((value, offset) => ({
        index: start + offset + 1,
        error: Math.abs(value - (values[start] + ((values[end] - values[start]) * (offset + 1)) / (end - start))),
      }))
      .sort((a, b) => b.error - a.error)[0]
    if (!worst || worst.error <= 0.006) return
    keep.add(worst.index)
    split(start, worst.index)
    split(worst.index, end)
  }
  split(0, values.length - 1)
  return `linear(${[...keep]
    .sort((a, b) => a - b)
    .map((i) => `${values[i]} ${+((i * 100) / (values.length - 1)).toFixed(3)}%`)
    .join(", ")})`
}
