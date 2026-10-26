import type { Locator } from "@playwright/test"
import type { MotionKnob } from "@opencode/ui/motion-tuning"
import { expect, sourceURL, story } from "../../stories/playwright/story"

story("resizes the dock to fit different answer counts", async ({ mount }) => {
  const component = await mount("app-current-session-surface--question-answer-counts")
  const question = component.locator('[data-component="dock-prompt"][data-kind="question"]')
  const next = question.getByRole("button", { name: "Next", exact: true })
  await expect(question.getByRole("radio", { name: /Focused/ })).toBeFocused()
  await expect(next).toBeEnabled()

  const height = () => question.evaluate((element) => element.getBoundingClientRect().height)
  const initial = await height()
  await next.click()
  await expect.poll(height).toBeGreaterThan(initial)
  await expect(question.getByRole("checkbox", { name: "Diagnostics", exact: true })).toBeVisible()

  const expanded = await height()
  const back = question.getByRole("button", { name: "Back", exact: true })
  await expect(back).toBeEnabled()
  await back.click()
  await expect.poll(height).toBeLessThan(expanded)
  await expect(question.getByRole("radio", { name: /Focused/ })).toBeVisible()
})

story("selects single answers and toggles multiple answers with number keys", async ({ mount }) => {
  const component = await mount("app-current-session-surface--question-request")
  const question = component.locator('[data-component="dock-prompt"][data-kind="question"]')
  const focused = question.getByRole("radio", { name: /Focused/ })
  const wide = question.getByRole("radio", { name: /Wide/ })
  const customRadio = question.getByRole("radio", { name: "Type your own answer…", exact: true })
  const input = question.getByRole("textbox", { name: "Type your own answer…", exact: true })
  const next = question.getByRole("button", { name: "Next", exact: true })
  await expect(focused).toBeFocused()

  await focused.press("2")
  await expect(wide).toBeChecked()
  await expect(focused).not.toBeChecked()
  await expect(wide).toBeFocused()
  await next.press("1")
  await expect(focused).toBeChecked()
  await expect(wide).not.toBeChecked()
  await focused.press("3")
  await expect(customRadio).toBeChecked()
  await expect(input).toBeFocused()
  await expect(focused).not.toBeChecked()
  await expect(wide).not.toBeChecked()
  await input.press("Escape")
  await expect(customRadio).toBeFocused()
  await customRadio.press("2")
  await expect(wide).toBeChecked()
  await expect(customRadio).not.toBeChecked()

  await next.click()
  const files = question.getByRole("checkbox", { name: "Changed files", exact: true })
  const terminal = question.getByRole("checkbox", { name: "Terminal", exact: true })
  const customCheckbox = question.getByRole("checkbox", { name: "Type your own answer…", exact: true })
  await expect(files).toBeFocused()
  await files.press("1")
  await expect(files).toBeChecked()
  await files.press("2")
  await expect(terminal).toBeChecked()
  await expect(files).toBeChecked()
  await terminal.press("2")
  await expect(terminal).not.toBeChecked()
  await expect(files).toBeChecked()

  await terminal.press("4")
  await expect(customCheckbox).toBeChecked()
  await expect(input).toBeFocused()
  await expect(files).toBeChecked()
  await expect(terminal).not.toBeChecked()
  await input.press("Escape")
  await expect(customCheckbox).toBeFocused()
  await customCheckbox.press("4")
  await expect(customCheckbox).not.toBeChecked()
  await expect(files).toBeChecked()
  await expect(terminal).not.toBeChecked()
})

