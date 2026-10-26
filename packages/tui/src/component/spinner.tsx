import { createEffect, createSignal, onCleanup, Show } from "solid-js"
import { useTheme } from "../context/theme"
import { useConfig } from "../config"
import type { JSX } from "@opentui/solid"
import type { RGBA } from "@opentui/core"
import "./spinner-renderable"
import { SPINNER_FRAMES } from "./spinner-frames"
import { ShimmerText } from "./shimmer-text"
import { schedule, unschedule, type AnimationTask } from "../ui/animation"

export { SPINNER_FRAMES } from "./spinner-frames"

const FRAME_MS = 80
const [tick, setTick] = createSignal(0)
const advance: AnimationTask = (now) => {
  setTick(Math.floor(now / FRAME_MS))
  return true
}
let subscribers = 0

function subscribe() {
  if (subscribers++ === 0) {
    advance(performance.now())
    schedule(advance)
  }
  onCleanup(() => {
    if (--subscribers === 0) unschedule(advance)
  })
}

export function Spinner(props: { children?: JSX.Element; color?: RGBA; shimmer?: RGBA }) {
  const theme = useTheme()
  const config = useConfig().data
  const color = () => props.color ?? theme.text.muted
  createEffect(() => {
    if (!(config.animations ?? true) || !props.shimmer) return
    subscribe()
  })
  // A bare spinner beside a long sibling shrinks to a fractional width that rounds to 0, so the
  // glyph paints on top of the row gap. Only a labeled spinner may shrink (to wrap its text).
  return (
    <Show
      when={config.animations ?? true}
      fallback={<text fg={color()}>{props.children ? <>⋯ {props.children}</> : "⋯"}</text>}
    >
      <Show
        when={props.shimmer}
        fallback={
          <box flexDirection="row" gap={1} flexShrink={props.children ? 1 : 0}>
            <box flexShrink={0}>
              <spinner frames={SPINNER_FRAMES} interval={80} color={color()} />
            </box>
            <Show when={props.children}>
              <text fg={color()}>{props.children}</text>
            </Show>
          </box>
        }
      >
        {(shimmer) => (
          <ShimmerText fg={color()} shimmer={shimmer()}>
            {SPINNER_FRAMES[tick() % SPINNER_FRAMES.length]} {props.children}
          </ShimmerText>
        )}
      </Show>
    </Show>
  )
}
