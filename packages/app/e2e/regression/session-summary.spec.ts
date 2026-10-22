import { expect, test, type Locator, type Page } from "@playwright/test"
import { holdRoute, seed, sessionHref } from "../utils/app"
import { mockOpenCodeServer } from "../utils/mock-server"
import { fixture, installStressSessionTabs, mockStressTimeline, pageMessages } from "../utils/session-fixture"
import { fileDiff, openSession } from "../utils/workspace"

const cors = { "access-control-allow-origin": "*" }

for (const custom of [false, true]) {
  test(`extensions ${custom ? "custom" : "default"} shortcut opens the tab for the active session`, async ({
    page,
  }) => {
    await mockStressTimeline(page)
    await installStressSessionTabs(page)

    // The legacy command ID; the keybind migration renames it to `details.toggle`.
    if (custom) await seed(page, { settings: { keybinds: { "session.summary.toggle": "alt+f8" } } })
    await page.goto(sessionHref(fixture.sourceID))
    const trigger = page.getByRole("button", { name: "Extensions", exact: true })
    const tab = page.getByRole("tab", { name: "Extensions", exact: true })
    await expect(page.locator('[data-component="composer-editor"]')).toBeEditable()
    await expect(trigger).toBeEnabled()
    // The trigger scrolls with the timeline under its sticky header, and Kobalte closes a tooltip whenever its
    // trigger scrolls. A cold timeline keeps scrolling to its bottom until it reveals its rows, so hover after that.
    await expect(
      page.locator(`[data-timeline-row="UserMessage"][data-message-id="${fixture.expected.sourceMessageIDs.at(-1)}"]`),
    ).toBeVisible()
    await trigger.hover()
    const tooltip = page.getByRole("tooltip")
    await expect(tooltip).toContainText("Extensions")
    const mac = await page.evaluate(() => /(Mac|iPod|iPhone|iPad)/.test(navigator.platform))
    const shortcut = custom ? "Alt+F8" : mac ? "Meta+Shift+Y" : "Control+Shift+Y"
    await expect(tooltip.locator('[data-slot="keybind-v2-label"]')).toHaveText(
      custom ? (mac ? ["⌥", "F8"] : ["Alt", "F8"]) : mac ? ["⇧", "⌘", "Y"] : ["Ctrl", "Shift", "Y"],
    )

    for (const id of [fixture.sourceID, fixture.targetID]) {
      await page.locator(`[data-titlebar-tab-link][href="${sessionHref(id)}"]`).click()
      const messages = id === fixture.sourceID ? fixture.expected.sourceMessageIDs : fixture.expected.targetMessageIDs
      await expect(
        page.locator(`[data-timeline-row="UserMessage"][data-message-id="${messages.at(-1)}"]`),
      ).toBeInViewport()
      await page.keyboard.press(shortcut)
      await expect(tab).toHaveAttribute("aria-selected", "true")
      await expect(extensions(page).locator('[data-section="mcp"]')).toBeVisible()
      await expect(trigger).toHaveAttribute("data-state", "pressed")
      // Pressing it again keeps the tab selected.
      await page.keyboard.press(shortcut)
      await expect(tab).toHaveAttribute("aria-selected", "true")
    }

    if (!custom) return

    // The override moved, so storage keeps only its new id and Shortcuts lists no row titled with the old one.
    const keybinds = () => page.evaluate(() => JSON.parse(localStorage.getItem("settings.v3") ?? "null")?.keybinds)
    await expect.poll(keybinds).toEqual({ "details.toggle": "alt+f8" })
    await page.goto("/settings")
    const settings = page.getByTestId("settings-screen")
    await settings.getByRole("tab", { name: "Shortcuts", exact: true }).click()
    await expect(settings.getByText("Show extensions", { exact: true })).toBeVisible()
    await expect(settings.getByText("session.summary.toggle", { exact: true })).toHaveCount(0)
    expect(await keybinds()).toEqual({ "details.toggle": "alt+f8" })
  })
}

