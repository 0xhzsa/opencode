import { expect, test, type Page } from "@playwright/test"
import { seed, sessionHref } from "../utils/app"
import { fixture, installStressSessionTabs, mockStressTimeline } from "../utils/session-fixture"

test.use({ viewport: { width: 1440, height: 900 } })

const sidebar = '[data-slot="vertical-tabs-sidebar"]'

const sidebarPanel = `${sidebar} > div`

const sidePanel = '[data-slot="session-side-panel-presence"]'

// Samples every frame for 1.5 s after `toggle`: the content's edge beside the panel, and the panel's opacity and shift.
async function trace(page: Page, toggle: () => Promise<void>, edge: string, panel: string) {
  const frames = page.evaluate(
    ([edge, panel]) =>
      new Promise<{ edge: number; opacity: number; shift: number }[]>((resolve) => {
        const start = performance.now()
        const out: { edge: number; opacity: number; shift: number }[] = []

        // The rAF timestamp follows the slowed animation timeline, so time the window with performance.now().
        const tick = () => {
          const style = getComputedStyle(document.querySelector(panel)!)
          out.push({
            edge: document.querySelector(edge)!.getBoundingClientRect().right,
            opacity: Number(style.opacity),
            shift: style.transform === "none" ? 0 : new DOMMatrix(style.transform).m41,
          })

          if (performance.now() - start < 1500) return requestAnimationFrame(tick)
          resolve(out)
        }

        requestAnimationFrame(tick)
      }),
    [edge, panel] as const,
  )

  await toggle()

  return frames
}

for (const direction of ["ltr", "rtl"] as const) {
  test(`a click opens a panel with a fade and closes it at once, the content moving in one frame (${direction})`, async ({
    page,
  }) => {
    await mockStressTimeline(page)
    await installStressSessionTabs(page)
    await seed(page, { settings: { appearance: { tabLayout: "vertical", sidebarOpen: true } } })
    await page.goto(sessionHref(fixture.targetID))
    await page.evaluate((direction) => (document.documentElement.dir = direction), direction)
    await expect(page.getByRole("heading", { name: fixture.expected.targetTitle })).toBeVisible()
    // A fifth of the speed, so even a slow runner samples several frames of each fade.
    const devtools = await page.context().newCDPSession(page)
    await devtools.send("Animation.enable")
    await devtools.send("Animation.setPlaybackRate", { playbackRate: 0.2 })

    const sidebarToggle = page
      .locator(
        `${sidebar} button[aria-controls="vertical-tabs-sidebar"], main button[aria-controls="vertical-tabs-sidebar"]`,
      )
      .locator("visible=true")
      .first()

    const reviewToggle = page.locator('[data-slot="session-review-toggle"] button')

    // Each panel shifts toward its own edge: the sidebar toward the start, the side panel toward the end.
    const start = direction === "ltr" ? -1 : 1

    const chat = '[data-slot="session-chat-panel"]'

    // The sidebar starts open and the side panel closed.
    const runs = [
      { toggle: sidebarToggle, edge: sidebar, panel: sidebarPanel, shift: 10 * start, opens: false },
      { toggle: sidebarToggle, edge: sidebar, panel: sidebarPanel, shift: 10 * start, opens: true },
      { toggle: reviewToggle, edge: chat, panel: sidePanel, shift: -12 * start, opens: true },
      { toggle: reviewToggle, edge: chat, panel: sidePanel, shift: -12 * start, opens: false },
    ]

    for (const run of runs) {
      const frames = await trace(page, () => run.toggle.click({ force: true }), run.edge, run.panel)
      // The layout jumps straight from where it was to where it lands.
      expect(new Set(frames.map((frame) => Math.round(frame.edge))).size).toBeLessThanOrEqual(2)

      if (!run.opens) {
        expect(frames.every((frame) => frame.opacity === 1 && frame.shift === 0)).toBe(true)
        continue
      }

      // An opening panel fades over several frames from 0.15 and shifts in from at most its offset toward its edge.
      const opacities = frames.map((frame) => frame.opacity).filter((opacity) => opacity < 1)
      expect(new Set(opacities).size).toBeGreaterThan(2)
      expect(Math.min(...opacities)).toBeGreaterThan(0.14)
      frames.forEach((frame) => {
        expect(Math.abs(frame.shift)).toBeLessThanOrEqual(Math.abs(run.shift) + 0.5)
        expect(frame.shift * run.shift).toBeGreaterThanOrEqual(0)
      })
    }
  })
}

test("keyboard toggles switch the panels without motion", async ({ page }) => {
  await mockStressTimeline(page)
  await installStressSessionTabs(page)
  await seed(page, { settings: { appearance: { tabLayout: "vertical", sidebarOpen: true } } })
  await page.goto(sessionHref(fixture.targetID))
  await expect(page.getByRole("heading", { name: fixture.expected.targetTitle })).toBeVisible()

  for (const [shortcut, panel] of [
    ["ControlOrMeta+Shift+B", sidebarPanel],
    ["ControlOrMeta+Shift+B", sidebarPanel],
    ["ControlOrMeta+Shift+R", sidePanel],
    ["ControlOrMeta+Shift+R", sidePanel],
  ] as const) {
    const frames = await trace(page, () => page.keyboard.press(shortcut), sidebar, panel)
    expect(frames.every((frame) => frame.opacity === 1 && frame.shift === 0)).toBe(true)
  }
})
