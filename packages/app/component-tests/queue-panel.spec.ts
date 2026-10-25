import { expect, story } from "../../stories/playwright/story"

story("arrow keys on a reorder handle move its prompt and keep focus", async ({ mount }) => {
  const component = await mount("session-queue-panel--short")
  const texts = component.locator('[data-action="session-queue-edit"]')

  const handle = component
    .locator('[data-component="session-queue-row"]', { hasText: "Compare the Alpha and Beta fixtures" })
    .getByRole("button", { name: "Reorder queued prompt" })

  await handle.focus()
  await handle.press("ArrowDown")
  await expect(texts).toHaveText([
    "Rename the Alpha export",
    "Compare the Alpha and Beta fixtures",
    "Add a Beta regression test",
  ])
  await expect(handle).toBeFocused()
  await handle.press("ArrowDown")
  await handle.press("ArrowDown")
  await expect(texts).toHaveText([
    "Rename the Alpha export",
    "Add a Beta regression test",
    "Compare the Alpha and Beta fixtures",
  ])
  await handle.press("ArrowUp")
  await expect(texts.nth(1)).toHaveText("Compare the Alpha and Beta fixtures")
  await expect(handle).toBeFocused()
})

story("Escape cancels a drag", async ({ mount, page }) => {
  const component = await mount("session-queue-panel--short")
  const texts = component.locator('[data-action="session-queue-edit"]')
  const order = await texts.allTextContents()
  const handle = component.getByRole("button", { name: "Reorder queued prompt" }).first()
  const box = await handle.boundingBox()

  if (!box) throw new Error("The reorder handle is not visible")

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2, box.y + 70, { steps: 8 })
  await page.keyboard.press("Escape")
  await page.mouse.move(box.x + box.width / 2, box.y + 140, { steps: 8 })
  await page.mouse.up()
  await expect(texts).toHaveText(order)
  expect(await page.evaluate(() => getSelection()?.toString())).toBe("")
})

story("dragging to the edge of a scrolling queue scrolls it", async ({ mount, page }) => {
  const component = await mount("session-queue-panel--scrolling")
  const list = component.locator('[data-slot="session-queue-list"]')
  const texts = component.locator('[data-action="session-queue-edit"]')
  const handle = component.getByRole("button", { name: "Reorder queued prompt" }).first()
  const box = await handle.boundingBox()
  const bounds = await list.boundingBox()

  if (!box || !bounds) throw new Error("The queue is not visible")

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2, bounds.y + bounds.height - 2, { steps: 10 })
  await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBeGreaterThan(40)
  await page.mouse.up()
  await expect(texts.last()).toHaveText("Compare the Alpha and Beta fixtures")
})
