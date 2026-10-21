import { For, onMount } from "solid-js"
import "./css-agent-orb.css"

// Same 37 fixed centres as iOS. The generated CSS retains each dot's sampled size and two light curves.
const dots = Array.from({ length: 49 }, (_, i) => ({ x: (i % 7) - 3, y: Math.floor(i / 7) - 3 })).filter(
  ({ x, y }) => Math.hypot(x, y) <= 3.5,
)

export function CssAgentOrb() {
  let root!: HTMLSpanElement
  // Shared document clock, read once at mount. With syncSpinPhase, use its ref and remove --orb-clock.
  onMount(() => root.style.setProperty("--orb-clock", `${-(Number(document.timeline.currentTime) % 900)}ms`))
  return (
    <span ref={root} data-component="css-agent-orb" aria-hidden="true">
      <For each={dots}>{(dot) => <span style={{ left: `${8 + dot.x * 2}px`, top: `${8 + dot.y * 2}px` }} />}</For>
    </span>
  )
}