story("moves only the highlight with Up and Down and marks it with Space", async ({ mount, page }) => {
  const component = await mount("app-current-session-surface--question-request")
  const question = component.locator('[data-component="dock-prompt"][data-kind="question"]')
  const focused = question.getByRole("radio", { name: /Focused/ })
  const wide = question.getByRole("radio", { name: /Wide/ })
  const custom = question.getByRole("radio", { name: "Type your own answer…", exact: true })
  const input = question.getByRole("textbox", { name: "Type your own answer…", exact: true })
  const highlight = question.locator('[data-slot="question-highlight"]')
  const clip = () => highlight.evaluate((element) => element.style.clipPath)
  await expect(focused).toBeFocused()
  await expect(focused).not.toBeChecked()
  const first = await clip()

  await page.keyboard.press("ArrowDown")
  await expect(wide).toBeFocused()
  await expect(wide).not.toBeChecked()
  await expect(focused).not.toBeChecked()
  await expect(wide).toHaveAttribute("tabindex", "0")
  await expect(focused).toHaveAttribute("tabindex", "-1")
  await expect.poll(clip).not.toBe(first)

  await page.keyboard.press("ArrowDown")
  await expect(custom).toBeFocused()
  await expect(custom).not.toBeChecked()
  await expect(input).not.toBeFocused()

  await page.keyboard.press("ArrowUp")
  await expect(wide).toBeFocused()
  await page.keyboard.press(" ")
  await expect(wide).toBeChecked()
  await expect(wide).toBeFocused()
  await expect(question.getByRole("button", { name: "Next", exact: true })).toBeVisible()

  await page.keyboard.press("Home")
  await expect(focused).toBeFocused()
  await expect(focused).not.toBeChecked()
  await expect(wide).toBeChecked()
})

story("shows the highlight only for hover or the arrow keys, never for a click", async ({ mount, page }) => {
  const component = await mount("app-current-session-surface--question-request")
  const question = component.locator('[data-component="dock-prompt"][data-kind="question"]')
  const focused = question.getByRole("radio", { name: /Focused/ })
  const wide = question.getByRole("radio", { name: /Wide/ })
  const highlight = question.locator('[data-slot="question-highlight"]')
  const clip = () => highlight.evaluate((element) => element.style.clipPath)
  await expect(focused).toBeFocused()
  await expect(highlight).toBeHidden()

  await wide.dispatchEvent("click")
  await expect(wide).toBeChecked()
  await expect(highlight).toBeHidden()

  await page.keyboard.press("1")
  await expect(highlight).toBeHidden()

  await wide.hover()
  await expect(highlight).toBeVisible()
  await page.keyboard.press(" ")
  await page.mouse.move(0, 0)
  await expect(highlight).toBeHidden()

  await wide.hover()
  await expect(highlight).toBeVisible()
  const hovered = await clip()
  await expect.poll(() => highlight.evaluate((element) => getComputedStyle(element).transitionDuration)).toBe("0s")

  await wide.click()
  await expect(wide).toBeChecked()
  await expect(highlight).toBeVisible()
  expect(await clip()).toBe(hovered)

  await page.mouse.move(0, 0)
  await expect(highlight).toBeHidden()

  await focused.click()
  await page.mouse.move(0, 0)
  await expect(focused).toBeChecked()
  await expect(highlight).toBeHidden()

  await page.keyboard.press("ArrowDown")
  await expect(highlight).toBeVisible()
  await page.mouse.move(0, 0)
  await expect(highlight).toBeVisible()

  await focused.hover()
  await page.mouse.move(0, 0)
  await expect(highlight).toBeHidden()
})

