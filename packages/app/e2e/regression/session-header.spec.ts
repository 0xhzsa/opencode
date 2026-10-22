import type { SessionMessageInfo } from "@opencode/client/promise"
import { expect, test, type Page } from "@playwright/test"
import { REMOTE_SERVER, seed, sessionHref } from "../utils/app"
import { fixture, mockStressTimeline } from "../utils/session-fixture"
import { expectSessionTitle } from "../utils/waits"
import { mockRemoteServer, mockWorkspace, openSession } from "../utils/workspace"

const tabs = (page: Page) => page.locator('[data-slot="titlebar-tabs"] a')

for (const direction of ["ltr", "rtl"] as const) {
  test(`session header groups controls and opens extensions in ${direction}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await mockStressTimeline(page)
    await seed(page, {
      tabs: [fixture.sourceID, fixture.targetID],
      settings: { general: { showStatus: true } },
    })
    await page.goto(sessionHref(fixture.targetID))
    const header = page.locator("[data-session-title]")
    const project = header.locator('[data-slot="session-location-trigger"]')
    const review = page.getByRole("button", { name: "Toggle review", exact: true })
    const details = header.getByRole("button", { name: "Extensions", exact: true })
    await expect(header.getByRole("heading")).toHaveText(fixture.expected.targetTitle)
    await page.evaluate((direction) => document.documentElement.setAttribute("dir", direction), direction)
    await expect(review).toBeVisible()
    await expect(details).toBeVisible()
    const options = header.getByRole("button", { name: "More options", exact: true })
    await expect(options).toBeVisible()
    await expect(page.locator('[data-slot="titlebar-v2"]').getByRole("button", { name: "Status" })).toHaveCount(0)
    const titleBounds = await header.getByRole("heading").boundingBox()
    expect(titleBounds).not.toBeNull()

    for (const editing of [false, true]) {
      if (editing) {
        await header.getByRole("heading").click()
        await expect(header.getByRole("textbox")).toHaveValue(fixture.expected.targetTitle)
        await expect(header.getByRole("textbox")).toBeFocused()
      }

      await expect(header.locator('[data-slot="session-title-child"]')).toHaveCSS("padding-left", "4px")
      await expect(header.locator('[data-slot="session-title-child"]')).toHaveCSS("padding-right", "4px")
      await expect
        .poll(async () => {
          const [icon, title, sidebar, summary] = await Promise.all(
            [project, header.locator('[data-slot="session-title-child"]'), review, details].map((control) =>
              control.boundingBox(),
            ),
          )

          if (!icon || !title || !sidebar || !summary || !titleBounds) return false

          if (Math.abs(title.y - titleBounds.y) > 0.5 || Math.abs(title.height - titleBounds.height) > 0.5) return false

          return direction === "ltr"
            ? title.x > icon.x + icon.width &&
                title.x + title.width <= summary.x &&
                summary.x + summary.width <= sidebar.x
            : icon.x > title.x + title.width &&
                summary.x + summary.width <= title.x &&
                sidebar.x + sidebar.width <= summary.x
        })
        .toBe(true)
    }

    await header.getByRole("textbox").press("Escape")
    await expect(header.getByRole("heading")).toHaveText(fixture.expected.targetTitle)

    // The header stays one row at every width.
    for (const width of [900, 1440]) {
      await page.setViewportSize({ width, height: 900 })
      await expect
        .poll(async () => {
          const [location, title, summary, sidebar] = await Promise.all(
            [project, header.getByRole("heading"), details, review].map((control) => control.boundingBox()),
          )

          if (!location || !title || !summary || !sidebar) return false
          const middle = (box: { y: number; height: number }) => box.y + box.height / 2

          return (
            Math.abs(middle(location) - middle(title)) <= 0.5 &&
            Math.abs(middle(summary) - middle(sidebar)) <= 0.5 &&
            Math.abs(summary.height - sidebar.height) <= 0.5
          )
        })
        .toBe(true)

      const screenshot = test.info().outputPath(`header-${width}.png`)
      await page.screenshot({ path: screenshot })
      await test.info().attach(`header-${width}`, { path: screenshot, contentType: "image/png" })
    }

    await review.click()
    await expect(review).toHaveAttribute("aria-expanded", "true")
    await expect(page.locator("#review-panel")).toBeVisible()
    await review.click()
    await expect(review).toHaveAttribute("aria-expanded", "false")

    await options.click()
    const actions = page.getByRole("menu").filter({ has: page.getByRole("menuitem", { name: "Rename", exact: true }) })
    await expect(actions.getByRole("menuitem")).toHaveText(["Rename", "Export…", "Delete…"])
    await expect(actions.locator("svg")).toHaveCount(0)
    await actions.getByRole("menuitem", { name: "Rename", exact: true }).click()
    await expect(header.getByRole("textbox")).toBeFocused()
    await header.getByRole("textbox").press("Escape")

    await details.click()
    const extensions = page.locator('[data-slot="session-extensions-content"]')
    await expect(page.getByRole("tab", { name: "Extensions", exact: true })).toHaveAttribute("aria-selected", "true")
    await expect(extensions.getByRole("button", { name: /^MCP servers/ })).toHaveAttribute("aria-expanded", "true")
    await expect(extensions.getByRole("button", { name: /^Plugins/ })).toHaveAttribute("aria-expanded", "true")
    await expect(extensions.getByRole("button", { name: /^Skills/ })).toHaveAttribute("aria-expanded", "true")
    await expect(extensions.getByRole("button", { name: /^LSP/ })).toHaveAttribute("aria-expanded", "true")
    await expect(details.locator('use[href="#opencode-v2-icon-window-analytics"]')).toHaveCount(1)
    await expect(details).toHaveAttribute("data-state", "pressed")

    // Clicking again keeps the tab selected rather than closing it.
    await details.click()
    await expect(extensions).toBeVisible()
  })
}

// A frameless desktop window moves when its titlebar row is dragged. The session header continues that row through one
// area over the empty gap between the title and the actions, so no control sits under it.
for (const direction of ["ltr", "rtl"] as const) {
  test(`the desktop session header drags the window from the gap after the title in ${direction}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await mockStressTimeline(page)
    await page.goto(
      `/e2e/utils/windows-menu.html?${new URLSearchParams({ server: fixture.serverKey, path: sessionHref(fixture.targetID, "sidecar") })}`,
    )
    const header = page.locator("[data-session-title]")
    const area = page.locator('[data-slot="session-header-drag"]')
    const options = header.getByRole("button", { name: "More options", exact: true })
    const actions = header.locator(".session-header-actions")
    await expect(header.getByRole("heading")).toHaveText(fixture.expected.targetTitle)
    await page.evaluate((direction) => document.documentElement.setAttribute("dir", direction), direction)
    await expect(area).toHaveCSS("app-region", "drag")
    await expect(page.locator('[data-slot="shell-drag-inset"]')).toHaveCSS("app-region", "drag")

    const gap = header.locator('[data-slot="session-header-gap"]')
    const aligned = async () => {
      const [box, space, end, start, row] = await Promise.all([
        area.boundingBox(),
        gap.boundingBox(),
        options.boundingBox(),
        actions.boundingBox(),
        header.locator(".session-header-layout").boundingBox(),
      ])

      if (!box || !space || !end || !start || !row) return false
      const between =
        direction === "ltr"
          ? space.x >= end.x + end.width && space.x + space.width <= start.x
          : space.x + space.width <= end.x && space.x >= start.x + start.width

      return (
        between &&
        Math.abs(box.x - space.x) <= 0.5 &&
        Math.abs(box.width - space.width) <= 0.5 &&
        Math.abs(box.y - row.y) <= 0.5 &&
        Math.abs(box.height - row.height) <= 0.5
      )
    }

    await expect.poll(aligned).toBe(true)

    // The area lives outside the timeline's scroller, so scrolling leaves it over the header.
    const timeline = page.locator('[data-slot="session-timeline-scroll"]')
    await timeline.hover()
    await page.mouse.wheel(0, -2000)
    await expect.poll(aligned).toBe(true)

    // The rename field takes the gap's place, so the area steps aside until the title is back.
    await header.getByRole("heading").click()
    await expect(header.getByRole("textbox")).toBeFocused()
    await expect(area).toBeHidden()
    await header.getByRole("textbox").press("Escape")
    await expect(area).toBeVisible()
  })
}

