import { createEffect, untrack, type Accessor } from "solid-js"
import type { Data } from "./data"

/** Messages a retained but hidden transcript keeps; older ones page back in from the server. */
export const transcriptTail = 40
/** Estimated bytes of hidden retained transcripts before the least recently viewed families are evicted. */
export const transcriptBudget = 50_000_000

export function createSessionRetention(input: {
  session: Pick<Data["session"], "list" | "root" | "evict" | "active"> & {
    message: Pick<Data["session"]["message"], "list" | "loading" | "trim" | "size">
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
  // Trims put off while an older page loads.
  let deferred = new Set<string>()
  let sizes = new Map<string, { key: string; bytes: number }>()

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

    const list = input.session.list()
    const parents = new Map(list.map((session) => [session.id, session.parentID]))
    // The viewed session and its ancestors stay whole, since a subagent's view reads its parent's transcript.
    const viewing = new Set<string>()
    for (let id = viewed; id !== undefined && !viewing.has(id); id = parents.get(id)) viewing.add(id)
    // A running transcript stays whole until it settles, and its family is never evicted mid-turn.
    const running = new Set(input.session.active())
    const sessions = list.map((session) => ({
      id: session.id,
      root: input.session.root(session.id),
      full: viewing.has(session.id) || running.has(session.id),
    }))
    const busy = new Set(sessions.flatMap((session) => (running.has(session.id) ? [session.root] : [])))

    untrack(() => {
      const count = (id: string) => input.session.message.list(id).length
      const changed = (id: string, state: string) => settled.get(id) !== `${state}:${count(id)}`
      const excluded = sessions.filter((session) => !retained.has(session.root) && !busy.has(session.root))
      const hidden = sessions.filter((session) => retained.has(session.root) && !session.full)
      const evict = (root: string) => {
        input.session.evict(root)
        sessions.forEach((session) => {
          if (session.root === root) sizes.delete(session.id)
        })
      }

      // Families outside the retained set are evicted, as are new descendants and transcripts refilled by background turns.
      new Set(
        excluded.flatMap((session) => (changed(session.id, `evict:${session.root}`) ? [session.root] : [])),
      ).forEach(evict)
      // Hidden retained transcripts keep their tail, and are trimmed again whenever events grow them.
      deferred = new Set(
        hidden.flatMap((session) => {
          if (!changed(session.id, "tail")) return []
          sizes.delete(session.id)
          return input.session.message.trim(session.id, tail) ? [] : [session.id]
        }),
      )

      // Spend the budget on the most recently viewed idle families; the rest are evicted.
      sessions.forEach((session) => {
        if (session.full) sizes.delete(session.id)
      })
      const size = (id: string) => {
        const messages = input.session.message.list(id)
        const key = `${messages.length}:${messages[0]?.id}:${messages.at(-1)?.id}`
        const cached = sizes.get(id)
        if (cached?.key === key) return cached.bytes
        const bytes = input.session.message.size(id)
        sizes.set(id, { key, bytes })
        return bytes
      }
      const order = [...new Set([...recent, ...keep])].filter((root) => root !== current && !busy.has(root))
      let total = 0
      for (const root of order) {
        const bytes = sessions.reduce((sum, session) => (session.root === root ? sum + size(session.id) : sum), 0)
        total += bytes
        if (total > budget && bytes > 0) evict(root)
      }

      settled = new Map([
        ...excluded.map((session) => [session.id, `evict:${session.root}:${count(session.id)}`] as const),
        ...hidden.flatMap((session) =>
          deferred.has(session.id) ? [] : [[session.id, `tail:${count(session.id)}`] as const],
        ),
      ])
      const ids = new Set(sessions.map((session) => session.id))
      sizes = new Map([...sizes].filter(([id]) => ids.has(id)))
    })

    // A deferred trim runs once its page lands.
    deferred.forEach((id) => input.session.message.loading(id))
  })
}
