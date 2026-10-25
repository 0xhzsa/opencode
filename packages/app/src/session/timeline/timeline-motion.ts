import { springAt, springSettle, type DurationOptions } from "@opencode/ui/motion"

type Track = { x: number; v: number }

type Row = {
  wrapper: HTMLElement
  inner: HTMLElement
  /** Where the row's clipping box is drawn, relative to the row layer and the row's resting slot. */
  box: Track
  /** Where the row's content is drawn, on the same terms. Content below the box is still to be revealed. */
  content: Track
  /** A soft edge this tall rides the box's lower edge while content is still hidden below it. */
  edge: number
  extended: boolean
  enter?: { span: number; size: number; floor: number }
}

type Follower = { key: string; element: HTMLElement; track: Track; base: number }

export type RowJump = {
  key: string
  wrapper: HTMLElement
  inner: HTMLElement
  /** How far the row's box must be drawn from its new slot, relative to the layer, for it to look unmoved. */
  box: number
  /** The same for its content; more than `box` when the row grew and the new part is still to be revealed. */
  content: number
  edge?: number
  /** The row just arrived at this height and fades in as it is revealed. */
  enter?: number
  /** The row stays in its resting slot while the rows around it move, as a send flight lands on it. */
  hold?: boolean
}

const rest = (track: Track) => Math.abs(track.x) < 0.01 && Math.abs(track.v) < 0.5
const translate = (y: number) => `translateY(${Math.round(y * 1000) / 1000}px)`
const easeOut = (t: number) => 1 - (1 - t) * (1 - t)

/**
 * Timeline motion on the compositor. Rows always sit at their final size and slot; each content change reports how far
 * every moved row jumped, and the jumps are drawn back out with transforms that spring to zero: one on the row layer for
 * the shared move, and per row a box/content pair for rows that move differently or reveal a new part. Every running
 * animation is baked again from its current offset and velocity on the same time grid, so offsets that cancel keep
 * cancelling and nothing runs JavaScript between content changes.
 */
