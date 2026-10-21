import { createSignal } from "solid-js"
import { motionTuning } from "@opencode/ui/motion-tuning"

export type CodeHighlighter = "shiki" | "highlights"

// Experiment: Pierre Highlights (WebAssembly lexers) in place of Shiki for review diffs and markdown code blocks.
const choice = motionTuning.choice("code.highlighter", {
  label: "Code highlighter",
  group: "Experiments",
  value: "shiki",
  labels: { shiki: "Shiki", highlights: "Highlights" },
})

const [highlighter, setHighlighter] = createSignal<CodeHighlighter>(choice())

motionTuning.subscribe(() => setHighlighter(choice()))

/** The highlighter picked in Knobs → Experiments. Reactive, so open diffs rebuild on the new pool when it changes. */
export const codeHighlighter = highlighter
