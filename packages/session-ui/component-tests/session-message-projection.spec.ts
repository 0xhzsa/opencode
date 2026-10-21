import { expect, story } from "../../storybook/playwright/story"

story("marks pending metadata without badging delivered, starting, or queued prompts", async ({ mount, page }) => {
  const timeline = await mount("current-prompt-message--pending")
  const indicator = timeline.locator('[data-slot="user-message-meta"] [data-slot="user-message-pending"]')
  const text = timeline.locator('[data-slot="user-message-text"]')

  for (const status of ["steering", "stranded", "starting", "queued", "delivered"]) {
    await timeline.getByLabel("Delivery state").selectOption(status)
    const pending = status === "steering" || status === "stranded"
    await expect(indicator).toHaveCount(pending ? 1 : 0)

    const colors = await timeline.evaluate((element, pending) => {
      const probe = document.createElement("span")
      probe.style.color = `var(--v2-text-text-${pending ? "muted" : "base"})`
      probe.style.backgroundColor = `var(--v2-background-bg-layer-${pending ? "01" : "02"})`
      element.append(probe)
      const result = { color: getComputedStyle(probe).color, background: getComputedStyle(probe).backgroundColor }
      probe.remove()

      return result
    }, pending)

    await expect(text).toHaveCSS("color", colors.color)
    await expect(text).toHaveCSS("background-color", colors.background)
  }

  await timeline.getByLabel("Delivery state").selectOption("steering")
  await timeline.getByLabel("Voice message", { exact: true }).check()
  const voice = timeline.getByRole("img", { name: "Voice", exact: true })
  await expect(voice).toBeVisible()
  await expect(indicator).toBeVisible()
  await expect(indicator).toHaveAttribute("aria-hidden", "true")

  await expect(voice.locator("use")).toHaveAttribute("href", "#opencode-v2-icon-outline-wave-audio")
  await expect(indicator.locator("use")).toHaveAttribute("href", "#opencode-v2-icon-outline-steer")

  await expect(voice).toHaveCSS("width", "20px")
  await expect(voice).toHaveCSS("height", "20px")
  await expect(voice.locator('[data-slot="icon-svg"]')).toHaveCSS("width", "14px")
  await expect(voice.locator('[data-slot="icon-svg"]')).toHaveCSS("height", "14px")

  const faint = await indicator.evaluate((element) => {
    const probe = document.createElement("span")
    probe.style.color = "var(--v2-icon-icon-faint)"
    element.append(probe)
    const color = getComputedStyle(probe).color
    probe.remove()

    return color
  })

  await expect(indicator).toHaveCSS("color", faint)
  await expect(timeline.locator('[data-slot="user-message-meta"]')).toHaveText(/^Pending/)
  await timeline.getByLabel("Grouped prompts", { exact: true }).check()
  await expect(timeline.locator('[data-run-folded] [data-slot="user-message-copy-wrapper"]')).toBeHidden()
  await expect(
    timeline.locator('[data-component="user-message"]:not([data-run-folded]) [data-slot="user-message-pending"]'),
  ).toBeVisible()
  await expect(timeline.getByRole("img", { name: "Pending", exact: true })).toHaveCount(0)
  await timeline.getByLabel("Grouped prompts", { exact: true }).uncheck()
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(indicator).toBeVisible()
  await expect(timeline.locator('[data-slot="user-message-meta"]')).toHaveText("Pending")
  await timeline.getByLabel("Prompt text", { exact: true }).uncheck()
  await expect(timeline.getByText("notes.json", { exact: true })).toBeVisible()
  await expect(indicator).toBeVisible()
  await timeline.getByRole("button", { name: "Move to queue", exact: true }).click()
  await expect(indicator).toHaveCount(0)
})