story("Enter picks the highlighted answer and moves on", async ({ mount, page }) => {
  const component = await mount("app-current-session-surface--question-request")
  const question = component.locator('[data-component="dock-prompt"][data-kind="question"]')
  const focused = question.getByRole("radio", { name: /Focused/ })
  const wide = question.getByRole("radio", { name: /Wide/ })
  const files = question.getByRole("checkbox", { name: "Changed files", exact: true })
  const terminal = question.getByRole("checkbox", { name: "Terminal", exact: true })
  await expect(focused).toBeFocused()

  await page.keyboard.press("ArrowDown")
  await page.keyboard.press("Enter")
  await expect(files).toBeFocused()
  await expect(files).not.toBeChecked()
  await expect(question.getByRole("button", { name: "Submit", exact: true })).toBeVisible()

  await page.keyboard.press("ArrowLeft")
  await expect(wide).toBeFocused()
  await expect(wide).toBeChecked()
  await expect(focused).not.toBeChecked()
  await page.keyboard.press("ArrowRight")

  await page.keyboard.press("ArrowDown")
  await page.keyboard.press(" ")
  await expect(terminal).toBeChecked()
  await expect(files).not.toBeChecked()
  await page.keyboard.press("Enter")
  await expect(question).toBeHidden()
})

story("typing on the highlighted custom answer starts it", async ({ mount, page }) => {
  const component = await mount("app-current-session-surface--question-request")
  const question = component.locator('[data-component="dock-prompt"][data-kind="question"]')
  const focused = question.getByRole("radio", { name: /Focused/ })
  const custom = question.getByRole("radio", { name: "Type your own answer…", exact: true })
  const input = question.getByRole("textbox", { name: "Type your own answer…", exact: true })
  await expect(focused).toBeFocused()
  await focused.press("1")
  await expect(focused).toBeChecked()

  await page.keyboard.press("End")
  await expect(custom).toBeFocused()
  await expect(custom).not.toBeChecked()
  await page.keyboard.press("S")
  await expect(input).toBeFocused()
  await expect(custom).toBeChecked()
  await expect(focused).not.toBeChecked()
  await page.keyboard.type("plit")
  await expect(input).toHaveValue("Split")

  await page.keyboard.press("Enter")
  await expect(question.getByRole("checkbox", { name: "Changed files", exact: true })).toBeFocused()
  await page.keyboard.press("ArrowLeft")
  await expect(custom).toBeChecked()
  await expect(input).toHaveValue("Split")
})

story("switches questions with Left and Right outside the text field", async ({ mount, page }) => {
  const component = await mount("app-current-session-surface--question-request")
  const question = component.locator('[data-component="dock-prompt"][data-kind="question"]')
  const focused = question.getByRole("radio", { name: /Focused/ })
  const files = question.getByRole("checkbox", { name: "Changed files", exact: true })
  const submit = question.getByRole("button", { name: "Submit", exact: true })
  const wide = question.getByRole("radio", { name: /Wide/ })
  await expect(focused).toBeFocused()
  await page.keyboard.press("ArrowDown")
  await page.keyboard.press(" ")
  await expect(wide).toBeChecked()

  await page.keyboard.press("ArrowRight")
  await expect(files).toBeFocused()
  await expect(submit).toBeVisible()
  await page.keyboard.press("ArrowRight")
  await expect(submit).toBeVisible()
  await expect(files).toBeFocused()

  await page.keyboard.press("ArrowLeft")
  await expect(wide).toBeFocused()
  await expect(wide).toBeChecked()

  const input = question.getByRole("textbox", { name: "Type your own answer…", exact: true })
  await input.focus()
  await input.fill("ab")
  await page.keyboard.press("ArrowLeft")
  await expect(input).toBeFocused()
  await expect(focused).toBeVisible()
})

story("toggles checkboxes with Space on key down and moves focus with arrows", async ({ mount, page }) => {
  const component = await mount("app-current-session-surface--question-request")
  const question = component.locator('[data-component="dock-prompt"][data-kind="question"]')
  await question.getByRole("button", { name: "Next", exact: true }).click()
  const files = question.getByRole("checkbox", { name: "Changed files", exact: true })
  const terminal = question.getByRole("checkbox", { name: "Terminal", exact: true })
  await expect(files).toBeFocused()

  await page.keyboard.down(" ")
  await expect(files).toBeChecked()
  await page.keyboard.down(" ")
  await page.keyboard.up(" ")
  await expect(files).toBeChecked()

  await page.keyboard.press("ArrowDown")
  await expect(terminal).toBeFocused()
  await expect(terminal).not.toBeChecked()
  await page.keyboard.press(" ")
  await expect(terminal).toBeChecked()
  await page.keyboard.press(" ")
  await expect(terminal).not.toBeChecked()
  await expect(files).toBeChecked()
})

