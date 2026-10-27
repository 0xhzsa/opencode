# Code Coach (slice 1: the destructive-ask nudge)

An opt-in opencode plugin that watches a prompt **after** it is sent and stays
quiet unless the ask destroys state with no recovery point. When it does, one
card offers a guardrail you can paste into the conversation.

The plugin never delays, blocks, rewrites, or re-sends anything.

## What this slice does

| Prompt | What happens |
| --- | --- |
| `Summarize the current state of the parser` | nothing |
| `delete the old logs after committing the current state first` | nothing — the ask has a recovery point |
| `delete all the logs from last week` | one card: **Copy the guardrail** or **Dismiss** |

The card is a nudge after the fact, not a gate. It appears next to the
composer, cannot take focus, and dismisses itself after 60 seconds (hovering
pauses the countdown). **Copy the guardrail** puts this on the clipboard:

> Before you delete or rewrite anything, commit the current state, take a
> backup, and run the change against one target first; confirm the result
> before widening it.

One deterministic rule, no model call and no network:

1. a destructive verb (`delete`, `reset`, `drop`, `truncate`, `overwrite`,
   `wipe`, `purge`, `destroy`, `remove`, `clear`) plus a destructive object
   (`files`, `database`, `logs`, `history`, `cache`, `config`, `secrets`, ...),
   or a hard pattern (`rm -rf`, `git clean`, `force-push`, `drop table`)
   **and no recovery point** in the text → one card
2. anything else → silence

A recovery point is any of `backup`, `commit first`, `dry run`, `snapshot`,
`confirm`, `only`, `specific`, `this file`, `one file`. Saying one of those
turns the rule off for that prompt.

## Why the hook does not wait

opencode core awaits the `prompt` hook inside `SessionPrompt.prepare`, **before
the message is admitted**. Anything slow in that hook is felt as a delay on
every send that matches. An earlier revision of this package polled for a
verdict (1.5 s) and then for a card decision (5 s) inside that hook, which
turned the coach into a pre-send gate and contradicted the design.

This revision does one small file write and returns:

```text
prompt hook  -> filter -> write req-<id>.json -> return the event untouched
daemon       -> read the request, delete it, decide, maybe show one card
```

There is no verdict file, no decision file, no polling, no timeout, and no
mutation of `event.prompt`. The card's buttons cannot change a send that has
already happened; they copy text or dismiss.

## What is not here yet

This is the first reviewable slice requested in
[#59587](https://github.com/anomalyco/opencode/pull/59587). Later slices add:

- the triage lane (one model call per eligible send) and the security-intent
  heuristics
- Explain why, Fix my prompt, Ignore, Snooze
- the learner, lessons, insights, and persisted snooze state
- autostart install/uninstall, `coach-guard`, and the doctor
- earned context attached to a later model call

Until then the daemon is started by hand and stopped with a `stop` file.

## Requirements

- Windows 10 or 11. The daemon is Windows PowerShell 5.1 + WPF; on macOS and
  Linux the plugin logs `skip: unsupported platform` and does nothing.
- opencode with the v2 plugin API (`session.hook("prompt")`).
- Node or Bun only for the plugin's tests.

## Run it from a checkout

This is the supported setup for slice 1, because the daemon is a separate
process and is not started by the plugin.

1. Clone and install:

   ```powershell
   git clone https://github.com/anomalyco/opencode.git
   cd opencode
   bun install
   ```

2. Add the plugin to your opencode config. In `%USERPROFILE%\.config\opencode\opencode.json`
   (or the project's `opencode.jsonc`):

   ```jsonc
   {
     "plugins": ["./packages/plugins/code-coach"]
   }
   ```

3. Start the daemon in its own PowerShell window:

   ```powershell
   powershell -NoProfile -STA -ExecutionPolicy Bypass -File packages\plugins\code-coach\src\Coach.Daemon.ps1
   ```

   `COACH_DATA_DIR` overrides the data folder (`%LOCALAPPDATA%\CodeCoachData`).
   The daemon writes `daemon.pid`, `logs\daemon.log`, and `trace.jsonl` there.

4. Send a destructive prompt from opencode. The plugin writes a request only
   when the send is substantive and the daemon is alive; the daemon shows a
   card when the ask has no recovery point.

5. Stop the daemon:

   ```powershell
   New-Item -ItemType File (Join-Path $env:LOCALAPPDATA 'CodeCoachData\stop')
   ```

The daemon removes its pid file and the `stop` file on exit.

## Install the plugin from Git

The plugin half can be installed without a checkout:

```powershell
opencode plugin add 'git+https://github.com/anomalyco/opencode.git#path:packages/plugins/code-coach'
```

The daemon still has to run from a checkout in this slice. Autostart and a
one-command installer are a later slice.

## Privacy

- The plugin writes prompt text only when `daemon.pid` names a live process. If
  the coach is not running, nothing is written and the send is untouched.
- The daemon deletes the request as soon as it reads it. A request older than
  120 s is deleted without a card.
- The daemon logs the prompt **length** and the outcome, never the text.
- There is no transcript, no key, and no network call in this slice.
- The guardrail is a fixed string; the card never reads the session.

## Verify

```powershell
cd packages/plugins/code-coach
bun test                                  # 7 tests, no daemon, all platforms
bun run typecheck:tsc                     # clean
powershell -STA -File tests\Run-Minimal.ps1   # 35 live checks, Windows desktop
```

The live test starts the real daemon in a child process, writes the same
`req-<id>.json` the plugin writes, drives the card through UI Automation, and
asserts the clipboard contents. Its receipt is in `docs/PROOF.md`.

## Files

| Path | What |
| --- | --- |
| `index.ts` | plugin half: filter, write one request, return |
| `src/Coach.Daemon.ps1` | daemon half: one rule, one card, clipboard, pid guard |
| `index.test.ts` | plugin tests; no daemon, no timers |
| `tests/Run-Minimal.ps1` | live end-to-end test for the daemon and card |
| `docs/IPC.md` | the one-file contract |
| `docs/PROOF.md` | receipts |

## Design notes

- **Post-send, not pre-send.** A pre-send gate turns a coach into a blocker and
  trains people to click through. A post-send card costs nothing when it is
  wrong.
- **One write, no wait.** The hook is on the send path; the daemon is not.
- **The card cannot take focus.** The window uses `WS_EX_NOACTIVATE` and
  `ShowActivated = false`, so a click leaves the caret where it was.
- **Fail-open everywhere.** A dead daemon, a missing folder, a malformed file,
  or a write error leaves the developer's send untouched. There is no path that
  drops or alters a prompt.
- **One card at a time.** A second destructive ask while a card is up is dropped
  and traced, not stacked.