test("the extensions tab expands every section and remembers collapsed ones", async ({ page }) => {
  await mockStressTimeline(page)
  await page.goto(sessionHref(fixture.targetID))
  await page.getByRole("button", { name: "Extensions", exact: true }).click()

  for (const id of ["mcp", "plugins", "skills", "lsp"])
    await expect(trigger(page, id)).toHaveAttribute("aria-expanded", "true")
  await expect(section(page, "mcp").getByText("No MCP servers configured", { exact: true })).toBeVisible()
  await expect(section(page, "plugins").getByText("No plugins configured", { exact: true })).toBeVisible()
  await expect(section(page, "skills").getByText("No skills configured", { exact: true })).toBeVisible()
  await expect(section(page, "lsp").getByText("No LSP servers configured", { exact: true })).toBeVisible()

  await trigger(page, "plugins").click()
  await expect(trigger(page, "plugins")).toHaveAttribute("aria-expanded", "false")
  await page.reload()
  await expect(trigger(page, "plugins")).toHaveAttribute("aria-expanded", "false")
  await expect(trigger(page, "mcp")).toHaveAttribute("aria-expanded", "true")
})

test("extension lists load, tell errors from empty, and retry", async ({ page }) => {
  const state = { fail: true }

  await mockStressTimeline(page, {
    mcp: [{ name: "summary-mcp", status: { status: "connected" } }],
    plugins: [
      { id: "builtin", source: { type: "builtin" }, features: {}, state: { status: "active" } },
      {
        id: "supermemory",
        source: { type: "package", target: "opencode-supermemory" },
        features: { server: true },
        state: { status: "active" },
      },
      {
        id: "broken-plugin",
        source: { type: "local", path: "/broken.ts" },
        features: { server: true },
        state: { status: "failed", error: "Plugin failed to activate" },
      },
    ],
    skills: [
      { id: "find-skills", name: "find-skills", path: "/skills/find/SKILL.md", content: "Find skills" },
      { id: "review-animations", name: "review-animations", path: "/skills/review/SKILL.md", content: "Review" },
    ],
    configEntries: [
      {
        type: "document",
        info: {
          lsp: {
            typescript: { command: ["typescript-language-server", "--stdio"] },
            rust: { command: ["rust-analyzer"] },
          },
        },
      },
      { type: "document", info: { lsp: { rust: { disabled: true } } } },
    ],
  })
  await page.route(
    (url) => url.pathname === "/api/plugin",
    (route) => {
      if (route.request().method() === "OPTIONS" || !state.fail) return route.fallback()

      return route.fulfill({ status: 500, headers: cors, json: { message: "Unavailable" } })
    },
  )
  const warnings = ownerWarnings(page)
  await page.goto(sessionHref(fixture.targetID))
  await page.getByRole("button", { name: "Extensions", exact: true }).click()

  const plugins = section(page, "plugins")
  await expect(plugins.getByText("Request failed")).toBeVisible()
  await expect(plugins.getByText("No plugins configured", { exact: true })).toHaveCount(0)
  state.fail = false
  await plugins.getByRole("button", { name: "Retry", exact: true }).click()
  await expect(plugins.getByText("supermemory", { exact: true })).toBeVisible()
  await expect(plugins.getByText("builtin", { exact: true })).toHaveCount(0)
  await expect(plugins.locator('[title="Plugin failed to activate"]')).toContainText("Failed")
  await expect(trigger(page, "plugins")).toContainText("2")

  await expect(section(page, "skills").getByRole("button", { name: "find-skills", exact: true })).toBeVisible()
  await expect(section(page, "skills").getByRole("button", { name: "review-animations", exact: true })).toBeVisible()
  await expect(section(page, "lsp").getByText("typescript", { exact: true })).toBeVisible()
  await expect(section(page, "lsp").getByText("rust", { exact: true })).toHaveCount(0)
  await expect(section(page, "mcp").getByRole("switch", { name: "summary-mcp", exact: true })).toBeChecked()
  expect(warnings).toEqual([])
})