story("ignores modified, out-of-range, and repeated number shortcuts", async ({ mount, page }) => {
  const component = await mount("app-current-session-surface--question-request")
  const question = component.locator('[data-component="dock-prompt"][data-kind="question"]')
  const focused = question.getByRole("radio", { name: /Focused/ })
  const wide = question.getByRole("radio", { name: /Wide/ })
  await expect(focused).toBeFocused()
  await focused.press("1")
  await focused.press("9")
  await focused.press("Alt+2")
  await expect(focused).toBeChecked()
  await expect(wide).not.toBeChecked()

  await question.getByRole("button", { name: "Next", exact: true }).click()
  const terminal = question.getByRole("checkbox", { name: "Terminal", exact: true })
  await expect(question.getByRole("checkbox", { name: "Changed files", exact: true })).toBeFocused()
  await page.keyboard.down("2")
  await expect(terminal).toBeChecked()
  await page.keyboard.down("2")
  await expect(terminal).toBeChecked()
  await page.keyboard.up("2")
})

story("types digits into the custom answer without selecting numbered options", async ({ mount }) => {
  const component = await mount("app-current-session-surface--question-request")
  const question = component.locator('[data-component="dock-prompt"][data-kind="question"]')
  const focused = question.getByRole("radio", { name: /Focused/ })
  const custom = question.getByRole("radio", { name: "Type your own answer…", exact: true })
  const input = question.getByRole("textbox", { name: "Type your own answer…", exact: true })
  await expect(focused).toBeFocused()
  await focused.press("3")
  await expect(input).toBeFocused()
  await input.press("1")
  await input.press("2")
  await input.press("3")
  await expect(input).toHaveValue("123")
  await expect(custom).toBeChecked()
  await expect(focused).not.toBeChecked()
  await expect(question.getByRole("radio", { name: /Wide/ })).not.toBeChecked()
})

story("leaves Enter and Escape to an IME composition in the custom answer", async ({ mount }) => {
  const component = await mount("app-current-session-surface--question-request")
  const question = component.locator('[data-component="dock-prompt"][data-kind="question"]')
  const toggle = question.getByRole("radio", { name: "Type your own answer…", exact: true })
  const input = question.getByRole("textbox", { name: "Type your own answer…", exact: true })
  await input.focus()
  await input.fill("にほん")

  const compose = (key: string, keyCode: number) =>
    input.evaluate(
      (element, init) =>
        element.dispatchEvent(new KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true })),
      { key, keyCode, isComposing: keyCode !== 229 },
    )

  await compose("Enter", 13)
  await compose("Escape", 27)
  await compose("Enter", 229)
  await compose("Escape", 229)
  await expect(input).toBeFocused()
  await expect(input).toHaveValue("にほん")
  await expect(question).toBeVisible()
  await input.press("Escape")
  await expect(toggle).toBeFocused()
  await expect(question).toBeVisible()
})

