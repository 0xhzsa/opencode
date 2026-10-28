# Code Coach (VS Code / Cursor extension)

An AI coach that watches your prompts and diffs, teaches the first principle
underneath the bug, and remembers what you have already learned. It observes;
it never writes code.

This package is the client. The model work lives in
[`code-coach-mcp`](../code-coach-mcp), an MCP server over stdio.

---

## The loop

```
you type a prompt ──► observer captures it
                          │
                          ▼
                   cheap triage model
                   "is this worth interrupting for?"
                          │
             ┌────────────┴────────────┐
             │ no                      │ yes
             ▼                         ▼
          silence                 coach model
      (the default)           nudge + explanation
                              + better prompt + tags
                                       │
                                       ▼
                              persistent card
                     Explain · Fix my prompt · Snooze · Ignore
                                       │
                                       ▼
                              learner profile
                     counts, mastered at 3, depth per concept
```

The card has **no timer**. It stays until you click Ignore or Snooze, or a new
nudge replaces it.

---

## Architecture

```
┌──────────────────────────── your machine ────────────────────────────────────┐
│                                                                              │
│  OBSERVERS                                                                   │
│  ┌─────────────────────────────┐  ┌─────────────────────────────┐            │
│  │ VS Code / Cursor / Windsurf │  │ Chrome / Edge chat tabs     │            │
│  │  • save diff (LCS)          │  │  • CDP composer reader      │            │
│  │  • terminal errors          │  │  • emit when composer clears│            │
│  │  • clipboard prompts        │  │    opt-in, port 9222        │            │
│  └──────────────┬──────────────┘  └──────────────┬──────────────┘            │
│                 │                                │                           │
│  ┌──────────────┴──────────────┐                 │                           │
│  │ Desktop apps (Windows)      │                 │                           │
│  │  • UI Automation Edit reader│                 │                           │
│  │  • emit on submit / blur    │                 │                           │
│  │    opt-in, best effort      │                 │                           │
│  └──────────────┬──────────────┘                 │                           │
│                 └──────────────┬─────────────────┘                           │
│                                ▼                                             │
│                     ObserverHub                                              │
│             dedupe · min/max · pair prompt + diff                            │
│                                │                                             │
│                                ▼                                             │
│                     MCP client (JSON-RPC over stdio)                         │
│                                │                                             │
│                                ▼                                             │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │ code-coach-mcp                                                         │  │
│  │                                                                        │  │
│  │  1. triage (Haiku-class) ──► {"interrupt": false} most of the time     │  │
│  │         │ interrupt: true                                              │  │
│  │         ▼                                                              │  │
│  │  2. coach (Sonnet-class) ──► nudge · explanation · better prompt       │  │
│  │         │                     concept_tags · quiz                      │  │
│  │         ▼                                                              │  │
│  │  learner profile  ~/.code-coach/profile.jsonl                          │  │
│  │  counts per concept · mastered at 3 · depth per concept                │  │
│  └───────────────────────────────────┬────────────────────────────────────┘  │
│                                      │                                       │
│                                      ▼                                       │
│                     persistent webview card (no auto-dismiss)                │
└──────────────────────────────────────────────────────────────────────────────┘
```

Only `prompt`, `diff`, `context`, and `source` are sent to the model provider
when the coach runs. Everything else stays on the machine.

---

## What watches what

| Where you work | Prompt | Diff | Terminal |
|---|---|---|---|
| VS Code / Cursor / Windsurf | clipboard, CDP (browser), UIA (desktop), or `Coach this prompt` | save diff (LCS) | terminal API when available |
| Claude Desktop | UIA (Windows, best effort), clipboard | — | — |
| Chrome / Edge chat (claude.ai, chatgpt.com, gemini, ...) | CDP composer reader | — | — |
| A terminal outside VS Code | clipboard | — | — |
| Any MCP client | `coach` tool | `coach` tool | `coach` tool |

Honest gaps: Cursor's and Claude's **embedded** chat webviews have no public API,
so CDP cannot reach them and UIA only sees what the accessibility tree exposes.
Clipboard and the explicit command are the fallback there. Nothing pretends to
see a surface it cannot.

---

## Why not a keyboard hook

InterviewCoder and Cluely use OS-level capture because they are stealth desktop
apps. Copying that mechanism into an open-source developer tool would be the
wrong trade:

- A global keyboard hook sees **every** keystroke in **every** app: passwords,
  2FA codes, private messages, other people's data.
- One bug or one compromised dependency turns the coach into a keylogger.
- The thing the coach actually needs is "the prompt the developer just sent",
  not "every key".

So the observation layer reads the **composer** instead. CDP reads the chat
input element; UI Automation reads the focused Edit control; the clipboard and
the explicit command cover the rest. Same goal, far smaller blast radius, and
it is opt-in.

What this borrows from the references: Clicky's teacher loop, Cluely's
screen-awareness, InterviewCoder's multi-provider desktop shape. What it does
not borrow: the stealth capture model.

---

## Observers, one by one

### 1. Save diff (`src/diff.ts`)

On save, a line-based LCS diff between the last saved baseline and the current
content. Context lines around each change, truncation for huge files, a cheap
fallback when the LCS table would be too large.

### 2. Terminal (`src/extension.ts`)

