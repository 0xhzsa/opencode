import { createStore } from "solid-js/store"

/** Client-only source coordinates; never included in persisted drafts or requests. */
export type QuoteSource = {
  partID: string
  revealID: string
  body?: string
  shadow?: { host: number; line: string }
  start: number
  end: number
  text: string
}[]

export function createComposerQuoteSource() {
  const [state, setState] = createStore<{
    sources: Record<string, QuoteSource | undefined>
    hovered?: string
    focused?: string
    /** The quote being commented for the first time, the only one whose source stays highlighted. */
    pending?: string
    reveal?: { key: string; sequence: number }
  }>({ sources: {} })

  return {
    state,
    add: (key: string, source: QuoteSource) => setState("sources", key, source),
    pend: (key: string) => setState("pending", key),
    settle: () => setState("pending", undefined),
    retain: (keys: string[]) => {
      Object.keys(state.sources).forEach((key) => {
        if (!keys.includes(key)) setState("sources", key, undefined)
      })

      if (state.pending && !keys.includes(state.pending)) setState("pending", undefined)

      if (state.hovered && !keys.includes(state.hovered)) setState("hovered", undefined)

      if (state.focused && !keys.includes(state.focused)) setState("focused", undefined)
    },
    hover: (key: string, active: boolean) => {
      if (active || state.hovered === key) setState("hovered", active ? key : undefined)
    },
    focus: (key: string, active: boolean) => {
      if (active || state.focused === key) setState("focused", active ? key : undefined)
    },
    reveal: (key: string) => setState("reveal", { key, sequence: (state.reveal?.sequence ?? 0) + 1 }),
  }
}
