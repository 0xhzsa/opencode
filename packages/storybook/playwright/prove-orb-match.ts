import { chromium } from "@playwright/test"
import { build } from "vite"
import solid from "vite-plugin-solid"
import path from "node:path"
import { mkdir, rm } from "node:fs/promises"
import type {} from "../../app/src/session/agent-glyph/css-agent-orb.fixture"

const out = path.resolve("captures/css-orb-matched")
const root = path.resolve("packages/storybook/node_modules/.cache/orb-match")
await mkdir(path.join(out, "frames"), { recursive: true })
await mkdir(root, { recursive: true })
await Bun.write(
  path.join(root, "index.html"),
  `<style>body{margin:0}</style><div id="root"></div><script type="module" src="${path.resolve("packages/app/src/session/agent-glyph/css-agent-orb.fixture.tsx")}"></script>`,
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
  const page = await browser.newPage({ viewport: { width: 1080, height: 720 }, deviceScaleFactor: 1 })
  await page.goto(String(server.url))
  await page.locator('[data-component="css-agent-orb"]').nth(9).waitFor()
  await page.evaluate(() => window.orbMatch.warm())
  // Validate independently at 480Hz, including both 900ms seams and points between the generator's samples.
  const frames = await page.evaluate(() =>
    Array.from({ length: 865 }, (_, i) => {
      const time = (i * 1000) / 480
      window.orbMatch.step(time)
      return { time, samples: window.orbMatch.errors() }
    }),
  )
  const dots = frames.flatMap((frame) => frame.samples.flatMap((sample) => sample.dots))
  const max = {
    opacity: Math.max(...dots.map((dot) => dot.opacity)),
    scale: Math.max(...dots.map((dot) => dot.scale)),
    translatePx: Math.max(...dots.map((dot) => dot.translate)),
  }
  const perDot = ["light", "dark"].map((scheme, index) => ({
    scheme,
    dots: Array.from({ length: 37 }, (_, dot) => ({
      dot,
      opacity: Math.max(...frames.map((frame) => frame.samples[index].dots[dot].opacity)),
      scale: Math.max(...frames.map((frame) => frame.samples[index].dots[dot].scale)),
    })),
  }))
  await Bun.write(path.join(out, "error.json"), JSON.stringify({ max, perDot, frames }, null, 2))
  console.log(JSON.stringify({ max, frames: frames.length, dots: 37, schemes: 2 }))
  await Bun.write(
    path.join(out, "error.svg"),
    plot(
      frames.map((frame) => ({
        time: frame.time,
        opacity: Math.max(...frame.samples.flatMap((sample) => sample.dots.map((dot) => dot.opacity))),
        scale: Math.max(...frame.samples.flatMap((sample) => sample.dots.map((dot) => dot.scale))),
      })),
      max,
    ),
  )
  if (max.opacity > 0.0201 || max.scale > 0.0201 || max.translatePx > 0.001)
    throw new Error("CSS does not match the JS orb")
  await page.reload()
  await page.locator('[data-component="css-agent-orb"]').nth(9).waitFor()
  await page.evaluate(() => window.orbMatch.warm())
  for (let i = 0; i < 108; i++) {
    await page.evaluate((time) => window.orbMatch.step(time), (i * 1000) / 60)
    await page.screenshot({ path: path.join(out, "frames", `${String(i).padStart(3, "0")}.png`) })
  }
  await page.screenshot({ path: path.join(out, "still.png") })
  await page.emulateMedia({ reducedMotion: "reduce" })
  const animations = await page
    .locator('[data-component="css-agent-orb"]')
    .evaluateAll((orbs) => orbs.flatMap((orb) => orb.getAnimations({ subtree: true })).length)
  if (animations !== 0) throw new Error("Reduced motion still animates")
  await page.screenshot({ path: path.join(out, "reduced.png") })
  // Rasterize the error plot for the board; its source and every per-dot measurement remain in the artifacts.
  await page.setContent(await Bun.file(path.join(out, "error.svg")).text())
  await page.locator("svg").screenshot({ path: path.join(out, "error.png") })
  await page.close()
} finally {
  await browser.close()
  server.stop()
  await rm(root, { recursive: true, force: true })
}
for (const [name, filter] of [
  ["matched.mp4", "loop=loop=1:size=108:start=0,setpts=N/(60*TB)"],
  ["slow.mp4", "setpts=4*PTS"],
]) {
  const command = Bun.spawn(
    [
      "ffmpeg",
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-framerate",
      "60",
      "-i",
      path.join(out, "frames", "%03d.png"),
      "-vf",
      filter,
      "-an",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      path.join(out, name),
    ],
    { stdout: "ignore", stderr: "inherit" },
  )
  if (await command.exited) throw new Error("Video conversion failed")
}
await rm(path.join(out, "frames"), { recursive: true, force: true })

function plot(frames: { time: number; opacity: number; scale: number }[], max: { opacity: number; scale: number }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="600" viewBox="0 0 1080 600">
  <rect width="1080" height="600" fill="#151515"/><g font-family="sans-serif" fill="#eee">
  <text x="40" y="42" font-size="23">CSS vs JS · every dot, light + dark</text>
  <text x="40" y="73" font-size="15">480Hz validation · 37 dots × 2 themes × 865 timestamps · 900ms seamless loop</text>
  ${(["opacity", "scale"] as const)
    .map((key, i) => {
      const top = 120 + i * 220
      const points = frames
        .map((frame) => `${60 + (frame.time / 1800) * 960},${top + 140 - (frame[key] / 0.025) * 140}`)
        .join(" ")
      return `<text x="40" y="${top - 12}" font-size="17">${key} · maximum ${max[key].toFixed(5)}</text>
      <path d="M60 ${top + 28}H1020" stroke="#999" stroke-dasharray="5 5"/><text x="60" y="${top + 20}" font-size="12">0.02 limit</text>
      <path d="M60 ${top + 140}H1020" stroke="#555"/><polyline points="${points}" fill="none" stroke="#8de1c0" stroke-width="2"/>
      <text x="60" y="${top + 162}" font-size="13">0 ms</text><text x="515" y="${top + 162}" font-size="13">900 ms</text><text x="960" y="${top + 162}" font-size="13">1800 ms</text>`
    })
    .join("")}
  <text x="40" y="565" font-size="14">Each point is the worst error across all 74 dots. Ink and +9.5% dot diameter are separate legibility changes.</text>
  </g></svg>`
}
