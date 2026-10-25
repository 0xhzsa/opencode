import { createSignal } from "solid-js"
import { SESSION_PANEL_WIDTH_FIT } from "@/session/session-panel-width"

// How a narrow desktop window shares its width. Panes yield in order rather than switching to the mobile layout: the
// side panel shrinks to its minimum, then the open left sidebar hides and floats when called, then the side panel
// becomes a sheet over the chat. None of it changes the saved preferences.

/** The narrowest the routed screen's content goes before the open sidebar gives way to it, published by the screen. */
export const [contentMinimum, setContentMinimum] = createSignal(SESSION_PANEL_WIDTH_FIT)

/** The width the routed screen's content gets once the sidebar's motion lands, published by the shell. */
export const [contentRoom, setContentRoom] = createSignal<number>()

/** Whether the window is too narrow to dock the left sidebar, which then floats when called; published by the shell. */
export const [sidebarAutoHidden, setSidebarAutoHidden] = createSignal(false)

/** How far a width must cross a threshold back before the layout gives way again, so a resize doesn't flap at it. */
export const roomHysteresis = 16