// Moved from packages/app/e2e/regression/session-timeline-collapse-state.spec.ts
story("keeps a manually collapsed tool collapsed when later assistant content streams", async ({ mount }) => {
  const timeline = await mount("current-session-file-changes--changing-files", { args: { scenario: "streaming" } })
  const tool = timeline.locator('[data-timeline-part-id="tool_edit_status"]')
  const trigger = tool.locator('[data-scope="apply-patch"] button')
  await expect(trigger).toHaveAttribute("aria-expanded", "true")
  // SAFETY: the locator targets a rendered DOM element, which is always an HTMLElement in the story.
  await tool.evaluate((element) => ((element as HTMLElement).dataset.regressionMarker = "before-stream"))
  await trigger.click()
  await expect(trigger).toHaveAttribute("aria-expanded", "false")
  await timeline.getByRole("button", { name: "Stream sibling content" }).click()
  await expect(timeline.getByText("Streaming added a later assistant text part.", { exact: true })).toBeVisible()
  await expect(tool).toHaveAttribute("data-regression-marker", "before-stream")
  await expect(trigger).toHaveAttribute("aria-expanded", "false")
  await expect(tool.locator("xpath=ancestor::*[@data-timeline-row]")).toHaveAttribute(
    "data-timeline-row",
    "AssistantPart",
  )
})

// Moved from packages/app/e2e/regression/session-timeline-projection.spec.ts
story("renders interruption independently when the turn is not compacted", async ({ mount }) => {
  const timeline = await mount("current-session-timeline-rows--conversation", { args: { scenario: "interruption" } })
  await expect(timeline.getByText("Interrupted", { exact: true })).toBeVisible()
  await expect(timeline.getByText("Before", { exact: true })).toBeVisible()
  await expect(timeline.getByText("After", { exact: true })).toBeVisible()

  const rows = await timeline
    .locator('[data-timeline-row="AssistantPart"], [data-timeline-row="TurnDivider"]')
    .evaluateAll((elements) => elements.map((element) => element.getAttribute("data-timeline-row")))

  expect(rows).toEqual(["AssistantPart", "TurnDivider", "AssistantPart"])
})