test("MCP rows toggle once per action and keep sign-in, errors, and management available", async ({ page }) => {
  await mockStressTimeline(page, {
    mcp: [
      { name: "figma", status: { status: "connected" } },
      { name: "linear", status: { status: "needs_auth" }, integrationID: "linear-oauth" },
      { name: "playwright", status: { status: "failed", error: "Connection refused" } },
      { name: "waiting", status: { status: "pending" } },
      { name: "off", status: { status: "disabled" } },
    ],
  })
  const writes: string[] = []
  page.on("request", (request) => {
    const url = new URL(request.url())

    if (request.method() === "POST" && url.pathname.startsWith("/api/experimental/mcp/")) writes.push(url.pathname)
  })
  await page.goto(sessionHref(fixture.targetID))
  await page.getByRole("button", { name: "Extensions", exact: true }).click()
  const mcp = section(page, "mcp")
  const connected = mcp.getByRole("switch", { name: "figma", exact: true })
  const disabled = mcp.getByRole("switch", { name: "off", exact: true })

  await expect(trigger(page, "mcp")).toContainText("1 of 5 connected")
  await expect(mcp.getByRole("switch")).toHaveCount(3)
  await expect(connected).toBeChecked()
  await expect(disabled).not.toBeChecked()
  await expect(mcp.getByRole("switch", { name: "waiting", exact: true })).toBeDisabled()
  await expect(mcp.getByRole("button", { name: "Sign in to linear", exact: true })).toBeVisible()
  await expect(mcp.getByRole("button", { name: "Details for playwright", exact: true })).toBeVisible()
  await expect(mcp.getByText("Connection refused")).toHaveCount(0)
  await page.screenshot({ path: test.info().outputPath("mcp-toggles.png"), animations: "disabled" })

  for (const [index, target] of ["control", "keyboard"].entries()) {
    const pending =
      index === 0
        ? await holdRoute(page, /\/api\/experimental\/mcp\/figma\/disconnect(?:\?|$)/, { method: "POST" })
        : undefined

    if (target === "control") await connected.click()

    if (target === "keyboard") await connected.press("Space")

    if (pending) {
      await pending.arrived
      await expect(connected).toBeDisabled()
      pending.release()
    }

    await expect(connected).toBeChecked({ checked: index % 2 !== 0 })
    await expect(connected).toBeEnabled()
    expect(writes).toEqual(
      Array.from(
        { length: index + 1 },
        (_, index) => `/api/experimental/mcp/figma/${index % 2 !== 0 ? "connect" : "disconnect"}`,
      ),
    )
  }

  await disabled.press("Space")
  await expect(disabled).toBeChecked()
  expect(writes.at(-1)).toBe("/api/experimental/mcp/off/connect")

  await mcp.getByRole("button", { name: "Retry", exact: true }).click()
  await expect.poll(() => writes.at(-1)).toBe("/api/experimental/mcp/playwright/connect")

  await mcp.getByRole("button", { name: "Details for playwright", exact: true }).click()
  await expect(page.getByRole("dialog").getByText("Connection refused")).toBeVisible()
  await page.keyboard.press("Escape")

  await mcp.getByRole("button", { name: "Manage MCP servers", exact: true }).click()
  await expect(page.getByRole("dialog").getByText("MCPs", { exact: true })).toBeVisible()
})

