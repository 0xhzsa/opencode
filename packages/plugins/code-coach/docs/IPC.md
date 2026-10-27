# IPC — the slice-1 gate contract

Two processes, three file types, one folder. `index.ts` is the only writer of
requests and the only reader of verdicts; `src/Coach.Daemon.ps1` is the only
reader of requests and the only writer of verdicts.

| Half | Location |
| --- | --- |
| Plugin (writes requests, reads verdicts) | `index.ts` |
| Daemon (reads requests, writes verdicts) | `src/Coach.Daemon.ps1` |
| Folder | `%LOCALAPPDATA%\CodeCoachData\ipc\` (or `%COACH_DATA_DIR%\ipc`) |

Both halves derive the folder the same way: `COACH_DATA_DIR` when set,
otherwise `LOCALAPPDATA`. There is no config knob for it.

## 1. Sequence

```text
developer presses Enter in the opencode TUI
  -> the plugin's "prompt" hook runs BEFORE the model request
  -> plugin filters: slash command, under 12 chars, over 4000 chars,
     system-shaped, or no session context -> send, no request
  -> plugin writes req-<id>.json { id, text, ctx, cwd, sid }
  -> plugin polls res-<id>.json for VERDICT_MS = 1500 ms
       {action:"attach", attachment} -> store the attachment; prompt.text unchanged
       {action:"hold"}               -> keep req, poll dec-<id>.json for DECISION_MS = 5000 ms
       {action:"pass"}               -> delete req, the send proceeds
       no verdict                    -> delete req, the send proceeds (fail open)
  -> on hold the daemon shows one card:
       "Add the guardrail"  -> dec {action:"attach", attachment}
       "Send as written"    -> dec {action:"pass"}
       no click in 4500 ms  -> no dec; the plugin's 5 s poll expires
  -> immediately before dispatch, the plugin's "context" hook pushes the
     attachment onto event.system for this model call only
