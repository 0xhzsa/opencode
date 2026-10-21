import { For, onMount } from "solid-js"
import "./css-agent-orb.css"

// iOS: 37 dots on a 7×7 disc; a meridian tilted 0.45rad crosses each dot twice per 1.8s rotation.
const dots = Array.from({ length: 49 }, (_, i) => ({ x: (i % 7) - 3, y: Math.floor(i / 7) - 3 }))
  .filter(({ x, y }) => Math.hypot(x, y) <= 3.5)
  .map(({ x, y }) => ({
    x: 7.2 + x * 2,
    y: 7.2 + y * 2,
    phase:
      (Math.atan2(x, Math.sqrt(3.6 ** 2 - x * x - y * y) * Math.cos(0.45) - y * Math.sin(0.45)) / Math.PI + 1) * 900,
  }))

export function CssAgentOrb() {
  let root!: HTMLSpanElement
  // Shared document clock, read once at mount. With syncSpinPhase, use its ref and remove --orb-clock.
  onMount(() => root.style.setProperty("--orb-clock", `${-(Number(document.timeline.currentTime) % 900)}ms`))
  return (
    <span ref={root} data-component="css-agent-orb" aria-hidden="true">
      <For each={dots}>
        {(dot) => <span style={{ left: `${dot.x}px`, top: `${dot.y}px`, "--orb-phase": `${-dot.phase}ms` }} />}
      </For>
    </span>
  )
}
