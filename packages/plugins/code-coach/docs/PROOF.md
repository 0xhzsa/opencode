# Proof — slice 1

Environment: Windows 11 Home Single Language, Windows PowerShell 5.1.26100.9711,
Bun 1.4.4, Node v22.23.1. The daemon and the test run on the same machine.

## 1. Plugin contract (all platforms)

`bun test` in `packages/plugins/code-coach`, against a fake daemon over the real
IPC files:

```text
4 pass
0 fail
14 expect() calls
Ran 4 tests across 1 file. [636.00ms]
```

The four tests assert:

- `attach` leaves `prompt.text` byte-for-byte unchanged and injects the
  attachment on the same turn only
- `hold` waits for the card decision and still sends the original words
- a dead daemon returns in under 500 ms, sends the prompt untouched, and writes
  no request
- `COACH_BYPASS`, system-shaped payloads, and slash commands never gate

## 2. Types, lint, and parse

```text
bun run typecheck:tsc                 exit 0, no diagnostics
oxlint packages/plugins/code-coach    0 warnings, 0 errors (2 files)
PowerShell parse                      2 files, 0 errors
```

## 3. Live gate (Windows)

![The gate card: "Destructive ask without a recovery point", with Add the guardrail and Send as written](proof/gate-card.png)

`tests/Run-Minimal.ps1` starts the real daemon in a child process, writes the
same `req-<id>.json` the plugin writes, and drives the real WPF card through UI
Automation. Full output:

```text
[PASS] daemon wrote its pid file
[PASS] daemon process is alive
[PASS] pass: verdict inside VERDICT_MS
[PASS] pass: action is pass
[PASS] pass: response parses in Node
[PASS] pass: response has no BOM
[PASS] attach: verdict inside VERDICT_MS
[PASS] attach: action is attach
[PASS] attach: names the missing target
[PASS] attach: response parses in Node
[PASS] hold: verdict inside VERDICT_MS
[PASS] hold: action is hold
[PASS] hold: card is up
[PASS] hold: Add the guardrail clicked
[PASS] hold: decision is attach
[PASS] hold: decision carries the guardrail
[PASS] hold: decision parses in Node
[PASS] hold: decision has no BOM
[PASS] hold: card closed after the click
[PASS] hold: second verdict arrives
[PASS] hold: second card is up
[PASS] hold: Send as written clicked
[PASS] hold: Send as written answers pass
[PASS] hold: second card closed
[PASS] close: hold verdict arrives
[PASS] close: card is up before the request is removed
[PASS] close: card goes away with the request
[PASS] close: no decision is invented
[PASS] stale: abandoned request is answered pass
[PASS] stale: no card for an abandoned request
[PASS] stale: request is removed
[PASS] guard: second daemon exits 2
[PASS] guard: second daemon names the running pid
[PASS] quiet: no request files left behind
[PASS] quiet: no prompt text in daemon.log or trace.jsonl
[PASS] wire: trace records pass, attach, and hold
[PASS] stop: daemon exits on the stop file
[PASS] stop: pid file removed

checks: 38  failed: 0
minimal gate: PASS
```

What it proves:

- `pass` and `attach` verdicts arrive inside the plugin's 1500 ms window
- `hold` puts a card on screen; **Add the guardrail** writes a decision with the
  guardrail; **Send as written** writes `pass`
- the card closes after a click, and closes when the request disappears
- a stale request is answered `pass` with no card
- a second daemon on the same folder exits 2 and names the running pid
- no prompt text appears in `daemon.log` or `trace.jsonl`
- every `res`/`dec` parses in Node and has no BOM
- the stop file shuts the daemon down and removes the pid file

## 4. A bug the contract check caught

The first daemon wrote JSON with `Set-Content -Encoding UTF8`. Windows
PowerShell 5.1 writes a BOM with that encoding, and the plugin reads verdicts
with `readFileSync` + `JSON.parse`, which rejects a BOM. Every verdict would
have been unreadable in production while the fake-daemon tests stayed green,
because those tests write with Node.

The daemon now writes through `System.Text.UTF8Encoding($false)`. The live test
asserts that `res` and `dec` parse in Node and that their first three bytes are
not `EF BB BF`.

## 5. Scope

This receipt covers the gate only: two deterministic rules, one card, and the
file contract. It does not claim the triage lane, Explain why, Fix my prompt,
Snooze, the learner, autostart, or the doctor. Those are later slices and are
listed in the README.