test("the web session header leaves window dragging to the browser", async ({ page }) => {
  await mockStressTimeline(page)
  await seed(page, { tabs: [fixture.targetID] })
  await page.goto(sessionHref(fixture.targetID))
  const header = page.locator("[data-session-title]")
  await expect(header.getByRole("heading")).toHaveText(fixture.expected.targetTitle)
  await expect(page.locator('[data-slot="session-header-drag"]')).toHaveCount(0)
  await expect(page.locator('[data-slot="shell-drag-inset"]')).toHaveCount(0)
})

test.describe("location", () => {
  const root = "C:/OpenCode/Location"
  const worktree = "C:/OpenCode/Worktrees/location/quiet-falcon"
  const trigger = (page: Page) => page.locator('[data-slot="session-location-trigger"]')

  const workspace = {
    name: "Location",
    directory: root,
    project: { sandboxes: [worktree] },
    sessions: [{ id: "ses_location", title: "Location session", directory: worktree }],
  }

  test("only collapses location names when the timeline header is narrow", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await openSession(page, {
      ...workspace,
      sessions: [{ id: "ses_location", title: "Investigate session header layout regression", directory: worktree }],
    })
    const header = page.locator("[data-session-title]")
    const names = header.locator('[data-slot="session-location-project"], [data-slot="session-location-worktree"]')
    const review = page.getByRole("button", { name: "Toggle review", exact: true })
    await expect(names).toHaveText(["Location", "quiet-falcon"])

    for (const panel of [false, true, false]) {
      if (panel || (await review.getAttribute("aria-expanded")) === "true") await review.click()
      await expect(review).toHaveAttribute("aria-expanded", String(panel))
      await expect
        .poll(() =>
          names.evaluateAll((elements) => elements.every((element) => getComputedStyle(element).clipPath === "none")),
        )
        .toBe(!panel)
      await expect(header.getByRole("button", { name: "More options", exact: true })).toBeInViewport()
      await expect
        .poll(() => header.getByRole("heading").evaluate((element) => element.scrollWidth <= element.clientWidth))
        .toBe(true)
      if (panel) {
        const separator = header.locator('[data-slot="session-title-separator"]')
        await expect(separator).toBeVisible()
        await expect(separator).toHaveText("")
        await expect(separator).toHaveAttribute("aria-hidden", "true")
        await expect(header.locator(".session-location-worktree-icon")).toBeHidden()
        const location = header.locator('[data-slot="session-location-trigger"]')
        await location.hover()
        await expect(location).toHaveCSS("padding-inline-start", "4px")
        await expect(location).toHaveCSS("padding-inline-end", "4px")
      }
      await header.screenshot({ path: test.info().outputPath(`location-${panel ? "compact" : "expanded"}.png`) })
    }
  })

  test("names the project and worktree, and the card copies the full path", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"])
    await openSession(page, workspace)
    await expect(trigger(page).locator('[data-slot="session-location-project"]')).toHaveText("Location")
    await expect(trigger(page).locator('[data-slot="session-location-worktree"]')).toHaveText("quiet-falcon")
    await expect(trigger(page)).not.toContainText("/")
    await expect(trigger(page).locator('svg:has(use[href="#opencode-v2-icon-outline-worktree"])')).toBeVisible()
    await trigger(page).click()
    const card = page.locator('[data-slot="session-location-card"]')
    const path = card.getByRole("menuitem", { name: worktree, exact: true })
    await expect(path).toHaveText(worktree)
    await expect(card.getByRole("menuitem", { name: "Copy path", exact: true })).toHaveCount(0)
    // Select actual text on the first line, not the empty half of a wrapped path's bounding box.
    await path.locator("bdi").dblclick({ position: { x: 32, y: 8 } })
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? "")).not.toBe("")
    await path.press("Enter")
    const actions = page.getByRole("menu", { name: worktree, exact: true })
    await expect(actions.getByRole("menuitem", { name: "Copy path", exact: true })).toBeFocused()
    await page.screenshot({ path: test.info().outputPath("path-flyout.png"), animations: "disabled" })
    await actions.getByRole("menuitem", { name: "Copy path", exact: true }).click()
    await expect(card).toBeHidden()
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(worktree)
  })

  test("names another server only in the card, not the breadcrumb", async ({ page }) => {
    await mockWorkspace(page, { name: "Location", sessions: [] })
    await mockRemoteServer(page, {
      name: "apollo",
      directory: "/srv/remote/project",
      sessions: [
        {
          id: "ses_remote",
          title: "Remote session",
          directory: "/srv/remote/project",
          slug: "ses_remote",
          version: "dev",
          time: { created: 1, updated: 1 },
        },
      ],
    })
    await seed(page, { tabs: [{ session: "ses_remote", server: REMOTE_SERVER }] })
    await page.goto(sessionHref("ses_remote", REMOTE_SERVER))
    await expect(trigger(page).locator('[data-slot="session-location-project"]')).toHaveText("project")
    await expect(trigger(page)).not.toContainText("apollo")
    await trigger(page).click()
    await expect(page.locator('[data-slot="session-location-card"]').getByText("apollo", { exact: true })).toBeVisible()
  })

  test.describe("touch", () => {
    test.use({ hasTouch: true })

    test("shows the location bar under the mobile view tabs and opens path actions on tap", async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 })
      await openSession(page, workspace)
      const bar = page.locator('[data-slot="session-location-bar"]')
      await expect(bar.locator('[data-slot="session-location-worktree"]')).toHaveText("quiet-falcon")
      await bar.locator('[data-slot="session-location-trigger"]').click()
      await expect(page.locator('[data-slot="session-location-card"] [data-slot="session-location-path"]')).toHaveText(
        worktree,
      )
      await page.getByRole("menuitem", { name: worktree, exact: true }).tap()
      const actions = page.getByRole("menu", { name: worktree, exact: true })
      await expect(actions.getByRole("menuitem", { name: "Copy path", exact: true })).toBeVisible()
      await expect
        .poll(() =>
          actions.evaluate((element) => {
            const bounds = element.getBoundingClientRect()

            return (
              bounds.left >= 16 &&
              bounds.right <= innerWidth - 16 &&
              bounds.top >= 16 &&
              bounds.bottom <= innerHeight - 16
            )
          }),
        )
        .toBe(true)
      await page.screenshot({ path: test.info().outputPath("path-flyout-mobile.png"), animations: "disabled" })
    })
  })
})