test("extensions open config files and skills in a side tab and start setup sessions", async ({ page }) => {
  const global = "C:/Users/kit/.config/opencode/opencode.jsonc"
  const skill = `${fixture.directory}/.opencode/skills/release-notes/SKILL.md`

  await mockStressTimeline(page, {
    mcp: [{ name: "atlas-search", status: { status: "connected" } }],
    plugins: [],
    skills: [{ id: "release-notes", name: "release-notes", path: skill, content: "Release notes" }],
    configEntries: [
      {
        type: "document",
        path: global,
        info: { mcp: { servers: { "atlas-search": { type: "remote", url: "https://atlas.example" } } } },
      },
      // An empty project override used to win, so the servers' own file never opened.
      { type: "document", path: `${fixture.directory}/.opencode/opencode.jsonc`, info: { mcp: {} } },
    ],
    fileContent: (path) => ({ type: "text", content: `contents:${path}` }),
  })
  await page.goto(sessionHref(fixture.targetID))
  const button = page.getByRole("button", { name: "Extensions", exact: true })
  await button.click()

  // A file outside the workspace is read by name from its own directory.
  const read = page.waitForRequest((request) => new URL(request.url()).pathname.endsWith("/api/fs/read/opencode.jsonc"))
  await section(page, "mcp").getByRole("button", { name: "Configuration file", exact: true }).click()
  expect(new URL((await read).url()).searchParams.get("location[directory]")).toBe("C:/Users/kit/.config/opencode/")
  await expect(page.getByRole("tab", { name: "opencode.jsonc", exact: true })).toHaveAttribute("aria-selected", "true")
  await expect(page.getByText("contents:opencode.jsonc", { exact: true })).toBeVisible()

  await button.click()
  await section(page, "skills").getByRole("button", { name: "release-notes", exact: true }).click()
  await expect(page.getByRole("tab", { name: "SKILL.md", exact: true })).toHaveAttribute("aria-selected", "true")

  // Setup starts a draft session in the global configuration's directory, its prompt filled in.
  await button.click()
  await section(page, "plugins").getByRole("button", { name: "Add a plugin with OpenCode", exact: true }).click()
  await expect(page).toHaveURL(/\/new-session\?/)
  await expect(page.locator('[data-component="composer-editor"]')).toContainText(
    "Help me add a plugin to my global OpenCode config.",
  )
})

test.describe("remote configuration", () => {
  test.use({ serviceWorkers: "block", permissions: ["clipboard-read", "clipboard-write"] })

  test("remote servers copy each service's configuration path", async ({ page }) => {
    const remote = "http://summary-remote.test:4096"
    const home = "/home/remote/.config/opencode"

    const entries = [
      { type: "document", path: `${home}/mcp.jsonc`, info: { mcp: { servers: {} } } },
      { type: "document", path: `${home}/plugins.json`, info: { plugins: [] } },
      { type: "document", path: `${home}/skills.jsonc`, info: { skills: [] } },
      { type: "document", path: `${home}/lsp.json`, info: { lsp: false } },
      { type: "document", path: `${fixture.directory}/opencode.json`, info: {} },
      { type: "document", path: `${fixture.directory}/.opencode/agents/review.md`, info: {} },
    ]

    await mockOpenCodeServer(page, {
      server: remote,
      sessions: fixture.sessions,
      provider: fixture.provider,
      directory: fixture.directory,
      project: fixture.project,
      pageMessages,
      configEntries: entries,
    })
    await seed(page, { servers: [{ url: remote, name: "Remote server" }] })
    await page.goto(sessionHref(fixture.targetID, remote))
    await page.getByRole("button", { name: "Extensions", exact: true }).click()

    for (const service of [
      { id: "mcp", path: `${home}/mcp.jsonc` },
      { id: "plugins", path: `${home}/plugins.json` },
      { id: "skills", path: `${home}/skills.jsonc` },
      { id: "lsp", path: `${home}/lsp.json` },
    ]) {
      await section(page, service.id).getByRole("button", { name: "Copy configuration file path", exact: true }).click()
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(service.path)
    }

    entries.length = 0
    await page.evaluate(() => navigator.clipboard.writeText("original clipboard"))
    const copy = section(page, "skills").getByRole("button", { name: "Copy configuration file path", exact: true })
    await copy.click()
    await expect(page.getByText("No configuration file found", { exact: true })).toBeVisible()
    await expect(copy).toBeEnabled()
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("original clipboard")
  })
})

