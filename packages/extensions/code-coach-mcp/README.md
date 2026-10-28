# Code Coach MCP Server

An AI coach that watches your prompts and diffs, teaches first principles, and
learns from you. It observes; it never writes code.

This is the model half. The editor/browser/desktop observers live in
[`code-coach-vscode`](../code-coach-vscode); the full architecture is documented
there.

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

## What feeds it

The server is editor-agnostic: any MCP client can call `coach`. The bundled
VS Code extension adds these observers:

| Signal | Where it comes from | How |
|---|---|---|
| **Diff** | VS Code / Cursor / Windsurf | On save, a real line diff against the last baseline |
| **Prompt** | Clipboard | The last prose-looking text copied from any chat UI |
| **Prompt** | Browser chat tabs | CDP reads the composer; emits when it clears (submit) |
| **Prompt** | Desktop apps (Windows) | UI Automation reads the focused Edit control; emits on submit/blur |
| **Terminal** | VS Code | Error/failure lines are sent as `context` |

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

Input:

```json
{
  "prompt": "Add a login endpoint that checks the user's password",
  "diff": "app.post('/login', ...)",
  "context": "TERMINAL:\nTypeError: ...",
  "source": "browser:claude.ai"
}
```

`diff`, `context`, and `source` are optional. `source` tells the model where the
observation came from, which matters when there is no diff yet.

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
  "quiz": "...",
  "source": "browser:claude.ai",
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

- **Embedded chat webviews are opaque.** Cursor's and Claude's in-app chat
  panels expose no public API. The extension uses UI Automation as a best
  effort there, plus clipboard and an explicit command.
- **Browser capture needs a debug port.** It is opt-in and local.
- **Terminal capture depends on a proposed VS Code API.** When unavailable, the
  extension simply does not watch the terminal.
- **Free-tier OpenRouter accounts are tight.** The default models are paid;
  free models exist but are heavily rate-limited. The mock mode exists so the
  pipeline is testable without either.
- **The coach is a model.** It can be wrong. The `uncertain` flag and the
  "don't invent vulnerabilities" instruction reduce false positives but do not
  eliminate them.
- **No keyboard hook, by design.** A global keylogger would see passwords and
  every other app; reading the composer achieves the same goal with a much
  smaller blast radius.

Inspired by Clicky (AI teacher buddy), Interview Coder (stealth desktop), and
Cluely (screen-aware AI).