test.describe("rename", () => {
  const heading = (page: Page, name: string) => page.getByRole("heading", { name, exact: true })
  // Rename requests (`PATCH /api/session/:id`); the mock stores the new title for later reads.
  const renames: { sessionID: string; body: unknown }[] = []

  test.beforeEach(async ({ page }) => {
    renames.length = 0
    page.on("request", (request) => {
      const match = new URL(request.url()).pathname.match(/^\/api\/session\/([^/]+)$/)

      if (request.method() === "PATCH" && match) renames.push({ sessionID: match[1]!, body: request.postDataJSON() })
    })
    await mockStressTimeline(page)
    await page.goto("/")
    await page.locator('[data-component="home-session-row"]').filter({ hasText: fixture.expected.targetTitle }).click()
    await expect(heading(page, fixture.expected.targetTitle)).toBeVisible()
  })

  for (const commit of ["Enter", "blur", "click outside"]) {
    test(`saves the session heading on ${commit}`, async ({ page }) => {
      await heading(page, fixture.expected.targetTitle).click()
      const input = page.locator('input[data-slot="session-title-child"]')
      await expect(input).toBeFocused()
      await input.fill("Renamed session")

      if (commit === "Enter") await input.press("Enter")

      if (commit === "blur") await input.press("Tab")

      if (commit === "click outside") await page.locator('[data-component="composer-editor"]').click()
      await expect(heading(page, "Renamed session")).toBeVisible()
      await expect(tabs(page).filter({ hasText: "Renamed session" })).toBeVisible()
      await expect.poll(() => renames).toEqual([{ sessionID: fixture.targetID, body: { title: "Renamed session" } }])
      await page.reload()
      await expect(heading(page, "Renamed session")).toBeVisible()
    })
  }

  for (const edit of [
    { name: "cancelled with Escape", value: "Discard this title", key: "Escape" },
    { name: "left empty", value: "   ", key: "Tab" },
  ]) {
    test(`keeps the session heading when the edit is ${edit.name}`, async ({ page }) => {
      await heading(page, fixture.expected.targetTitle).click()
      const input = page.locator('input[data-slot="session-title-child"]')
      await input.fill(edit.value)
      await input.press(edit.key)
      await expect(heading(page, fixture.expected.targetTitle)).toBeVisible()
      await page.reload()
      await expect(heading(page, fixture.expected.targetTitle)).toBeVisible()
      expect(renames).toEqual([])
    })
  }

  test("keeps the draft when saving the session heading fails", async ({ page }) => {
    await page.route("**/api/session/*", (route) =>
      route.request().method() === "PATCH"
        ? route.fulfill({ status: 500, headers: { "access-control-allow-origin": "*" } })
        : route.fallback(),
    )
    await heading(page, fixture.expected.targetTitle).click()
    const input = page.locator('input[data-slot="session-title-child"]')
    await input.fill("Retry this title")
    await input.press("Tab")
    await expect(page.getByText("Request failed", { exact: true })).toBeVisible()
    await expect(input).toBeEnabled()
    await expect(input).toHaveValue("Retry this title")
    await expect(tabs(page).filter({ hasText: fixture.expected.targetTitle })).toBeVisible()
  })

  test("renames and closes the session tab from its context menu", async ({ page }) => {
    const tab = tabs(page).filter({ hasText: fixture.expected.targetTitle })
    await tab.click({ button: "right" })
    await expect(page.getByRole("menuitem", { name: "Rename", exact: true })).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(page.getByRole("menuitem", { name: "Rename", exact: true })).toBeHidden()
    await expect(tab).toBeFocused()
    await tab.press("Shift+F10")
    await page.getByRole("menuitem", { name: "Rename", exact: true }).click()
    const input = page.locator('[data-slot="tab-title"][contenteditable="true"]')
    await expect(input).toBeFocused()
    await input.fill("Renamed from tab")
    await input.press("Enter")
    await expect(heading(page, "Renamed from tab")).toBeVisible()
    await expect.poll(() => renames).toEqual([{ sessionID: fixture.targetID, body: { title: "Renamed from tab" } }])
    await page.reload()
    await expect(heading(page, "Renamed from tab")).toBeVisible()
    const renamed = tabs(page).filter({ hasText: "Renamed from tab" })
    await renamed.click({ button: "right" })
    await page.getByRole("menuitem", { name: "Close tab", exact: true }).click()
    await expect(renamed).toBeHidden()
    await page.getByRole("button", { name: "Home", exact: true }).click()
    await expect(
      page.locator('[data-component="home-session-row"]').filter({ hasText: "Renamed from tab" }),
    ).toBeVisible()
  })

  test("renames an inactive tab without switching sessions", async ({ page }) => {
    await page.getByRole("button", { name: "Home", exact: true }).click()
    await page.locator('[data-component="home-session-row"]').filter({ hasText: fixture.expected.sourceTitle }).click()
    await expect(heading(page, fixture.expected.sourceTitle)).toBeVisible()
    await tabs(page).filter({ hasText: fixture.expected.targetTitle }).click({ button: "right" })
    await page.getByRole("menuitem", { name: "Rename", exact: true }).click()
    const input = page.locator('[data-slot="tab-title"][contenteditable="true"]')
    await expect(input).toBeFocused()
    await input.fill("Inactive tab renamed")
    await input.press("Tab")
    await expect(heading(page, fixture.expected.sourceTitle)).toBeVisible()
    await expect(page).toHaveURL(new RegExp(`/session/${fixture.sourceID}$`))
    await tabs(page).filter({ hasText: "Inactive tab renamed" }).click()
    await expect(heading(page, "Inactive tab renamed")).toBeVisible()
    expect(renames).toEqual([{ sessionID: fixture.targetID, body: { title: "Inactive tab renamed" } }])
    await page.reload()
    await expect(heading(page, "Inactive tab renamed")).toBeVisible()
  })
})

