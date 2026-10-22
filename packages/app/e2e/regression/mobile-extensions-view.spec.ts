import { expect, test } from "@playwright/test"
import { fixture, mockStressTimeline } from "../utils/session-fixture"
import { sessionHref } from "../utils/app"
import { openWithDirection } from "../utils/direction"

for (const scheme of ["light", "dark"] as const) {
  for (const direction of ["ltr", "rtl"] as const) {
    test(`mobile extensions open as a session view in ${scheme} ${direction}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width: 390, height: 844 })
      await mockStressTimeline(page)
      await page.addInitScript((scheme) => {
        localStorage.setItem("opencode-color-scheme", scheme)
        localStorage.setItem("settings.v3", JSON.stringify({ general: { mobileTitlebarPosition: "bottom" } }))
      }, scheme)
      const warnings: string[] = []
      page.on("console", (event) => {
        if (event.text().includes("computations created outside")) warnings.push(event.text())
      })
      await openWithDirection(page, sessionHref(fixture.targetID), direction)
      const tabs = page.getByRole("tablist", { name: "Session view", exact: true })
      const more = tabs.getByRole("tab", { name: "More...", exact: true })
      await expect(tabs.getByRole("tab", { selected: true })).toHaveText("Session")
      await more.click()
      await page
        .getByRole("dialog", { name: "More options", exact: true })
        .getByRole("button", { name: "Extensions", exact: true })
        .click()
      const extensions = page.locator('[data-slot="session-extensions-content"]')

      for (const [id, empty] of [
        ["mcp", "No MCP servers configured"],
        ["plugins", "No plugins configured"],
        ["skills", "No skills configured"],
        ["lsp", "No LSP servers configured"],
      ]) {
        await expect(extensions.locator(`[data-section="${id}"]`).getByText(empty, { exact: true })).toBeVisible()
      }

      await expect(page.getByRole("dialog")).toHaveCount(0)
      await page.screenshot({ path: testInfo.outputPath("extensions.png") })
      await testInfo.attach("extensions", { path: testInfo.outputPath("extensions.png"), contentType: "image/png" })
      expect(warnings).toEqual([])
    })
  }
}

test("the mobile extensions view keeps configured lists, retry, and MCP status working", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await mockStressTimeline(page)
  const state = { fail: true, enabled: true }
  await page.route(
    (url) => url.pathname === "/api/plugin",
    (route) => {
      if (route.request().method() === "OPTIONS") return route.fallback()

      if (state.fail) return route.fulfill({ status: 500, json: { message: "Unavailable" } })

      return route.fulfill({
        json: {
          location: { directory: fixture.directory },
          data: [
            {
              id: "drawer-plugin",
              source: { type: "package", target: "drawer-plugin" },
              features: {},
              state: { status: "active" },
            },
          ],
        },
      })
    },
  )
  await page.route(
    (url) => url.pathname === "/api/skill",
    (route) =>
      route.fulfill({
        json: {
          location: { directory: fixture.directory },
          data: [
            { id: "drawer-skill", name: "drawer-skill", path: "/skills/drawer/SKILL.md", content: "Drawer skill" },
          ],
        },
      }),
  )
  await page.route(
    (url) => url.pathname === "/api/config",
    (route) =>
      route.fulfill({ json: [{ type: "document", info: { lsp: { "drawer-lsp": { command: ["drawer-lsp"] } } } }] }),
  )
  await page.route(
    (url) => url.pathname.startsWith("/api/mcp") || url.pathname.startsWith("/api/experimental/mcp"),
    (route) => {
      if (route.request().method() === "OPTIONS") return route.fallback()
      const path = new URL(route.request().url()).pathname

      if (path.endsWith("/disconnect")) {
        state.enabled = false

        return route.fulfill({ status: 204 })
      }

      return route.fulfill({
        json: {
          location: { directory: fixture.directory },
          data:
            path === "/api/mcp/resource"
              ? { resources: [], templates: [] }
              : Array.from({ length: 30 }, (_, index) => ({
                  name: `mcp-${String(index).padStart(2, "0")}`,
                  status: { status: index === 0 && !state.enabled ? "disabled" : "connected" },
                })),
        },
      })
    },
  )
  await openWithDirection(page, sessionHref(fixture.targetID), "ltr")
  const tabs = page.getByRole("tablist", { name: "Session view", exact: true })
  await expect(tabs.getByRole("tab", { selected: true })).toHaveText("Session")
  await tabs.getByRole("tab", { name: "More...", exact: true }).click()
  await page
    .getByRole("dialog", { name: "More options", exact: true })
    .getByRole("button", { name: "Extensions", exact: true })
    .click()
  const extensions = page.locator('[data-slot="session-extensions-content"]')
  const plugins = extensions.locator('[data-section="plugins"]')
  await expect(plugins.getByText("Request failed")).toBeVisible()
  state.fail = false
  await plugins.getByRole("button", { name: "Retry", exact: true }).click()
  await expect(plugins.getByText("drawer-plugin", { exact: true })).toBeVisible()
  await expect(extensions.locator('[data-section="skills"]').getByText("drawer-skill", { exact: true })).toBeVisible()
  await expect(extensions.locator('[data-section="lsp"]').getByText("drawer-lsp", { exact: true })).toBeVisible()

  const mcp = extensions.locator('[data-section="mcp"]')
  await expect(mcp.locator('[data-slot="extensions-mcp-row"]')).toHaveCount(30)
  await expect(mcp.getByRole("switch")).toHaveCount(30)
  const toggle = mcp.getByRole("switch", { name: "mcp-00", exact: true })
  await expect(toggle).toBeChecked()
  await toggle.press("Space")
  await expect(toggle).not.toBeChecked()
  await expect(toggle).toBeEnabled()

  const last = mcp.locator('[data-slot="extensions-mcp-row"]').filter({ hasText: "mcp-29" })
  await last.scrollIntoViewIfNeeded()
  await expect(last).toBeInViewport()
  await expect(mcp.getByRole("button", { name: "Manage MCP servers", exact: true })).toBeVisible()
})