story("shows question navigation shortcuts in buttons and tooltips", async ({ mount, page }) => {
  const component = await mount("app-current-session-surface--question-request")
  const mac = await page.evaluate(() => /Mac|iPhone|iPad|iPod/.test(navigator.platform))
  const shortcut = mac ? "⌘⏎" : "Ctrl+⏎"
  const next = component.getByRole("button", { name: "Next", exact: true })
  await expect(next.locator('[data-slot="question-submit-shortcut"]')).toBeVisible()
  await expect(next.locator('[data-slot="question-submit-shortcut"]')).toHaveText(shortcut)
  await expect(next).toHaveAttribute("aria-keyshortcuts", "Meta+Enter Control+Enter")
  await next.hover()
  await expect(page.getByRole("tooltip")).toContainText("Next")
  await expect(page.getByRole("tooltip")).toContainText(shortcut)
  await next.press(mac ? "Meta+Enter" : "Control+Enter")
  const submit = component.getByRole("button", { name: "Submit", exact: true })
  await expect(submit.locator('[data-slot="question-submit-shortcut"]')).toBeVisible()
  await expect(submit.locator('[data-slot="question-submit-shortcut"]')).toHaveText(shortcut)
  await expect(submit).toHaveAttribute("aria-keyshortcuts", "Meta+Enter Control+Enter")
  await submit.hover()
  await expect(page.getByRole("tooltip")).toContainText("Submit")
  await expect(page.getByRole("tooltip")).toContainText(shortcut)
  const back = component.getByRole("button", { name: "Back", exact: true })
  await expect(back).toHaveText("Back")
  await expect(back).toHaveAttribute("aria-keyshortcuts", mac ? "Meta+[" : "Alt+ArrowLeft")
  await back.hover()
  // Moving straight from Submit opens Back's tooltip while Submit's is still fading out.
  await expect(page.getByRole("tooltip", { name: /Back/ })).toContainText(mac ? "⌘[" : "Alt+←")
  await back.press(mac ? "Meta+[" : "Alt+ArrowLeft")
  await expect(next).toBeVisible()
})

story("keeps the custom answer input and dock geometry stable while editing", async ({ mount }) => {
  const component = await mount("app-current-session-surface--question-request")
  const question = component.locator('[data-component="dock-prompt"][data-kind="question"]')
  const row = question.locator('[data-slot="question-option"][data-custom="true"]')
  const input = question.getByRole("textbox", { name: "Type your own answer…", exact: true })
  const toggle = question.getByRole("radio", { name: "Type your own answer…", exact: true })
  await expect(question.getByRole("radio", { name: /Focused/ })).toBeFocused()
  await expect(input).toBeEditable()
  await expect(input).toHaveValue("")
  const node = await input.evaluateHandle((element) => element)
  const height = () => question.evaluate((element) => element.getBoundingClientRect().height)
  const initial = await height()
  const draft = "A custom answer long enough to wrap if the editor becomes multiline instead of staying single-line"

  const predefined = question.getByRole("radio", { name: /Focused/ })
  await predefined.click()
  await input.focus()
  await expect(input).toBeFocused()
  await expect(predefined).toBeChecked()
  await expect(toggle).not.toBeChecked()
  await row.click({ position: { x: 4, y: 4 } })
  await expect(toggle).toBeChecked()
  await expect(input).toBeFocused()
  await expect(input).toHaveValue("")
  await expect(predefined).not.toBeChecked()
  await input.fill(draft)
  await expect(input).toHaveValue(draft)
  await expect(toggle).toBeChecked()
  await expect(predefined).not.toBeChecked()
  await expect.poll(height).toBe(initial)
  await input.press("Escape")
  await expect(toggle).toBeFocused()
  await expect(input).toHaveValue(draft)
  await row.click({ position: { x: 30, y: 20 } })
  await expect(input).toBeFocused()
  await expect(input).toHaveValue(draft)
  await expect
    .poll(() => input.evaluate((element, original) => element === original && original.isConnected, node))
    .toBe(true)
  await node.dispose()
})

