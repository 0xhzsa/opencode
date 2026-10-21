import "@/index.css"
import { render } from "solid-js/web"
import { DialogProvider } from "@opencode/ui/context/dialog"
import { ThemeProvider, useTheme } from "@opencode/ui/theme"
import { LanguageProvider, UiI18nBridge } from "@/runtime/i18n/language"
import { motionTuning } from "@opencode/ui/motion-tuning"
import { Experiments } from "./activity-chips.stories"

function Preview() {
  useTheme().setColorScheme("dark")

  return <Experiments.render />
}

render(
  () => (
    <ThemeProvider>
      <LanguageProvider locale="en">
        <UiI18nBridge>
          <DialogProvider>
            <Preview />
          </DialogProvider>
        </UiI18nBridge>
      </LanguageProvider>
    </ThemeProvider>
  ),
  document.getElementById("root")!,
)

function choose(mode: string, corners: string) {
  for (const [id, value] of [
    ["activity.chip", mode],
    ["activity.chip.corners", corners],
  ]) {
    const knob = motionTuning.list().find((item) => item.id === id)

    if (!knob || knob.kind !== "choice" || !knob.options.includes(value))
      throw new Error(`Invalid choice ${id}: ${value}`)

    motionTuning.set(knob, value)
  }
}

declare global {
  interface Window {
    chipExperiment: typeof choose
  }
}

window.chipExperiment = choose
