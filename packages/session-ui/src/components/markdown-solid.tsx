import { For, onMount } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { Dynamic, render } from "solid-js/web"

type MarkdownNode =
  | {
      key: string
      type: "element"
      tag: string
      attributes: Record<string, string>
      children: MarkdownNode[]
      animate?: true
    }
  | { key: string; type: "text"; text: string }
  | { key: string; type: "word"; text: string; animate?: true }

export function createMarkdownRenderer(root: HTMLDivElement, html: string, words: boolean, animate = false) {
  const [nodes, setNodes] = createStore(parseMarkdownNodes(html, words, animate))
  let ready = animate
  let frontier = 0

  const delay = () => {
    const now = typeof performance === "object" ? performance.now() : 0
    const scale =
      typeof document !== "undefined"
        ? Number(document.documentElement?.style.getPropertyValue("--motion-time-scale")) || 1
        : 1
    const step = 20 * scale
    const maxLead = 120 * scale
    const base = Math.min(now + maxLead, Math.max(now, frontier))
    frontier = base + step
    return Math.max(0, Math.round((base - now) / 16) * 16)
  }

  const dispose = render(
    () => <For each={nodes}>{(node) => <MarkdownDomNode node={node} animate={() => ready} delay={delay} />}</For>,
    root,
  )

  ready = true

  return {
    update(next: string, nextWords: boolean, animate = true) {
      setNodes(reconcile(parseMarkdownNodes(next, nextWords, animate), { key: "key" }))
    },
    dispose,
  }
}

function MarkdownDomNode(props: { node: MarkdownNode; animate: () => boolean; delay: () => number }) {
  const node = props.node

  if (node.type === "text") return node.text

  if (node.type === "word") {
    let ref: HTMLSpanElement | undefined
    onMount(() => {
      if (props.animate() && node.animate && ref) {
        const wait = props.delay()
        if (wait > 0) ref.style.setProperty("--markdown-word-delay", `${wait}ms`)
        ref.setAttribute("data-markdown-enter", "")
      }
    })

    return (
      <span
        ref={ref}
        data-markdown-word=""
        onAnimationEnd={(event) => {
          event.currentTarget.removeAttribute("data-markdown-enter")
          event.currentTarget.style.removeProperty("--markdown-word-delay")
        }}
      >
        {node.text}
      </span>
    )
  }

  let ref: HTMLElement | undefined
  onMount(() => {
    if (props.animate() && node.animate) ref?.setAttribute("data-markdown-enter", "")
  })

  return (
    <Dynamic component={node.tag} ref={ref} {...node.attributes}>
      <For each={node.children}>
        {(node) => <MarkdownDomNode node={node} animate={props.animate} delay={props.delay} />}
      </For>
    </Dynamic>
  )
}

export function parseMarkdownNodes(html: string, words: boolean, animate = false) {
  const template = document.createElement("template")
  template.innerHTML = html

  return Array.from(template.content.childNodes).flatMap((node, index) => parseNode(node, `${index}`, words, animate))
}

function parseNode(node: Node, key: string, words: boolean, animate: boolean, inlineCode = false): MarkdownNode[] {
  if (node instanceof Text) {
    if (!words) return [{ key, type: "text", text: node.data }]

    return (inlineCode ? Array.from(node.data) : node.data.split(/(\s+)/)).flatMap((text, index): MarkdownNode[] => {
      if (!text) return []

      if (/^\s+$/.test(text)) return [{ key: `${key}:${index}`, type: "text", text }]

      return [{ key: `${key}:${index}`, type: "word", text, ...(animate ? { animate: true as const } : {}) }]
    })
  }

  if (!(node instanceof Element)) return []

  return [
    {
      key,
      type: "element",
      tag: node.tagName.toLowerCase(),
      attributes: Object.fromEntries(Array.from(node.attributes).map((attribute) => [attribute.name, attribute.value])),
      children: Array.from(node.childNodes).flatMap((child, index) =>
        parseNode(
          child,
          `${key}.${index}`,
          words,
          animate,
          inlineCode || (node.tagName === "CODE" && node.parentElement?.tagName !== "PRE"),
        ),
      ),
      ...(words && animate && node.tagName === "CODE" && node.parentElement?.tagName !== "PRE"
        ? { animate: true as const }
        : {}),
    },
  ]
}