story("marks one-answer questions with round keys and many-answer questions with square keys", async ({ mount }) => {
  const component = await mount("app-current-session-surface--question-request")
  const question = component.locator('[data-component="dock-prompt"][data-kind="question"]')
  const keys = question.locator('[data-slot="question-option-key"]')
  const focused = question.getByRole("radio", { name: /Focused/ })
  await expect(focused).toBeFocused()
  await expect(keys).toHaveText(["1", "2", "3"])
  await expect(keys.first()).toBeVisible()
  await expect(keys.first()).toHaveAttribute("data-type", "radio")
  await expect(question.getByText("Pick any", { exact: true })).toHaveCount(0)
  await focused.press("1")
  await expect(focused.locator('[data-slot="question-option-key"]')).toHaveAttribute("data-picked", "true")

  await question.getByRole("button", { name: "Next", exact: true }).click()
  const files = question.getByRole("checkbox", { name: "Changed files", exact: true })
  await expect(files).toBeFocused()
  await expect(keys.first()).toHaveAttribute("data-type", "checkbox")
  await expect(question.getByText("Pick any", { exact: true })).toBeVisible()
})

story("toggles a lone many-answer question and sends it with Enter", async ({ mount, page }) => {
  const component = await mount("app-current-session-surface--question-multi-select")
  const question = component.locator('[data-component="dock-prompt"][data-kind="question"]')
  const files = question.getByRole("checkbox", { name: "Changed files", exact: true })
  const terminal = question.getByRole("checkbox", { name: "Terminal", exact: true })
  await expect(files).toBeFocused()
  await expect(question.getByText("Pick any", { exact: true })).toBeVisible()
  await expect(question.locator('[data-slot="question-option-key"][data-type="radio"]')).toHaveCount(0)

  await page.keyboard.press(" ")
  await page.keyboard.press("2")
  await expect(files).toBeChecked()
  await expect(terminal).toBeChecked()
  await expect(terminal.locator('[data-slot="question-option-key"]')).toHaveAttribute("data-picked", "true")
  await page.keyboard.press("Enter")
  await expect(question).toBeHidden()
})

// Runs one action in the page, then samples the next frames: what the user sees, and whether anything is animating.
const act = (question: Locator, action: string) =>
  question.evaluate(async (root, action) => {
    const options = root.querySelector<HTMLElement>('[data-slot="question-options"]')!
    const list = root.querySelector<HTMLElement>('[data-slot="question-options-list"]')!
    const details = root.querySelector<HTMLElement>('[data-slot="question-details"]')!

    const sample = () => ({
      title: root.querySelector('[data-slot="question-header-title"]')!.textContent,
      height: Math.round(options.getBoundingClientRect().height),
      list: Math.round(list.getBoundingClientRect().height),
      shown: getComputedStyle(options).visibility !== "hidden" && getComputedStyle(options).opacity === "1",
      still: getComputedStyle(details).transform === "none" && getComputedStyle(details).opacity === "1",
      animations: document.getAnimations().length,
    })

    if (action.startsWith("key:"))
      document.activeElement!.dispatchEvent(
        new KeyboardEvent("keydown", { key: action.slice(4), bubbles: true, cancelable: true }),
      )

    if (action.startsWith("dash:"))
      root.querySelectorAll<HTMLElement>('[data-slot="question-progress-segment"]')[Number(action.slice(5))]!.click()

    if (action.startsWith("button:"))
      root.querySelector<HTMLElement>(`button[aria-label="${action.slice(7)}"]`)!.click()
    const frames = [sample()]

    for (let i = 0; i < 4; i++) {
      await new Promise((resolve) => requestAnimationFrame(resolve))
      frames.push(sample())
    }

    return frames
  }, action)

