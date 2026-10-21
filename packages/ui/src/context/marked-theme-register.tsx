import { registerCustomTheme } from "@pierre/diffs"
import { OpenCodeHighlightsTheme, OpenCodeTheme } from "./marked-theme"

let registered = false

export function registerOpenCodeTheme() {
  if (registered) return
  registered = true
  registerCustomTheme("OpenCode", () => Promise.resolve(OpenCodeTheme))
  registerCustomTheme("OpenCode", () => Promise.resolve(OpenCodeHighlightsTheme), "zed")
}
