// The same code in every language the highlighter comparison covers, in the order the stills show them.
export const samples = [
  {
    lang: "ts",
    code: `import { Effect, Schema } from "effect"
import type { Session } from "./session"

/** A session row as the sidebar shows it. */
export interface Row {
  readonly id: string
  readonly title: string
  readonly updated: number
}

const Title = Schema.String.pipe(Schema.minLength(1))

export class SessionStore {
  #rows = new Map<string, Row>()

  constructor(private readonly limit = 200) {}

  upsert(session: Session): Row | undefined {
    if (this.#rows.size >= this.limit) return undefined
    const row = { id: session.id, title: session.title ?? "Untitled", updated: Date.now() }
    this.#rows.set(row.id, row)
    return row
  }
}

export const load = Effect.fn("load")(function* (id: string) {
  const title = yield* Schema.decodeUnknown(Title)(\`session \${id}\`)
  const pattern = /^ses_[a-z0-9]{26}$/i
  return pattern.test(id) ? { id, title, ok: true as const } : null
})
`,
  },
  {
    lang: "tsx",
    code: `import { For, Show, createMemo, createSignal } from "solid-js"
import type { Row } from "./store"

type Props = { rows: Row[]; onSelect?: (id: string) => void }

export function SessionList(props: Props) {
  const [query, setQuery] = createSignal("")
  const visible = createMemo(() => props.rows.filter((row) => row.title.includes(query())))

  return (
    <section class="session-list" aria-label="Sessions" data-count={visible().length}>
      <input value={query()} onInput={(event) => setQuery(event.currentTarget.value)} />
      <Show when={visible().length > 0} fallback={<p>No sessions</p>}>
        <ul>
          <For each={visible()}>
            {(row) => (
              <li onClick={() => props.onSelect?.(row.id)} title={\`Updated \${row.updated}\`}>
                <strong>{row.title}</strong> &mdash; {row.id.slice(0, 8)}
              </li>
            )}
          </For>
        </ul>
      </Show>
    </section>
  )
}
`,
  },
  {
    lang: "python",
    code: `from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Iterable


@dataclass(frozen=True)
class Row:
    id: str
    title: str
    tags: list[str] = field(default_factory=list)


class SessionStore:
    """Keeps the most recent sessions in memory."""

    def __init__(self, limit: int = 200) -> None:
        self._rows: dict[str, Row] = {}
        self.limit = limit

    def upsert(self, row: Row) -> Row | None:
        if len(self._rows) >= self.limit:
            return None
        self._rows[row.id] = row
        return row


async def load(ids: Iterable[str]) -> list[Row]:
    rows = [Row(id=i, title=f"session {i!r}", tags=["recent"]) for i in ids if i.startswith("ses_")]
    await asyncio.sleep(0.01)  # yield to the loop
    return sorted(rows, key=lambda row: row.title)
`,
  },
  {
    lang: "go",
    code: `package store

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"
)

// Row is a session as the sidebar shows it.
type Row struct {
	ID      string    \`json:"id"\`
	Title   string    \`json:"title"\`
	Updated time.Time \`json:"updated"\`
}

var ErrFull = errors.New("store is full")

type Store struct {
	mu    sync.Mutex
	rows  map[string]Row
	limit int
}

func (s *Store) Upsert(ctx context.Context, row Row) (Row, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.rows) >= s.limit {
		return Row{}, fmt.Errorf("upsert %q: %w", row.ID, ErrFull)
	}
	s.rows[row.ID] = row
	return row, ctx.Err()
}
`,
  },
  {
    lang: "css",
    code: `@import url("./tokens.css");

:root {
  --row-height: 32px;
  --row-radius: 6px;
}

.session-list > ul {
  display: grid;
  gap: 2px;
  margin: 0;
  padding: 0 4px;
}

.session-list li[data-active="true"],
.session-list li:hover {
  background-color: color-mix(in srgb, var(--surface-raised) 80%, transparent);
  border-radius: var(--row-radius);
}

#composer::placeholder {
  color: rgba(120, 120, 128, 0.6);
  font: 500 13px/20px "Inter", sans-serif !important;
}

@media (prefers-reduced-motion: reduce) {
  .session-list * {
    transition: none;
  }
}
`,
  },
  {
    lang: "json",
    code: `{
  "$schema": "https://opencode.ai/config.json",
  "model": "anthropic/claude-sonnet-4-5",
  "theme": "opencode",
  "autoupdate": true,
  "share": null,
  "limits": { "context": 200000, "output": 32000, "ratio": 0.75 },
  "agent": {
    "build": {
      "temperature": 0.2,
      "tools": ["read", "edit", "bash"],
      "permission": { "bash": "ask", "edit": "allow" }
    }
  },
  "mcp": {
    "github": {
      "type": "remote",
      "url": "https://api.githubcopilot.com/mcp/",
      "enabled": false
    }
  }
}
`,
  },
  {
    lang: "bash",
    code: `#!/usr/bin/env bash
set -euo pipefail

# Build every package that changed since the base branch.
base="\${1:-origin/beta}"
root="$(git rev-parse --show-toplevel)"

changed=$(git diff --name-only "$base"... -- packages | cut -d/ -f2 | sort -u)

for pkg in $changed; do
  if [[ -f "$root/packages/$pkg/package.json" ]]; then
    echo "building $pkg"
    (cd "$root/packages/$pkg" && bun run build) || exit 1
  fi
done

export NODE_ENV=production
count=$(echo "$changed" | wc -l | tr -d ' ')
printf 'built %d packages in %ss\\n' "$count" "$SECONDS" >&2
`,
  },
  {
    lang: "diff",
    code: `diff --git a/src/store.ts b/src/store.ts
index 3f2a1c0..9b8e7d4 100644
--- a/src/store.ts
+++ b/src/store.ts
@@ -12,9 +12,11 @@ export class SessionStore {
   #rows = new Map<string, Row>()

-  constructor(private readonly limit = 100) {}
+  constructor(private readonly limit = 200) {}

   upsert(session: Session): Row | undefined {
-    if (this.#rows.size > this.limit) return
+    if (this.#rows.size >= this.limit) return undefined
+    // Keep the newest title.
     const row = { id: session.id, title: session.title ?? "Untitled", updated: Date.now() }
     this.#rows.set(row.id, row)
     return row
`,
  },
] as const

export function sampleReply(repeat: number, marker: string) {
  const blocks = Array.from({ length: repeat }, (_, round) =>
    samples
      .map(
        (sample) =>
          `### ${sample.lang} ${round + 1}\n\nThe ${sample.lang} sample.\n\n\`\`\`${sample.lang}\n${sample.code}\`\`\``,
      )
      .join("\n\n"),
  )

  return `\n\n## Code review\n\n${blocks.join("\n\n")}\n\nDone: ${marker}`
}

/** A TypeScript file of about `bytes` characters, built from the TS sample with numbered identifiers. */
export function largeSource(bytes: number) {
  const unit = samples[0].code
  const count = Math.floor(bytes / (unit.length + 40))

  return Array.from(
    { length: count },
    (_, index) =>
      `// section ${index}\n${unit.replaceAll("SessionStore", `SessionStore${index}`).replaceAll("load", `load${index}`)}`,
  ).join("\n")
}
