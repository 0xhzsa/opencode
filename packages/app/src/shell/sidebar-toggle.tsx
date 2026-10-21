import { Show } from "solid-js"
import { createMediaQuery } from "@solid-primitives/media"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Keybind } from "@opencode/ui/keybind"
import { Tooltip } from "@opencode/ui/tooltip"
import { useCommand } from "@/shell/commands/command"
import { useLanguage } from "@/runtime/i18n/language"
import { usePlatform } from "@/runtime/platform/platform"
import { useSettings } from "@/settings/model"

// The desktop window sets `trafficLightPosition: { x: 14, y: 14 }`, and the titlebar moves the buttons down to share the
// header's center line in vertical tabs. macOS 26 and later draw 14px buttons on a 23px pitch, so the zoom button ends
// 74px from the window edge. macOS 15 and earlier end at 68px.
export const macTrafficLightsBaseWidth = 74

// Vertical tabs center the 14pt traffic lights on the session header's center line, 32px from the top, and inset them as
// far from the left edge as from the top. The center scales with zoom. Returns window points; `width` is where the zoom
// button ends.
export function macVerticalTrafficLights(zoom: number) {
  const inset = 32 * zoom - 7

  return { x: inset, y: inset, width: inset + macTrafficLightsBaseWidth - 14 }
}

// Matches the horizontal titlebar, whose first control starts 16px past the traffic lights.
const macTrafficLightsGap = 16

// The toggle's 28px plus a 4px gap before the header contents.
const slotWidth = 32

// The shell's 8px inline inset plus the session header's 10px start padding.
const contentStart = 18

export function SidebarToggle() {
  const command = useCommand()
  const language = useLanguage()
  const settings = useSettings()
  const keybind = () => command.keybindParts("sidebar.toggle")

  return (
    <Tooltip
      class="shrink-0 [app-region:no-drag]"
      placement="bottom"
      value={
        <>
          {language.t("command.sidebar.toggle")}
          <Show when={keybind().length > 0}>
            <Keybind keys={keybind()} variant="neutral" />
          </Show>
        </>
      }
    >
      <IconButton
        type="button"
        variant="ghost-muted"
        size="large"
        class="shrink-0"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => settings.appearance.setSidebarOpen(!settings.appearance.sidebarOpen())}
        aria-label={language.t("command.sidebar.toggle")}
        aria-expanded={settings.appearance.sidebarOpen()}
        aria-controls="vertical-tabs-sidebar"
        icon={<Icon name={settings.appearance.sidebarOpen() ? "layout-left-full" : "layout-left"} />}
      />
    </Tooltip>
  )
}

// Where the collapsed sidebar's toggle sits at the start of the content area. Windows keeps its titlebar in vertical
// tabs mode, so the toggle lives there instead.
function useCollapsedSlot() {
  const platform = usePlatform()
  const settings = useSettings()
  const desktop = createMediaQuery("(min-width: 768px)")
  const windows = () => platform.platform === "desktop" && platform.os === "windows"
  const mac = () => platform.platform === "desktop" && platform.os === "macos" && !platform.windowFullscreen?.()

  return {
    visible: () => desktop() && !windows() && settings.appearance.tabLayout() !== "horizontal",
    open: settings.appearance.sidebarOpen,
    // Lays the toggle out as if the traffic lights were the header's first control.
    width: () =>
      mac()
        ? macVerticalTrafficLights(platform.webviewZoom?.() ?? 1).width / (platform.webviewZoom?.() ?? 1) +
          macTrafficLightsGap -
          contentStart +
          slotWidth
        : slotWidth,
  }
}

const slotClass = "flex shrink-0 justify-end overflow-hidden"

// Floats over the top of every screen, centered on the session header's 48px row. Appears at the content's start edge
// when the sidebar closes.
export function CollapsedSidebarToggle() {
  const slot = useCollapsedSlot()

  return (
    <Show when={slot.visible()}>
      <div
        data-slot="collapsed-sidebar-toggle"
        class={`absolute top-[calc(var(--shell-top-inset,8px)+10px)] start-[calc(var(--shell-inline-inset,8px)+10px)] z-40 ${slotClass}`}
        style={{ width: slot.open() ? "0px" : `${slot.width()}px` }}
        inert={slot.open()}
      >
        <div class="flex shrink-0 pe-1">
          <SidebarToggle />
        </div>
      </div>
    </Show>
  )
}

// Reserves the floating toggle's room in a header, pushing its contents along while the toggle is shown. `start` is where
// the space begins, in pixels from the content area's start edge, so every header's contents line up after the toggle.
export function CollapsedSidebarToggleSpace(props: { start?: number; class?: string }) {
  const slot = useCollapsedSlot()

  return (
    <Show when={slot.visible()}>
      <div
        aria-hidden="true"
        class={`${slotClass} ${props.class ?? ""}`}
        style={{ width: slot.open() ? "0px" : `${slot.width() + contentStart - (props.start ?? contentStart)}px` }}
      />
    </Show>
  )
}