// Moved from packages/app/e2e/regression/session-timeline-projection.spec.ts
story("renders aliased and long custom model notices", async ({ mount, page }) => {
  await page.setViewportSize({ width: 420, height: 700 })
  const timeline = await mount("current-session-timeline-rows--conversation", { args: { scenario: "models" } })
  const shortName = "GPT-5.4 nano"
  const longName = "Company Gateway Extra Long Context Model for Narrow Timeline Layouts"

  const short = timeline
    .locator('[data-slot="session-timeline-notice"]')
    .filter({ hasText: shortName })
    .filter({ hasText: "xhigh" })

  const long = timeline.locator('[data-slot="session-timeline-notice"]').filter({ hasText: longName })
  await expect(short).toBeVisible()
  await expect(short.getByText(`Switched to ${shortName}`, { exact: true })).toBeVisible()
  await expect(short.locator('[data-slot="session-timeline-notice-variant"]')).toHaveText("xhigh")
  await expect(timeline.getByText("fast-nano", { exact: true })).toHaveCount(0)
  await expect(short.locator('[data-component="provider-icon"]')).toBeVisible()

  const variantDefault = timeline
    .locator('[data-slot="session-timeline-notice"]')
    .filter({ hasText: "Switched variant to Default" })

  const variantHigh = timeline
    .locator('[data-slot="session-timeline-notice"]')
    .filter({ hasText: "Switched variant to high" })

  await expect(variantDefault.getByText("Switched variant to Default", { exact: true })).toBeVisible()
  await expect(variantHigh.getByText("Switched variant to high", { exact: true })).toBeVisible()
  await expect(variantDefault.locator('[data-slot="session-timeline-notice-variant"]')).toHaveCount(0)
  await expect(variantHigh.locator('[data-slot="session-timeline-notice-variant"]')).toHaveCount(0)
  await expect(long).toBeVisible()
  await expect(long.locator('[data-component="provider-icon"]')).toBeVisible()
  await expect(long.locator('[data-slot="session-timeline-notice-variant"]')).toHaveCount(0)
  await expect(long.locator("[title]")).toHaveAttribute("title", `Switched to ${longName}`)
  await expect.poll(() => long.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
})

story("hydrates user attachments before preview or opening", async ({ page, mount }) => {
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0WQAAAAASUVORK5CYII="
  const requests: string[] = []
  await page.route("**/attachment-fixture/*", async (route) => {
    const name = route.request().url().split("/").at(-1)!
    requests.push(name)
    await route.fulfill({ json: { name, mime: name === "pixel.png" ? "image/png" : "text/plain", data: name === "pixel.png" ? png : "YWJj", source: { type: "inline" } } })
  })
  const view = await mount("attachment-hydration--deferred")
  const image = view.getByRole("img", { name: "pixel.png" })
  await expect(image).toHaveAttribute("src", `data:image/png;base64,${png}`)
  await expect.poll(() => image.evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBe(1)
  expect(requests).toEqual(["pixel.png"])
  await view.locator('[data-component="attachment-card"]').filter({ hasText: "note.txt" }).click()
  await expect(view.getByLabel("Opened attachment")).toHaveText("note.txt:YWJj")
  await image.click()
  await expect(page.getByRole("dialog").getByRole("img")).toHaveAttribute("src", `data:image/png;base64,${png}`)
  expect(requests).toEqual(["pixel.png", "note.txt"])
})

// Moved from packages/app/e2e/regression/session-timeline-projection.spec.ts
story("renders user image, file attachment, file reference, and agent reference", async ({ mount }) => {
  const timeline = await mount("current-session-timeline-rows--conversation", { args: { scenario: "attachments" } })
  await expect(timeline.getByAltText("pixel.png")).toBeVisible()
  await expect(timeline.getByText("tsconfig.json")).toBeVisible()
  await expect(timeline.getByText("@src/a.ts", { exact: true })).toBeVisible()
  await expect(timeline.getByText("@explore", { exact: true })).toBeVisible()

  const accent = await timeline.evaluate((element) => {
    const probe = document.createElement("span")
    probe.style.color = "var(--v2-text-text-accent)"
    element.append(probe)
    const color = getComputedStyle(probe).color
    probe.remove()

    return color
  })

  for (const mention of await timeline.locator("[data-highlight]").all()) {
    await expect(mention).toHaveCSS("color", accent)
    await expect(mention).toHaveCSS("font-weight", "440")
  }

  for (const prefix of await timeline.locator('[data-slot="user-message-mention-prefix"]').all()) {
    await expect(prefix).toHaveCSS("color", accent)
  }

  const attachments = timeline.locator('[data-slot="user-message-attachments"]')
  const body = timeline.locator('[data-slot="user-message-body"]')
  const [attachmentsBox, bodyBox] = await Promise.all([attachments.boundingBox(), body.boundingBox()])
  expect(attachmentsBox).not.toBeNull()
  expect(bodyBox).not.toBeNull()
  expect(bodyBox!.y - (attachmentsBox!.y + attachmentsBox!.height)).toBe(8)
})

story("links URLs in user messages without swallowing punctuation or mentions", async ({ mount }) => {
  const timeline = await mount("current-session-timeline-rows--conversation", { args: { scenario: "links" } })
  const links = timeline.locator('[data-slot="user-message-text"] a[data-slot="user-message-link"]')
  await expect(links).toHaveCount(2)
  await expect(links.nth(0)).toHaveText("https://github.com/Hona/mesh")
  await expect(links.nth(0)).toHaveAttribute("href", "https://github.com/Hona/mesh")
  await expect(links.nth(0)).toHaveAttribute("target", "_blank")
  await expect(links.nth(0)).toHaveCSS("cursor", "pointer")
  await expect(links.nth(1)).toHaveText("https://opencode.ai/docs")
  await expect(timeline.getByText("@src/a.ts", { exact: true })).toBeVisible()
  await expect(timeline.locator('[data-slot="user-message-text"]')).toHaveText(
    "set it up on this pc https://github.com/Hona/mesh, then compare @src/a.ts with (https://opencode.ai/docs).",
  )
})
