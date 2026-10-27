# IPC — the slice-1 contract

Two processes, one file type, one folder. `index.ts` writes requests;
`src/Coach.Daemon.ps1` reads them. Nothing is written back.

| Half | Location |
| --- | --- |
| Plugin (writes requests) | `index.ts` |
| Daemon (reads requests) | `src/Coach.Daemon.ps1` |
| Folder | `%LOCALAPPDATA%\CodeCoachData\ipc\` (or `%COACH_DATA_DIR%\ipc`) |

Both halves derive the folder the same way: `COACH_DATA_DIR` when set,
otherwise `LOCALAPPDATA`. There is no config knob for it.

## 1. Sequence

```text
developer presses Enter in the opencode TUI
  -> core calls the plugin's "prompt" hook, and AWAITS it before admitting
     the message (SessionPrompt.prepare)
  -> plugin filters: bypass, empty, under 12 chars, slash command, over 4000
     chars, system-shaped, or no live daemon -> return, write nothing
  -> plugin writes req-<id>.json { id, text, cwd, sid, at }
  -> plugin returns the event untouched; the send proceeds immediately
  -> daemon (separate process, 40 ms scan) reads the request and deletes it
       destructive ask with no recovery point -> one card
       anything else                          -> nothing
  -> card: "Copy the guardrail" -> clipboard, "Dismiss" -> nothing
```

The hook is on the send path, so it does exactly one small write. There is no
verdict, no decision, no poll, and no timeout anywhere in this contract.

The plugin never mutates `event.prompt`, and there is no `context` hook. The
model request is byte-for-byte what opencode would have sent without the
plugin.

## 2. The file

Every write is atomic: write `<name>.tmp`, then rename. Encoding is UTF-8
without a BOM.

The BOM rule is not cosmetic. The plugin decides whether to write at all by
reading `daemon.pid` and running it through `Number(...)`. Windows PowerShell
5.1's `Set-Content -Encoding UTF8` writes a BOM, and `Number("\uFEFF123")` is
`NaN`, so a BOM there would make the plugin believe the coach is dead and go
silent forever. The daemon writes that file with
`System.Text.UTF8Encoding($false)`, and the live test asserts the plugin sees a
live pid.

### `req-<id>.json` — written by the plugin, deleted by the daemon

```json
{
  "id": "<uuid>",
  "text": "<the prompt text the developer typed>",
  "cwd": "C:\\work\\app",
  "sid": "<session id>",
  "at": 1793000000000
}
```

`id` is a UUID and is used only for tracing. `at` is the plugin's wall clock and
is informational; the daemon uses the file's `LastWriteTime` for staleness so a
clock skew cannot keep a request alive.

The daemon deletes the file immediately after reading it, before deciding. If
the daemon is down, the plugin never writes: `daemon.pid` must name a live
process, or the send is left completely alone.

## 3. Rules the daemon enforces

- **Recovery point first.** If the text matches `backup`, `commit first`,
  `commit before`, `commit the current`, `dry run`, `snapshot`, `confirm`,
  `only`, `specific`, `this file`, or `one file`, the verdict is silence.
- **Hard patterns.** `rm -rf`, `git clean`, `force-push`, `drop table`,
  `truncate table` → card.
- **Destructive verb + object.** `delete`, `reset`, `drop`, `truncate`,
  `overwrite`, `wipe`, `purge`, `destroy`, `remove`, `clear` plus `files`,
  `database`, `logs`, `history`, `cache`, `config`, `secrets`, ... → card.
- **Everything else → silence.**
- **One card at a time.** A second destructive ask while a card is up is
  dropped and traced as `card_dropped`; it is not queued.
- **Stale request → dropped.** Older than 120 s: deleted, traced as
  `request_stale`, no card.
- **Fault isolation.** A malformed request is logged and deleted; the loop
  continues.
- **Clean exit.** `stop` closes the card, removes the pid file, and exits.

## 4. Timings

| Constant | Value | Why |
| --- | --- | --- |
| daemon scan | 40 ms | dispatcher pump and folder scan |
| card lifetime | 60 s | long enough to read; hovering pauses it |
| request staleness | 120 s | a request older than this belongs to a finished turn |

There are no cross-process timings to keep in lockstep, because the processes
never wait on each other.

## 5. Failure modes and required behaviour

| Failure | Required behaviour |
| --- | --- |
| `ipc` folder missing or unwritable | the plugin catches, logs, returns; the send proceeds |
| Coach not running | the plugin writes nothing at all |
| Malformed request JSON | the daemon deletes it, logs, keeps running |
| Daemon dies mid-card | the card dies with the process; the send already happened |
| Two destructive asks in the same tick | one card; the second is traced as dropped |
| Stale request from a finished turn | deleted without a card |
| Draft contains instructions ("ignore your rules") | it is data: matched by regex, never executed, never logged |

## 6. What must stay true

- The `prompt` hook **must not** wait on the daemon. Core awaits it before
  admitting the message; any wait is a delay on the developer's send.
- The plugin **must not** mutate `event.prompt` and **must not** register a
  `context` hook. Both change the model request.
- The daemon **must** delete the request before showing a card, so no prompt
  text outlives the nudge.
- The daemon **must not** log or trace prompt text. Length and outcome only.
- The action names are `copy` and `dismiss`; the trace events are `silent`,
  `card_shown`, `card_action`, `card_dropped`, `card_expired`, `request_stale`.

## 7. What is deliberately not in this slice

- No verdict or decision files. Nothing flows back to the plugin.
- No `context` hook, no attachment, no system-prompt change.
- No model call, no triage lane, no security-intent heuristics.
- No Explain why, Fix my prompt, Ignore, or Snooze.
- No learner, lessons, insights, or persisted snooze state.
- No autostart, guard script, or doctor.