test.describe("revert", () => {
  const messages = [
    { id: "msg_first", type: "user", text: "First prompt", time: { created: 1 } },
    {
      id: "msg_first_reply",
      type: "assistant",
      agent: "build",
      model: { id: "test", providerID: "opencode" },
      content: [{ type: "text", text: "First reply" }],
      time: { created: 2, completed: 3 },
    },
    { id: "msg_second", type: "user", text: "Second prompt", time: { created: 4 } },
  ] satisfies SessionMessageInfo[]

  const workspace = {
    name: "SessionMessageRevert",
    pageMessages: () => ({ items: messages }),
  }

  test("reverts directly to the selected user message", async ({ page }) => {
    const staged: { sessionID: string; messageID: string }[] = []
    const { session } = await openSession(page, { ...workspace, onRevertStage: (input) => staged.push(input) })
    const settles: string[] = []
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname
      const step = ["/interrupt", "/wait", "/revert/stage"].find((suffix) => path.endsWith(`/${session.id}${suffix}`))

      if (step) settles.push(step)
    })
    const message = page.locator('[data-message-id="msg_second"]')
    await message.hover()

    const response = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === `/api/session/${session.id}/revert/stage`,
    )

    await message.getByRole("button", { name: "Revert message" }).click()
    expect((await response).ok()).toBe(true)

    await expect(page.getByRole("textbox", { name: "Prompt" })).toHaveText("Second prompt")
    expect(staged).toEqual([{ sessionID: session.id, messageID: "msg_second" }])
    // Interrupt acknowledges before the run settles, and the server refuses to stage while it is active.
    expect(settles).toEqual(["/interrupt", "/wait", "/revert/stage"])
  })

  test("redo restores every reverted message at once, as in the TUI", async ({ page }) => {
    const staged: { sessionID: string; messageID: string }[] = []

    const { editor } = await openSession(page, {
      ...workspace,
      sessions: [{ id: "ses_revert_redo", title: "Session message revert", revert: { messageID: "msg_first" } }],
      onRevertStage: (input) => staged.push(input),
    })

    const cleared = page.waitForResponse(
      (response) =>
        response.request().method() === "DELETE" &&
        new URL(response.url()).pathname === "/api/session/ses_revert_redo/revert",
    )

    await editor.pressSequentially("/redo")
    await expect(
      page.locator('[data-component="composer-suggestions"] [data-suggestion-id][data-active]'),
    ).toContainText("/redo")
    await editor.press("Enter")

    expect((await cleared).ok()).toBe(true)
    expect(staged).toEqual([])
  })

  test("hides revert actions in a child session", async ({ page }) => {
    await mockWorkspace(page, {
      ...workspace,
      sessions: [
        { id: "ses_parent", title: "Parent session" },
        { id: "ses_child", title: "Session message revert", parentID: "ses_parent" },
      ],
    })
    await page.goto(sessionHref("ses_child"))
    await expectSessionTitle(page, "Session message revert")
    const message = page.locator('[data-message-id="msg_second"]')
    await message.hover()
    await expect(message.getByRole("button", { name: "Revert message" })).toHaveCount(0)
  })
})
