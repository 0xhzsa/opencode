# Code Coach MCP Server

An AI coach that watches your prompts and diffs, teaches first principles, and learns from you.

## How it works

Two steps, not one:

1. **Triage** (cheap, fast model): "Is there a real issue worth interrupting for?" Returns `{ interrupt: false }` most of the time. Silence is the default.
2. **Coach** (stronger model, only if triage says interrupt): Produces a nudge, explanation, better prompt, concept tags, and an optional quiz.

The learner profile persists across sessions. Concept tags accumulate; after 3 hits a concept is "mastered" and won't be re-taught. Depth escalates automatically.

## Setup

```bash
npm install
npm run build
```

Set your OpenRouter API key:

```bash
export OPENROUTER_API_KEY=sk-or-...
```

Optional overrides:
- `CODE_COACH_TRIAGE_MODEL` (default: `anthropic/claude-haiku-4.5`)
- `CODE_COACH_COACH_MODEL` (default: `anthropic/claude-sonnet-4.5`)

## Run as MCP server

```bash
node dist/index.js
```

Add to your MCP client config (Cursor, Claude Code, etc.):

```json
{
  "mcpServers": {
    "code-coach": {
      "command": "node",
      "args": ["/path/to/code-coach-mcp/dist/index.js"],
      "env": { "OPENROUTER_API_KEY": "sk-or-..." }
    }
  }
}
```

## Tools

- **coach** — `{ prompt, diff? }` → `{ interrupt, severity?, nudge?, explanation?, better_prompt?, concept_tags?, quiz? }`
- **profile** — returns `{ counts, mastered }`

## Tests

```bash
bun test
```

## Architecture

```
prompt + diff
    │
    ▼
┌─────────┐   interrupt?   ┌─────────┐
│ Triage  │ ──yes────────► │  Coach  │ ──► nudge, explanation, better_prompt,
│ (cheap) │                │(strong) │     concept_tags, quiz
└─────────┘                └─────────┘
    │ no                          │
    ▼                             ▼
  silent                    profile.record(tags)
```

Inspired by Clicky (AI teacher buddy), Interview Coder (stealth desktop), and Cluely (screen-aware AI).
