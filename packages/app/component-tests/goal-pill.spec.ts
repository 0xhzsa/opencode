import { expect, story } from "../../stories/playwright/story"

story("offers the goal actions that apply to its status", async ({ mount, page }) => {
  await mount("session-goal-pill--active")
  const pill = page.locator('[data-slot="session-goal-pill"]')
  const label = pill.locator('[data-slot="session-goal-label"]')
  await expect(label).toHaveText("Goal")
  // The objective lives in the popover, not the capsule.
  await expect(pill).not.toContainText("Make the test suite pass")

  await pill.click()
  // The popover is portaled outside the story root.
  const panel = page.locator('[data-slot="session-goal-panel"]')
  await expect(panel).toContainText("Make the test suite pass without skipping any tests")
  await expect(panel).toContainText("The parseDate test still fails.")
  await expect(panel.locator('[data-action="session-goal-resume"]')).toHaveCount(0)

  await panel.locator('[data-action="session-goal-pause"]').click()
  await expect(label).toHaveText("Goal paused")
  await expect(panel.locator('[data-action="session-goal-pause"]')).toHaveCount(0)
  await expect(panel.locator('[data-action="session-goal-resume"]')).toBeVisible()

  await panel.locator('[data-action="session-goal-clear"]').click()
  await expect(pill).toHaveCount(0)
})