```

The attachment is never written into `prompt.text`. The developer's submitted
message is the message: persisted history, the composer, and the request text
stay exactly as typed. The context block is added to the outgoing model request
as a system part, so it affects that call and nothing else.

The plugin deletes `req` on **every** exit path, including timeouts and errors.
Its absence is the cancel signal: the daemon closes a card whose request has
disappeared and does not write a decision. A request older than 1200 ms is
answered `pass` without a card, because the plugin's 1500 ms poll has already
given up by then.

## 2. Files

Every write is atomic: write `<name>.tmp`, then move it over the target.
Encoding is UTF-8 **without a BOM**.

The BOM rule is not cosmetic. The daemon runs on Windows PowerShell 5.1, where
`Set-Content -Encoding UTF8` writes a BOM, and the plugin reads verdicts with
`JSON.parse`, which rejects one. The daemon writes JSON through
`System.Text.UTF8Encoding($false)` and `tests/Run-Minimal.ps1` asserts that
`res` and `dec` are BOM-less and parse in Node.

### `req-<id>.json` — written by the plugin

```json
{
  "id": "<uuid>",
  "text": "<the prompt text the developer typed>",
  "cwd": "C:\\work\\app",
  "sid": "<session id>",
  "ctx": {
    "turn": 2,
    "attempts": 1,
    "files": ["src/Coach.Daemon.ps1"],
    "errors": [],
    "tests": ["tests/Run-Minimal.ps1"],
    "constraints": ["do not change the IPC file names"],
    "success": [],
    "goals": []
  }
}
```

The slice-1 daemon reads `id` and `text` only. `ctx`, `cwd`, and `sid` are
written for later slices and ignored here. `ctx` is a digest, not a transcript:
snippets are capped at 160 characters, the whole digest at 2200, and each list
at five entries. The daemon never receives assistant prose or message bodies.

### `res-<id>.json` — written by the daemon, read by the plugin

```json
{ "action": "pass" }
```

```json
{ "action": "hold" }
```

```json
{
  "action": "attach",
  "attachment": "Target: name the file, route, or function this change touches, and the check that proves it works."
}
```

`action` is `pass`, `hold`, or `attach`. `attachment` is present only for
`attach`. The daemon does not send a `text` field in this slice; the plugin
still accepts one for forward compatibility, but it never replaces the
developer's words.

### `dec-<id>.json` — written by the daemon, read by the plugin

```json
{
  "action": "attach",
  "attachment": "Before you delete or rewrite anything, commit the current state, take a backup, and run the change against one target first; confirm the result before widening it."
}
```

```json
{ "action": "pass" }
```

`action` is `attach` or `pass`. `attachment` is present only for `attach`.

Both `res` and `dec` are deleted by the plugin when it reads them. If the plugin
dies first, they contain no prompt text and are harmless; the daemon never
reads them back.

### `daemon.pid` and `stop`

`daemon.pid` is the daemon's process id, written at startup and removed on a
clean exit. The plugin treats a missing or dead pid as "no coach" and sends
without a request. A second daemon pointed at the same folder exits `2` and
names the running pid.

`stop` is a file, not a signal: create it and the daemon closes any card,
removes `daemon.pid` and `stop`, and exits. This is how the live test stops it
without killing the process.

## 3. Rules the daemon enforces

- **Guard first.** If the text matches the recovery-point guard (`backup`,
  `commit first`, `dry run`, `snapshot`, `confirm`, `only`, `specific`,
  `this file`, `one file`), the verdict is `pass`.
- **Destructive → hold.** A destructive verb (`delete`, `reset`, `drop`,
  `truncate`, `overwrite`, `wipe`, `purge`, `destroy`, `remove`, `clear`) plus a
  destructive object (`files`, `database`, `logs`, `history`, `cache`,
  `config`, `secrets`, ...), or a hard pattern (`rm -rf`, `git clean`,
  `force-push`, `drop table`, `truncate table`), answers `hold`.
- **Change without a target → attach.** A change verb (`fix`, `make`,
  `improve`, `refactor`, `rewrite`, `update`, `change`, `handle`, `support`,
  `add`, `move`, `rename`, `remove`) with no file extension in the text answers
  `attach`.
- **Everything else → pass.**
- **One card at a time.** A second `hold` while a card is up is answered `pass`
  rather than stacked. Queuing is a later slice.
- **Stale request → pass.** A request older than 1200 ms is answered `pass` and
  removed without a card.
- **Fault isolation.** A malformed request or a failed window is logged, the
  request is deleted, and the loop continues. One bad request cannot stop the
  gate.
- **Clean exit.** `stop` closes the card, removes the pid file, and exits.

## 4. Timings that must stay in lockstep

| Constant | Value | Why |
| --- | --- | --- |
| plugin `VERDICT_MS` | 1500 ms | how long the plugin waits for `res` |
| plugin `DECISION_MS` | 5000 ms | how long the plugin waits for `dec` |
| plugin `POLL_MS` | 40 ms | file poll interval |
| daemon loop | 40 ms | dispatcher pump and request scan |
| daemon stale limit | 1200 ms | must stay below `VERDICT_MS` |
| daemon card deadline | 4500 ms | must stay below `DECISION_MS`, with margin |

The plugin's timings are env-overridable (`COACH_VERDICT_MS`,
`COACH_DECISION_MS`) only so tests can exercise timeouts. Production uses the
defaults above. The daemon has no timing config in this slice.

## 5. Failure modes and required behaviour

| Failure | Required behaviour |
| --- | --- |
| `ipc` folder missing or unwritable | the plugin fails open; the daemon logs and keeps running |
| Malformed request JSON | the daemon deletes it, logs the error, answers nothing; the plugin's poll expires and the send proceeds |
| Coach not running | the plugin's 1500 ms verdict poll expires and the send proceeds |
| Coach dies during a hold | the plugin's 5 s decision poll expires and the send proceeds |
| Plugin withdraws during a hold | the daemon closes the card; no decision is written |
| Session context unavailable | the plugin writes no request and the send proceeds |
| Two requests in the same tick | ids are unique; the second `hold` is answered `pass` |
| Stale request from a dead plugin | the daemon answers `pass` and deletes it |
| Draft contains instructions ("ignore your rules") | it is untrusted data; never executed, never logged, never sent to a model in this slice |

A broken coach shows nothing and never blocks a send. This is the contract's
floor.

## 6. What must stay in lockstep

- The daemon card deadline (4500 ms) **must** stay below the plugin's
  `DECISION_MS` (5000 ms).
- The daemon stale limit (1200 ms) **must** stay below the plugin's
  `VERDICT_MS` (1500 ms).
- `res` and `dec` **must** be UTF-8 without a BOM. `tests/Run-Minimal.ps1`
  parses every one with Node's `JSON.parse` and asserts the first three bytes
  are not `EF BB BF`.
- The action names are `pass`, `attach`, and `hold`; the attachment field is
  `attachment`. Changing either is a contract change on both sides.
- The daemon writes `res` before it shows a card. The plugin must see the
  verdict before it starts waiting for a decision.
- One card at a time. Stacking is a later slice, not a tweak.

## 7. What is deliberately not in this slice

- No `text` field in `res`/`dec`; the daemon never compiles or rewrites a
  prompt.
- No `autosend` / `review` / `off` modes. Every eligible send gets the same
  gate.
- No model call, no triage lane, no security-intent heuristics.
- No Explain why, Fix my prompt, Ignore, or Snooze actions.
- No learner, lessons, insights, or persisted snooze state.
- No autostart, guard script, doctor, or cleanup sweep. The plugin owns `req`;
  the daemon owns `res`/`dec`; a crashed process leaves only files with no
  prompt text.