export function createTimelineMotion(input: {
  layer: () => HTMLElement | undefined
  spring: () => DurationOptions
  timeScale: () => number
  /** The furthest the content is drawn from its slots, so the rows around the viewport can stay mounted. */
  onReach: (px: number) => void
  /** A row's box extends this far below its slot while its soft edge runs. */
  onEdge: (key: string, px: number) => void
  onSettle?: () => void
}) {
  const layer: Track = { x: 0, v: 0 }
  const rows = new Map<string, Row>()
  const followers = new Set<Follower>()
  let animations: Animation[] = []
  let epoch: { omega: number; zeta: number; clock?: Animation; at: number } | undefined

  function elapsed() {
    if (!epoch) return 0
    const time = epoch.clock?.currentTime
    const ms = typeof time === "number" ? time : performance.now() - epoch.at
    return Math.max(0, ms / 1000 / input.timeScale())
  }

  function hidden(row: Row, t: number) {
    if (!epoch) return row.content.x - row.box.x
    return (
      springAt(row.content.x, row.content.v, epoch.omega, epoch.zeta, t)[0] -
      springAt(row.box.x, row.box.v, epoch.omega, epoch.zeta, t)[0]
    )
  }

  function opacity(row: Row, t: number) {
    if (!row.enter) return 1
    return Math.max(
      row.enter.floor,
      easeOut(Math.min(1, Math.max(0, (row.enter.size - hidden(row, t)) / row.enter.span))),
    )
  }

  // Brings every track to where its running animation has drawn it.
  function advance() {
    const t = elapsed()
    const current = epoch
    if (!current || t === 0) return
    const step = (track: Track) => {
      const [x, v] = springAt(track.x, track.v, current.omega, current.zeta, t)
      track.x = x
      track.v = v
    }
    step(layer)
    rows.forEach((row) => {
      if (row.enter) row.enter.floor = opacity(row, t)
      step(row.box)
      step(row.content)
    })
    followers.forEach((follower) => step(follower.track))
  }

  function stop() {
    animations.forEach((animation) => animation.cancel())
    animations = []
  }

  function release(key: string, row: Row) {
    if (row.extended) input.onEdge(key, 0)
    rows.delete(key)
  }

  function settle() {
    stop()
    epoch = undefined
    layer.x = layer.v = 0
    rows.forEach((row, key) => release(key, row))
    followers.forEach((follower) => (follower.track = { x: 0, v: 0 }))
    input.onReach(0)
    input.onSettle?.()
  }

  function bake() {
    stop()
    rows.forEach((row, key) => {
      if (rest(row.box) && rest(row.content) && (!row.enter || row.enter.floor >= 0.995)) release(key, row)
    })
    const tracks = [
      layer,
      ...[...rows.values()].flatMap((row) => [row.box, row.content]),
      ...[...followers].map((follower) => follower.track),
    ]
    if (tracks.every(rest) && !rows.size) return settle()

    const spring = input.spring()
    const omega = (2 * Math.PI) / spring.duration
    const zeta = 1 - spring.bounce
    const settleTime = Math.max(...tracks.map((track) => springSettle(track.x, track.v, omega, zeta, 0.02)))
    const count = Math.max(2, Math.ceil(settleTime * 60))
    const times = Array.from({ length: count + 1 }, (_, index) => (settleTime * index) / count)
    const timing: KeyframeAnimationOptions = { duration: settleTime * 1000 * input.timeScale() }
    const at = (track: Track, t: number, index: number) =>
      index === count ? 0 : springAt(track.x, track.v, omega, zeta, t)[0]
    const next = { omega, zeta, at: performance.now(), clock: undefined as Animation | undefined }
    const start = document.timeline.currentTime
    epoch = next
    const animate = (element: Element, frames: Keyframe[], easing = "linear") => {
      const animation = element.animate(frames, { ...timing, easing })
      // Compositor transforms can become ready after a main-thread clip. Start them on one document clock.
      if (typeof start === "number") animation.startTime = start
      animations.push(animation)
      next.clock ??= animation
    }
    // One move from its farthest offset to rest, its spring's shape baked into the easing.
    const move = (element: Element, offsets: number[]) => {
      const far = offsets.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a), 0)
      if (far === 0) return
      animate(
        element,
        [{ transform: translate(far) }, { transform: translate(0) }],
        `linear(${offsets.map((y) => Math.round((1 - y / far) * 1e5) / 1e5).join(", ")})`,
      )
    }
    let reach = 0
    const layerElement = input.layer()

    if (layerElement && !rest(layer)) {
      const offsets = times.map((t, index) => at(layer, t, index))
      reach = Math.max(...offsets.map(Math.abs))
      move(layerElement, offsets)
    }

    rows.forEach((row, key) => {
      const reveal = (index: number, t: number) => {
        const box = at(row.box, t, index)
        const content = at(row.content, t, index)
        const edge = row.edge > 0 ? Math.min(row.edge, Math.max(0, content - box)) : 0
        return { box: box - edge, inner: content - box + edge, edge }
      }
      const poses = times.map((t, index) => reveal(index, t))
      if (row.edge > 0 && row.content.x - row.box.x > 0.5 && !row.extended) {
        row.extended = true
        input.onEdge(key, row.edge)
      }
      // The box keeps its full reach while the edge narrows onto the last of the reveal, so clip what reaches past it.
      const tails = poses.map((pose) => (row.extended ? row.edge - pose.edge : 0))
      if (row.wrapper.isConnected && tails.some((tail) => tail > 0.01))
        animate(
          row.wrapper,
          tails.map((tail) => ({ clipPath: `inset(-1px -1px ${Math.round(tail * 1000) / 1000}px -1px)` })),
        )
      if (row.wrapper.isConnected && row.enter)
        animate(
          row.wrapper,
          poses.map((pose, index) => ({
            transform: translate(pose.box),
            opacity: index === count ? 1 : opacity(row, times[index]!),
          })),
        )
      if (row.wrapper.isConnected && !row.enter && poses.some((pose) => Math.abs(pose.box) > 0.01))
        move(
          row.wrapper,
          poses.map((pose) => pose.box),
        )
      if (row.inner.isConnected && poses.some((pose) => Math.abs(pose.inner) > 0.01))
        move(
          row.inner,
          poses.map((pose) => pose.inner),
        )
    })

    followers.forEach((follower) => {
      follower.element.style.translate = follower.base ? `0 ${follower.base}px` : ""
      if (!rest(follower.track))
        move(
          follower.element,
          times.map((t, index) => at(follower.track, t, index)),
        )
    })

    input.onReach(reach)
    void next.clock?.finished.then(
      () => epoch === next && settle(),
      () => {},
    )
    if (!next.clock) settle()
  }

  function offset(key: string) {
    const t = elapsed()
    const row = rows.get(key)
    const sum = (track: Track) =>
      epoch ? springAt(track.x, track.v, epoch.omega, epoch.zeta, t) : ([track.x, track.v] as const)
    const [lx, lv] = sum(layer)
    const [cx, cv] = row ? sum(row.content) : [0, 0]
    return { x: lx + cx, v: lv + cv }
  }

  return {
    moving: () => epoch !== undefined,
    /**
     * A content change moved the layer's rows `layer` px on screen from where they were drawn, and `jumps` moved by
     * different amounts. Each `jump` is relative to the layer's.
     */
    kick(layerJump: number, jumps: RowJump[]) {
      advance()
      layer.x += layerJump
      jumps.forEach((jump) => {
        const row = rows.get(jump.key) ?? {
          wrapper: jump.wrapper,
          inner: jump.inner,
          box: { x: 0, v: 0 },
          content: { x: 0, v: 0 },
          edge: 0,
          extended: false,
        }
        row.wrapper = jump.wrapper
        row.inner = jump.inner
        if (jump.hold) {
          row.box = { x: -layer.x, v: -layer.v }
          row.content = { x: -layer.x, v: -layer.v }
        } else {
          row.box.x += jump.box
          row.content.x += jump.content
        }
        // The box already reaches its edge below its slot; a new edge mid-reveal would move the revealed bottom.
        if (jump.edge !== undefined && !row.extended) row.edge = jump.edge
        if (jump.enter !== undefined)
          row.enter = { span: Math.min(28, Math.max(12, jump.enter)), size: jump.enter, floor: 0 }
        rows.set(jump.key, row)
      })
      followers.forEach((follower) => {
        const jump = layerJump + (jumps.find((item) => item.key === follower.key)?.content ?? 0)
        follower.track.x += jump
        follower.base -= jump
      })
      bake()
    },
    /** Where row `key`'s content is drawn relative to its resting slot, now. */
    offset,
    /**
     * Moves `element` with row `key`'s content from now on, so something drawn over the row stays on it. `offset` is
     * how far the row is drawn from its resting slot as it starts.
     */
    follow(key: string, element: HTMLElement) {
      const start = offset(key)
      advance()
      const follower: Follower = { key, element, track: { x: start.x, v: start.v }, base: 0 }
      followers.add(follower)
      if (epoch) bake()
      return {
        offset: start.x,
        stop: () => {
          followers.delete(follower)
          element.style.translate = ""
        },
      }
    },
    /** Exit owns opacity while the row keeps its current motion. */
    leave(key: string) {
      const row = rows.get(key)
      if (!row?.enter) return
      advance()
      row.enter = undefined
      bake()
    },
    /** The row left the layer; it takes its motion with it. */
    drop(key: string) {
      const row = rows.get(key)
      if (row) release(key, row)
    },
    /** Lands everything where it rests, at once. */
    cancel() {
      if (epoch || rows.size) settle()
    },
  }
}