`onDidWriteTerminalData` is a proposed VS Code API. When it exists, lines
matching `error|fail|cannot find|exception|traceback` are sent as `context`.
When it does not, the observer is simply absent.

### 3. Clipboard (`src/observe/clipboard.ts`)

Polls the clipboard every two seconds and keeps the last text that looks like
prose, not code. This is the universal fallback: any app can copy.

### 4. Browser CDP (`src/observe/cdp.ts`)

Attaches to a browser started with `--remote-debugging-port`, lists chat tabs
(`/json/list`), and evaluates a small expression in the page that finds the
visible composer. It remembers the last non-empty text and emits it when the
composer clears — which is what every chat UI does on send. No keystrokes, no
network interception.

The WebSocket client is ~150 lines with no dependencies (`src/observe/ws.ts`),
because the extension host runs Node 20, which has no global `WebSocket`.

### 5. Windows UI Automation (`src/observe/uia.ts` + `media/uia-observer.ps1`)

A long-lived PowerShell helper reads `AutomationElement.FocusedElement` every
700ms. It only reports `ControlType.Edit` (never a `Document`, which would dump
a whole page), and only emits when the field is cleared or loses focus. The
TypeScript side keeps prose-looking prompts from known chat apps and rejects
address bars, URLs, and code.

Best effort by design: an Electron composer that is not exposed as an Edit
control produces no events. The status bar tells you which observers are live.

---

## Setup

```bash
cd packages/extensions/code-coach-vscode
npm install
npm run compile
```

The extension spawns the MCP server from the sibling package by default. Build
that too:

```bash
cd ../code-coach-mcp
npm install
npm run build
```

Set `OPENROUTER_API_KEY` in the environment the extension host inherits, or put
the path to the server in `codeCoach.mcpServerPath`.

### Browser chat (optional)

Launch Chrome/Edge with a separate profile and the debugging port:

```powershell
chrome.exe --remote-debugging-port=9222 --user-data-dir="%TEMP%\code-coach-chrome"
```

Log in to Claude/ChatGPT once in that profile, then enable
`codeCoach.observe.browser`. Chrome 136+ refuses remote debugging on the
default profile, hence the separate `--user-data-dir`. The port is local; the
browser is not exposed to the network.

### Desktop apps on Windows (optional)

Enable `codeCoach.observe.uia`. No setup beyond that. It is read-only and never
installs a keyboard hook.

---

## Settings

| Setting | Default | What it does |
|---|---|---|
| `codeCoach.mcpServerPath` | `""` | Path to `code-coach-mcp/dist/index.js`; empty uses the sibling package |
| `codeCoach.observe.clipboard` | `true` | Read prose from the clipboard |
| `codeCoach.observe.browser` | `false` | Watch browser chat tabs over CDP |
| `codeCoach.observe.uia` | `false` | Watch the focused Edit control on Windows |
| `codeCoach.cdpPort` | `9222` | Local CDP port |

## Commands

- `Code Coach: Coach this prompt`
- `Code Coach: Coach the clipboard prompt`
- `Code Coach: Show observers`
- `Code Coach: Snooze for 5 minutes`
- `Code Coach: Show learner profile`
- `Code Coach: Reset learner profile`

---

## Learner profile

Append-only JSONL at `~/.code-coach/profile.jsonl` (the MCP server owns it).
Each interaction records the concept tags that fired. The read model is:

- `counts`: how many times each concept has appeared.
- `mastered`: concepts at 3+ hits. The coach stops re-teaching them and mentions
  the failure mode in one line instead.
- depth: 0–1 hits → beginner (analogy), 2 → intermediate (principle + tradeoff),
  3+ → advanced (failure mode only).

`Reset learner profile` clears it.

---

## Tests

```bash
bun test
```

60 tests across 10 files:

- `diff.test.ts` — LCS diff, context lines, truncation, a SQL-injection diff.
- `promptCapture.test.ts` — prose vs. code.
- `ws.test.ts` — real handshake and text frames against a Bun WebSocket server.
- `cdp.test.ts` — chat-host filter, target listing, `Runtime.evaluate`, a fake
  CDP server, and the composer-clears transition.
- `uia.test.ts` — Edit-only parsing, Document rejection, size limits, app filter.
- `hub.test.ts` — dedupe, min/max, same prompt from different sources.
- `clipboard.test.ts` — prose emitted once, code rejected, clipboard failure.
- `triage.test.ts`, `profile.test.ts` — the deterministic fallback engine.

The CDP DOM expression was also checked against a real headless Chrome: it read
the composer text, then read empty after the composer cleared.

---

## Limitations

- **Embedded webviews are still opaque.** Cursor's chat panel is not a browser
  tab, so CDP cannot attach to it; UIA is best effort. Clipboard/command remain.
- **CDP needs a debug port.** That is a deliberate opt-in, not a default.
- **UIA is best effort.** Only Edit controls, only known apps, only on Windows.
- **The coach is a model.** It can be wrong. `uncertain` and the "don't invent
  vulnerabilities" instruction reduce false positives; they do not eliminate
  them.
- **Free-tier OpenRouter accounts are tight.** `CODE_COACH_MOCK=1` exists so the
  pipeline is testable without credits; it is never the default.
