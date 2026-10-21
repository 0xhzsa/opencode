import { For } from "solid-js"
import { render } from "solid-js/web"
import { AgentOrb } from "./agent-orb"
import { CssAgentOrb } from "./css-agent-orb"
import "../../../../ui/src/styles/tokens/theme.css"
import "../../../../ui/src/styles/tokens/colors.css"

// A proof clock outside production: drive the real renderer and CSS at identical timestamps, even on a busy worker.
const jobs = new Map<number, FrameRequestCallback>()
let id = 0
window.requestAnimationFrame = (callback) => {
  jobs.set(++id, callback)
  return id
}
window.cancelAnimationFrame = (key) => {
  jobs.delete(key)
}
const advance = (time: number) => {
  const next = [...jobs.values()]
  jobs.clear()
  next.forEach((job) => job(time))
}

render(
  () => (
    <main
      style={{ "font-family": "var(--font-family-sans, sans-serif)", margin: "0", color: "var(--v2-text-text-base)" }}
    >
      <For each={["light", "dark"]}>
        {(scheme) => (
          <section
            data-color-scheme={scheme}
            style={{ background: "var(--v2-background-bg-base)", padding: "24px 36px" }}
          >
            <div style={{ color: "var(--v2-text-text-base)", "font-size": "18px", "margin-bottom": "24px" }}>
              {scheme === "light" ? "Light" : "Dark"} · 900ms loop
            </div>
            <div style={{ display: "grid", "grid-template-columns": "repeat(3, 1fr)", gap: "36px" }}>
              <For each={["JS reference", "CSS · matched ink", "CSS · legible"]}>
                {(label, index) => (
                  <div>
                    <div style={{ color: "var(--v2-text-text-muted)", "font-size": "15px", "margin-bottom": "24px" }}>
                      {label}
                    </div>
                    <div data-orb-proof={index()} style={{ height: "160px" }}>
                      <div
                        style={{
                          zoom: 8,
                          "--orb-dot-size": index() === 1 ? "1.68px" : undefined,
                          "--orb-ink": index() === 1 ? "var(--v2-icon-icon-muted)" : undefined,
                        }}
                      >
                        {index() === 0 ? <AgentOrb activity="thinking" /> : <CssAgentOrb />}
                      </div>
                    </div>
                  </div>
                )}
              </For>
            </div>
            <div
              style={{
                display: "flex",
                "align-items": "center",
                gap: "20px",
                color: "var(--v2-text-text-base)",
                "font-size": "13px",
              }}
            >
              <span>16px, actual size</span>
              <For each={[1, 3, 12]}>
                {(count) => (
                  <span style={{ display: "inline-flex", "align-items": "center", gap: "6px" }}>
                    <CssAgentOrb />
                    {count} subagents
                  </span>
                )}
              </For>
            </div>
          </section>
        )}
      </For>
      <footer style={{ padding: "16px 36px", background: "#151515", color: "#ddd", "font-size": "14px" }}>
        <span id="clock">0.000s</span> · Frame-stepped 60Hz · CSS uses the sampled size, base and core curves
      </footer>
    </main>
  ),
  document.getElementById("root")!,
)

export function warm() {
  for (let i = 1; i <= 108; i++) advance((i * 1000) / 60)
  document
    .querySelectorAll<HTMLElement>('[data-component="css-agent-orb"]')
    .forEach((orb) => orb.style.setProperty("--orb-clock", "0ms"))
  document.getAnimations().forEach((animation) => animation.pause())
}

export function step(time: number) {
  if (time > 0) advance(1800 + time)
  document.querySelectorAll("section").forEach((section, index) => {
    // AgentOrb seeds 0, 1/13 radians. Align only the comparison clock, not the production component.
    section.querySelectorAll('[data-component="css-agent-orb"]').forEach((orb) => {
      orb.getAnimations({ subtree: true }).forEach((animation) => {
        animation.currentTime = time + ((index / 13) * 1800) / (2 * Math.PI)
      })
    })
  })
  document.getElementById("clock")!.textContent = `${(time / 1000).toFixed(3)}s`
}

export function errors() {
  return [...document.querySelectorAll("section")].map((section) => {
    const js = [...section.querySelectorAll<HTMLElement>('[data-slot="agent-orb-dot"]')]
    const css = [
      ...section.querySelectorAll<HTMLElement>('[data-orb-proof="1"] [data-component="css-agent-orb"] > span'),
    ]
    const dots = css.map((dot, i) => {
      const matrix = new DOMMatrix(getComputedStyle(dot).transform)
      const original = new DOMMatrix(js[i * 2].style.transform)
      const base = Math.abs(Number(getComputedStyle(dot, "::before").opacity) - Number(js[i * 2].style.opacity))
      const core = Math.abs(Number(getComputedStyle(dot, "::after").opacity) - Number(js[i * 2 + 1].style.opacity))
      return {
        dot: i,
        opacity: Math.max(base, core),
        scale: Math.abs(matrix.a - original.a),
        translate: Math.max(
          Math.abs(parseFloat(dot.style.left) - original.e - 0.84),
          Math.abs(parseFloat(dot.style.top) - original.f - 0.84),
        ),
      }
    })
    return { scheme: section.dataset.colorScheme!, dots }
  })
}

declare global {
  interface Window {
    orbMatch: { warm: typeof warm; step: typeof step; errors: typeof errors }
  }
}
window.orbMatch = { warm, step, errors }
