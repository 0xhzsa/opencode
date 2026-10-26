import { createEffect, untrack, type Accessor } from "solid-js"

/**
 * Asks whether a link's file exists only while its timeline is selected. Extensions check links for the selected
 * session alone, so a hidden timeline's answer would be a false negative: a check asked while hidden, or one that
 * comes back negative after the timeline was hidden, waits and asks again once it is selected.
 */
export function createLinkCheck(active: Accessor<boolean>, check: (href: string) => boolean | Promise<boolean>) {
  let waiting: (() => void)[] = []

  createEffect(() => {
    if (!active()) return
    const ready = waiting
    waiting = []
    ready.forEach((resolve) => resolve())
  })

  const exists = (href: string): boolean | Promise<boolean> => {
    if (!untrack(active)) return new Promise<void>((resolve) => waiting.push(resolve)).then(() => exists(href))
    const result = untrack(() => check(href))

    if (result === true || result === false) return result

    return result.then((found) => (found || untrack(active) ? found : exists(href)))
  }

  return exists
}