test("the project menu loads changes on demand and opens review", async ({ page }) => {
  const requests: string[] = []
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/vcs/diff") requests.push(request.url())
  })
  await openSession(page, {
    name: "ProjectChanges",
    vcsDiff: [fileDiff("README.md", { additions: 7, deletions: 3 })],
  })
  await page.getByRole("button", { name: "Extensions", exact: true }).click()
  await expect(extensions(page).locator('[data-section="mcp"]')).toBeVisible()
  expect(requests).toEqual([])
  const changes = await holdRoute(page, (url) => url.pathname === "/api/vcs/diff", { method: "GET" })
  await page.locator('[data-slot="session-location-trigger"]').click()
  const menu = page.locator('[data-slot="session-location-card"]')
  await changes.arrived
  await expect(menu.getByRole("menuitem", { name: "Loading changes…", exact: true })).toBeVisible()
  changes.release()
  const workspace = menu.getByRole("menuitem", { name: "Local repository", exact: true })
  await expect(menu.getByRole("menuitem", { name: "Move session to", exact: true })).toHaveCount(0)
  await workspace.click()
  const destinations = page.getByRole("menu", { name: "Local repository", exact: true })
  await expect(destinations.getByRole("menuitem", { name: "New worktree", exact: true })).toBeVisible()
  await expect(destinations.getByText("Move session to", { exact: true })).toBeVisible()
  await page.screenshot({ path: test.info().outputPath("project-menu-location-submenu.png"), animations: "disabled" })
  await destinations.getByRole("menuitem", { name: "New worktree", exact: true }).press("Escape")
  await expect(destinations).toBeHidden()
  await expect(menu).toBeHidden()
  await page.locator('[data-slot="session-location-trigger"]').click()
  await expect(menu).toBeVisible()
  const row = menu.getByRole("menuitem", { name: /1 Changed file/ })
  await expect(row).toContainText("+7")
  await expect(row).toContainText("-3")
  await expect(menu.locator(":scope > *")).toHaveText([
    /ProjectChanges$/,
    "Local repository",
    "main",
    /1 Changed file.*\+7.*-3/,
    "",
    "This computer",
    "C:/OpenCode/ProjectChanges",
    "",
    "Edit project",
  ])

  const muted = await menu
    .locator('[data-slot="session-location-path"] [data-slot="icon-svg"]')
    .evaluate((icon) => getComputedStyle(icon).color)

  await expect
    .poll(() =>
      menu
        .locator('[data-slot="icon-svg"], [data-slot="menu-v2-item-chevron"]')
        .evaluateAll((icons) => [...new Set(icons.map((icon) => getComputedStyle(icon).color))]),
    )
    .toEqual([muted])
  await page.screenshot({ path: test.info().outputPath("project-menu-muted-icons.png"), animations: "disabled" })
  await row.click()
  await expect(menu).toBeHidden()
  await expect(page.locator("#review-panel")).toBeVisible()
})

test("a session in a worktree subfolder names its worktree and lists cached worktrees at once", async ({ page }) => {
  const root = "C:/OpenCode/SmokeWorktrees"
  await mockStressTimeline(page, {
    sessions: fixture.sessions.map((item) =>
      item.id === fixture.targetID ? { ...item, directory: `${root}/feature/packages/app` } : { ...item },
    ),
    // Found on disk: the project's stored sandboxes stay empty.
    worktrees: [
      { directory: fixture.directory },
      { directory: `${root}/feature`, strategy: "git" },
      { directory: `${root}/other`, strategy: "git" },
    ],
  })
  await page.goto(sessionHref(fixture.targetID))
  const trigger = page.locator('[data-slot="session-location-trigger"]')
  const summary = page.locator('[data-slot="session-location-card"]')
  const location = summary.getByRole("menuitem", { name: "feature", exact: true })
  await trigger.click()
  await expect(summary.getByText("feature", { exact: true })).toBeVisible()
  await expect(location).toBeVisible()
  await location.click()
  await enter(page, location, page.getByRole("menu", { name: "feature", exact: true }))
  await expect(page.getByRole("menuitem", { name: "Worktree", exact: true })).toBeVisible()
  await page.keyboard.press("Escape")
  await page.keyboard.press("Escape")
  await expect(summary).toBeHidden()

  // The reopened summary's menu lists the cached inventory while its own refresh stays held.
  const list = await holdRoute(page, (url) => url.pathname === "/api/worktree", { method: "GET" })
  await trigger.click()
  await location.click()
  await enter(page, location, page.getByRole("menu", { name: "feature", exact: true }))
  await list.arrived
  await page.getByRole("menuitem", { name: "Worktree", exact: true }).click()
  const existing = page.getByRole("menu").filter({ has: page.getByRole("menuitem", { name: "other", exact: true }) })
  await expect(existing.getByRole("menuitem", { name: "other", exact: true })).toBeVisible()
  await expect(existing.getByRole("menuitem", { name: "feature", exact: true })).toHaveCount(0)
  list.release()
})

