import { createEffect, untrack, type Accessor } from "solid-js"
import type { Data } from "./data"

/** Messages a retained but hidden transcript keeps; older ones page back in from the server. */
export const transcriptTail = 40
/** Estimated bytes of hidden retained transcripts before the least recently viewed families are evicted. */
export const transcriptBudget = 50_000_000

export function createSessionRetention(input: {
  session: Pick<Data["session"], "list" | "root" | "evict" | "active"> & {
    message: Pick<Data["session"]["message"], "list" | "trim" | "size">
  }
  current: Accessor<string | undefined>
  keep: Accessor<readonly string[]>
  limit: number
  tail?: number
  budget?: number
}) {
  const tail = input.tail ?? transcriptTail
  const budget = input.budget ?? transcriptBudget
  let previous: string | undefined
  let recent: string[] = []
  // What retention last did to each session and the message count it left; a new count means events refilled it.
  let settled = new Map<string, string>()
  let sizes = new Map<string, { count: number; bytes: number }>()

  createEffect(() => {
    const viewed = input.current()
    const current = viewed === undefined ? undefined : input.session.root(viewed)
    const keep = new Set(input.keep().map((id) => input.session.root(id)))
    // Resolve again when metadata arrives, but only navigation advances recency.
    recent = [
      ...new Set([
        ...(viewed !== previous && current !== undefined ? [current] : []),
        ...recent.map((id) => input.session.root(id)),
      ]),
    ]
    previous = viewed
    const retained = new Set([...keep, ...recent.filter((id) => !keep.has(id)).slice(0, input.limit)])
    if (current !== undefined) retained.add(current)
    recent = recent.filter((id) => retained.has(id))

    // A running transcript stays whole until it settles.
    const running = new Set(input.session.active())
    const sessions = input.session.list().map((session) => ({
      id: session.id,
      root: input.session.root(session.id),
      full: session.id === viewed || running.has(session.id),
    }))

    untrack(() => {
      const count = (id: string) => input.session.message.list(id).length
      const changed = (id: string, state: string) => settled.get(id) !== `${state}:${count(id)}`
      const excluded = sessions.filter((session) => !retained.has(session.root))
      const hidden = sessions.filter((session) => retained.has(session.root) && !session.full)

      // Families outside the retained set are evicted, as are new descendants and transcripts refilled by background turns.
      new Set(
        excluded.flatMap((session) => (changed(session.id, `evict:${session.root}`) ? [session.root] : [])),
      ).forEach((root) => input.session.evict(root))
      // Hidden retained transcripts keep their tail, and are trimmed again whenever events grow them.
      hidden.forEach((session) => {
        if (changed(session.id, "tail")) input.session.message.trim(session.id, tail)
      })

      // Spend the budget on the most recently viewed families; the rest are evicted.
      const size = (id: string) => {
        const messages = count(id)
        const cached = sizes.get(id)
        if (cached?.count === messages) return cached.bytes
        const bytes = input.session.message.size(id)
        sizes.set(id, { count: messages, bytes })
        return bytes
      }
      const order = [...new Set([...recent, ...keep])].filter((root) => root !== current)
      let total = 0
      for (const root of order) {
        const members = sessions.filter((session) => session.root === root)
        const bytes = members.reduce((sum, session) => sum + size(session.id), 0)
        total += bytes
        if (total > budget && bytes > 0) input.session.evict(root)
      }

      settled = new Map([
        ...excluded.map((session) => [session.id, `evict:${session.root}:${count(session.id)}`] as const),
        ...hidden.map((session) => [session.id, `tail:${count(session.id)}`] as const),
      ])
      const ids = new Set(sessions.map((session) => session.id))
      sizes = new Map([...sizes].filter(([id]) => ids.has(id)))
    })
  })
}
