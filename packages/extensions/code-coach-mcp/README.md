# Code Coach MCP Server

An AI coach that watches your prompts and diffs, teaches first principles, and
learns from you. It observes; it never writes code.

## How it works

Two steps, not one:

1. **Triage** (cheap model): "Is there anything here worth interrupting for?"
   Returns `{ "interrupt": false }` most of the time. Silence is the default.
   If it is suspicious but not sure, it sets `"uncertain": true` instead of
   inventing a vulnerability.
2. **Coach** (stronger model, only when triage says interrupt): produces a
   nudge, explanation, better prompt, concept tags, and an optional quiz.

The learner profile persists across sessions. Concept tags accumulate; after
3 hits a concept is **mastered** and the coach stops re-teaching it. Depth
escalates per concept: beginner (analogy) → intermediate (principle) →
advanced (failure mode only).

## What it watches

| Signal | Where it comes from | How |
|---|---|---|
| **Diff** | VS Code extension | On save, a real line diff against the last baseline |
| **Prompt** | Clipboard | The last prose-looking text copied from Cursor / Copilot / Claude chat |
| **Terminal** | VS Code extension | Error/failure lines are sent as context |

The MCP server itself is editor-agnostic. Cursor, Claude Code, or any MCP
client can call the `coach` tool directly with a prompt and a diff.

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
- `CODE_COACH_DATA_DIR` (default: `~/.code-coach`)
- `CODE_COACH_MOCK=1` — deterministic canned responses, no network, no credits

## Run as an MCP server

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
      "env": {
        "OPENROUTER_API_KEY": "sk-or-...",
        "CODE_COACH_DATA_DIR": "/path/to/.code-coach"
      }
    }
  }
}
```

## Tools

### `coach`

Input: `{ prompt: string, diff?: string, source?: string }`

Output:

```json
{
  "interrupt": true,
  "uncertain": false,
  "severity": "warn",
  "nudge": "...",
  "explanation": "...",
  "better_prompt": "...",
  "concept_tags": ["password-hashing", "rate-limiting"],
  "quiz": "..." ,
  "profile": { "counts": {}, "mastered": [] }
}
```

When there is nothing worth saying: `{ "interrupt": false, "reason": "..." }`.

### `profile`

Returns `{ counts: Record<string, number>, mastered: string[] }`.

### `project`

Returns `{ stack: string[], conventions: string[], files: string[], summary: string }`
detected from the current working directory.

### `reset-profile`

Clears the learner profile.

## Demo

```bash
node scripts/demo.mjs            # mock model, offline, free
CODE_COACH_MOCK=0 node scripts/demo.mjs   # live model
```

## Tests

```bash
bun test
```

- Pipeline and profile tests run against the deterministic mock model: no
  network, no credits, always green.
- The end-to-end test spawns the real server over stdio, initializes the MCP
  session, calls `coach`, and checks the profile was updated.
- The live test calls OpenRouter. It **skips** (does not fail) when the account
  is out of credits or rate-limited. Set `CODE_COACH_SKIP_LIVE=1` to skip it
  unconditionally.

## Honest limitations

- **Prompt capture is clipboard-based.** Cursor and Claude chat prompts live in
  webviews the extension cannot read. Copying the prompt (or using the
  "Coach this prompt" command) is the reliable path.
- **Terminal capture depends on a proposed VS Code API.** When unavailable, the
  extension simply does not watch the terminal.
- **Free-tier OpenRouter accounts are tight.** The default models are paid;
  free models exist but are heavily rate-limited. The mock mode exists so the
  pipeline is testable without either.
- **The coach is a model.** It can be wrong. The `uncertain` flag and the
  "don't invent vulnerabilities" instruction reduce false positives but do not
  eliminate them.

Inspired by Clicky (AI teacher buddy), Interview Coder (stealth desktop), and
Cluely (screen-aware AI).