test("a subagent lists its extensions but cannot move to another worktree", async ({ page }) => {
  const root = "C:/OpenCode/SmokeWorktrees"

  await mockStressTimeline(page, {
    sessions: fixture.sessions.map((item) =>
      item.id === fixture.targetID
        ? { ...item, parentID: fixture.sourceID, directory: `${root}/feature` }
        : { ...item },
    ),
    worktrees: [{ directory: fixture.directory }, { directory: `${root}/feature`, strategy: "git" }],
  })
  await page.goto(sessionHref(fixture.targetID))

  await page.getByRole("button", { name: "Extensions", exact: true }).click()
  await expect(extensions(page).locator('[data-section="mcp"]')).toBeVisible()
  await expect(extensions(page)).not.toContainText("feature")
  await expect(page.getByRole("button", { name: "More options", exact: true })).toHaveCount(0)
  await page.locator('[data-slot="session-location-trigger"]').click()
  const location = page.locator('[data-slot="session-location-card"]')
  await expect(location.getByText("feature", { exact: true })).toBeVisible()
  await expect(location.getByRole("menuitem", { name: "Move session to", exact: true })).toHaveCount(0)
  await expect(location.getByRole("menuitem", { name: "feature", exact: true })).toBeDisabled()
})

test("the details follow the routed session when it moves to another worktree", async ({ page }) => {
  const root = "C:/OpenCode/SmokeWorktrees"

  const sessions = fixture.sessions.map((item) =>
    item.id === fixture.targetID ? { ...item, directory: `${root}/feature` } : { ...item },
  )

  const mock = await mockStressTimeline(page, {
    sessions,
    worktrees: [
      { directory: fixture.directory },
      { directory: `${root}/feature`, strategy: "git" },
      { directory: `${root}/other`, strategy: "git" },
    ],
  })

  await page.goto(sessionHref(fixture.targetID))
  const trigger = page.locator('[data-slot="session-location-trigger"]')
  const summary = page.locator('[data-slot="session-location-card"]')
  const location = (name: string) => summary.getByText(name, { exact: true })
  await trigger.click()
  await expect(location("feature")).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(summary).toBeHidden()

  // The server moves the session; the screen stays mounted while its extensions read the new worktree.
  const moved = sessions.find((item) => item.id === fixture.targetID)

  if (moved) moved.directory = `${root}/other`
  await mock.push([
    {
      id: "evt_details_session_moved",
      type: "session.moved",
      created: 2,
      durable: { aggregateID: fixture.targetID, seq: 1, version: 1 },
      data: { sessionID: fixture.targetID, location: { directory: `${root}/other` }, projectID: fixture.project.id },
    },
  ])
  await expect(trigger.locator('[data-slot="session-location-worktree"]')).toHaveText("other")
  await trigger.click()
  await expect(location("other")).toBeVisible()
  await expect(location("feature")).toHaveCount(0)
})

// Moves the pointer straight across from a submenu's trigger into the open submenu, so it never crosses sibling items.
async function enter(page: Page, trigger: Locator, menu: Locator) {
  await expect(menu).toBeVisible()
  const from = (await trigger.boundingBox())!
  const to = (await menu.boundingBox())!
  await page.mouse.move(to.x + to.width / 2, from.y + from.height / 2, { steps: 5 })
}

function extensions(page: Page) {
  return page.locator('[data-slot="session-extensions-content"]')
}

function section(page: Page, id: string) {
  return extensions(page).locator(`[data-section="${id}"]`)
}

function trigger(page: Page, id: string) {
  return section(page, id).locator("button[aria-expanded]").first()
}

// Solid reports reactive work created without an owner; the warning appears in dev builds only.
function ownerWarnings(page: Page) {
  const warnings: string[] = []
  page.on("console", (event) => {
    if (event.text().includes("computations created outside")) warnings.push(event.text())
  })

  return warnings
}