story("switches questions, folds and submits on the same frame with the dock's motion off", async ({ mount, page }) => {
  const component = await mount("app-current-session-surface--question-request")
  const question = component.locator('[data-component="dock-prompt"][data-kind="question"]')
  await expect(question.getByRole("radio", { name: /Focused/ })).toBeFocused()
  await expect(component.locator('[data-component="session-question-dock"]')).toHaveAttribute("data-animated", "false")

  // The new question shows at its final size, unmoved and unfaded, as soon as the key or click lands.
  for (const [action, title] of [
    ["key:ArrowRight", "2 of 2 questions"],
    ["dash:0", "1 of 2 questions"],
    ["key:ArrowRight", "2 of 2 questions"],
  ] as const) {
    const frames = await act(question, action)
    expect(frames[0]!.title, action).toBe(title)
    expect(
      frames.every((frame) => frame.still && frame.shown && frame.animations === 0),
      action,
    ).toBe(true)
    expect(
      frames.every((frame) => frame.height > 0 && frame.height === frame.list),
      action,
    ).toBe(true)
  }

  // Minimizing and restoring fold the answers away and back at once.
  const folded = await act(question, "button:Minimize question")
  expect(folded.every((frame) => frame.height === 0 && !frame.shown && frame.animations === 0)).toBe(true)
  const restored = await act(question, "button:Restore question")
  expect(
    restored.every((frame) => frame.height > 0 && frame.height === frame.list && frame.shown && frame.animations === 0),
  ).toBe(true)

  // Submitting swaps the dock for the composer with no closing flight.
  const submitted = await page.evaluate(async () => {
    const dock = () => document.querySelector('[data-component="dock-prompt"][data-kind="question"]')
    const moving = () => !!document.querySelector("[data-moving]")
    const buttons = [...dock()!.querySelectorAll<HTMLElement>('[data-slot="question-footer-actions"] button')]

    buttons.find((button) => button.textContent?.startsWith("Submit"))!.click()

    for (let i = 0; i < 120 && dock() && !moving(); i++) await new Promise((resolve) => requestAnimationFrame(resolve))
    const frames = []

    for (let i = 0; i < 3; i++) {
      frames.push({ dock: !!dock(), moving: moving(), animations: document.getAnimations().length })
      await new Promise((resolve) => requestAnimationFrame(resolve))
    }

    return frames
  })

  expect(submitted).toEqual(Array(3).fill({ dock: false, moving: false, animations: 0 }))
})

story("brings the question switch motion back with the Question dock motion knob", async ({ mount, page }) => {
  await page.addInitScript(() => localStorage.setItem("opencode.motion.v2", JSON.stringify({ "question.motion": 1 })))
  const component = await mount("app-current-session-surface--question-request")
  const question = component.locator('[data-component="dock-prompt"][data-kind="question"]')
  await expect(question.getByRole("radio", { name: /Focused/ })).toBeFocused()
  await expect(component.locator('[data-component="session-question-dock"]')).toHaveAttribute("data-animated", "true")

  const frames = await act(question, "key:ArrowRight")
  expect(frames.some((frame) => !frame.still && frame.animations > 0)).toBe(true)
})

story("stops a switch where it is when the knob turns off", async ({ mount, page }) => {
  await page.addInitScript(() => localStorage.setItem("opencode.motion.v2", JSON.stringify({ "question.motion": 1 })))
  const component = await mount("app-current-session-surface--question-request")
  const question = component.locator('[data-component="dock-prompt"][data-kind="question"]')
  await expect(question.getByRole("radio", { name: /Focused/ })).toBeFocused()

  const frames = await question.evaluate(
    async (root, tuning) => {
      const { motionTuning } = await import(tuning)
      const knob = motionTuning.list().find((item: MotionKnob) => item.id === "question.motion")
      const frame = () => new Promise((resolve) => requestAnimationFrame(resolve))

      const sample = () => ({
        animations: document.getAnimations().length,
        heights: [...root.querySelectorAll<HTMLElement>("*")].filter((el) => el.style.height).length,
      })

      document.activeElement!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }),
      )
      await frame()
      const moving = sample()
      motionTuning.set(knob, false)
      await frame()
      await frame()

      return { moving, after: sample() }
    },
    sourceURL(new URL("../../ui/src/motion-tuning.ts", import.meta.url)),
  )

  expect(frames.moving.animations).toBeGreaterThan(0)
  expect(frames.after).toEqual({ animations: 0, heights: 0 })
})
