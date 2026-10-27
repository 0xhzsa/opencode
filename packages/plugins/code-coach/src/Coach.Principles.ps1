# Coach.Principles.ps1 - the engineering knowledge pack behind every card.
#
# A principle is not a label. Each one carries the claim, the mechanism that
# makes it true, the prompt gaps it explains, the code rules it covers, a review
# question, and the approach step a senior engineer would take. The prompt
# compiler and the code coach both read from this one table, so a card cannot
# say one thing in the prompt lane and another in the code lane.

$script:PrincipleCatalog = @(
  @{
    id         = 'finish-line'
    name       = 'Finish line'
    statement  = 'A request is done when you can tell afterward whether it was met.'
    mechanism  = 'A change verb plus a word like "better" names no state to check, so the model substitutes its own idea of done.'
    gaps       = @('outcome')
    codeRules  = @()
    question   = 'What observable result proves this is done?'
    answer     = 'A behavior, number, or check you can inspect afterward. "Better" is not a finish line.'
    triggers   = '(?i)\b(fix|make|improve|refactor|rewrite|update|change|clean|handle|support|add|move|rename|remove|faster|reliable|better|stable|robust)\b'
    approach   = @('Write the finish line as one observable behavior or number.', 'Name the check that proves it before editing.')
  },
  @{
    id         = 'name-the-place'
    name       = 'Name the place'
    statement  = 'The model cannot see your screen; naming the place turns a search into a look.'
    mechanism  = 'With no file, route, function, or screen named, the model locates code by keyword and often picks a neighbour.'
    gaps       = @('target', 'ref-check')
    codeRules  = @()
    question   = 'Which file, function, route, or screen owns this?'
    answer     = 'A place the model can open without searching. If you do not know it, say so and ask it to locate and confirm before editing.'
    triggers   = '(?i)\b(fix|make|improve|refactor|update|change|broken|fails?|error|bug|crash|wrong)\b'
    approach   = @('Open the named target and its callers before editing.', 'If the target is unknown, search for the symptom, list the candidates, and confirm before changing code.')
  },
  @{
    id         = 'both-sides'
    name       = 'Both sides of the bug'
    statement  = 'A bug report is two facts: what happens now, and what should happen.'
    mechanism  = 'With only one side stated, the model cannot tell whether the code or the expectation is wrong.'
    gaps       = @('observed-vs-expected')
    codeRules  = @()
    question   = 'What happens now, and what should happen instead?'
    answer     = 'Two separate sentences. The first is the observation; the second is the contract.'
    triggers   = '(?i)\b(bug|broken|fails?|failing|failed|crash|wrong|doesn|don|didn|isn|won|can)'
    approach   = @('Write the current behavior and the expected behavior as two separate sentences.')
  },
  @{
    id         = 'evidence-first'
    name       = 'Evidence before theory'
    statement  = 'Exact error text cuts the search to a few lines.'
    mechanism  = 'No error text means the model matches the symptom to its most common cause, not yours.'
    gaps       = @('evidence')
    codeRules  = @()
    question   = 'What exact error, log line, or reproduction proves the failure?'
    answer     = 'The shortest text that points at the failing line, plus the command or steps that produce it.'
    triggers   = '(?i)\b(bug|broken|fails?|failing|failed|error|crash|wrong|hidden|doesn|don|didn|isn|won|can)'
    approach   = @('Reproduce the failure and quote the exact output before editing.')
  },
  @{
    id         = 'smallest-diff'
    name       = 'Smallest reviewable diff'
    statement  = 'What you would reject in review is cheaper to say first.'
    mechanism  = 'A wide verb with no boundary lets the model improve neighbours you never asked about.'
    gaps       = @('scope', 'constraint')
    codeRules  = @()
    question   = 'What must not change?'
    answer     = 'Public names, data shapes, and unrelated files. Name the boundary before the model draws it.'
    triggers   = '(?i)\b(refactor|rewrite|reorganize|modernize|clean\s?up|everywhere|all files|schema|api|interface|dependency|upgrade|migrat)\b'
    approach   = @('List the files you will touch and the public names you will keep.', 'Do not revert or reformat unrelated work in the tree.')
  },
  @{
    id         = 'checkpoint'
    name       = 'Checkpoint before irreversible'
    statement  = 'A checkpoint is cheaper than a restore.'
    mechanism  = 'An irreversible verb with no checkpoint turns a bad guess into lost work.'
    gaps       = @('destructive', 'checkpoint')
    codeRules  = @()
    question   = 'Where is the undo point?'
    answer     = 'A commit, snapshot, backup, or dry run before the destructive step.'
    triggers   = '(?i)\b(delete|reset|revert|drop|truncate|overwrite|wipe|purge|destroy|remove|clean|clear|force[- ]?push|git clean)\b'
    approach   = @('Commit or snapshot first, then dry-run the destructive step.', 'Name exactly what must survive.')
  },
  @{
    id         = 'verify'
    name       = 'Verify before claiming'
    statement  = 'Give it a check and it can verify its own work before you see it.'
    mechanism  = 'With no command or expected output named, the model stops when the code looks right to it.'
    gaps       = @('check')
    codeRules  = @()
    question   = 'Which command proves it, and what output do you expect?'
    answer     = 'A test, build, or reproduction that fails before the change and passes after it.'
    triggers   = '(?i)\b(fix|make|improve|refactor|update|change|add|remove|rename|move|reliable|faster)\b'
    approach   = @('Run the check before and after the change; show both results.', 'If no check exists, add the smallest one that would have caught this.')
  },
  @{
    id         = 'change-the-input'
    name       = 'Change what the model knows'
    statement  = 'When the same ask fails twice, the model picture of the problem is wrong; change what it knows.'
    mechanism  = 'Similar retries resend the same context, so the model makes the same assumption again.'
    gaps       = @('stuck')
    codeRules  = @()
    question   = 'What did the last attempt teach you?'
    answer     = 'A new fact, not a rephrase. Name what you ruled out and the evidence for each remaining cause.'
    triggers   = '(?i)\b(again|still|keeps?|same|tried|retry|third|twice|second time)\b'
    approach   = @('List the two most likely causes and the evidence for each.', 'Change the input or the reproduction, not just the wording.')
  },
  @{
    id         = 'errors-are-data'
    name       = 'Errors are data'
    statement  = 'An empty catch is a lie about what went wrong.'
    mechanism  = 'A swallowed error turns a crash into a wrong answer, and the wrong answer is harder to find.'
    gaps       = @()
    codeRules  = @('code-swallowed')
    question   = 'What does the caller see when this fails?'
    answer     = 'A logged or rethrown error with the operation and identifiers, or an explicit expected-failure branch.'
    triggers   = '(?i)\b(catch|except|error|exception|fail|swallow|silent)\b'
    approach   = @('Log or rethrow with the operation and the identifiers needed to reproduce it.', 'Test the failure path, not only the happy path.')
  },
  @{
    id         = 'bounded-retries'
    name       = 'Bounded retries and timeouts'
    statement  = 'A retry without a budget is a loop that waits for a bad day.'
    mechanism  = 'An uncapped retry storms in lockstep, duplicates side effects, and stalls the caller with no timeout.'
    gaps       = @()
    codeRules  = @('code-retry', 'code-timeout')
    question   = 'What is the retry budget, and which failures are safe to repeat?'
    answer     = 'A maximum attempt count, jittered delay, timeout, fallback, and only idempotent calls.'
    triggers   = '(?i)\b(retry|retries|backoff|timeout|request|fetch|http|api|poll|worker)\b'
    approach   = @('Cap the attempts, add jitter, and give every outbound call a timeout and fallback.', 'Retry only calls that are safe to repeat.')
  },
  @{
    id         = 'secrets-out-of-source'
    name       = 'Secrets out of source'
    statement  = 'Secrets belong in the environment, not in the source tree.'
    mechanism  = 'A key in source is a key in git history; rotating it later costs more than moving it now.'
    gaps       = @()
    codeRules  = @('code-secret')
    question   = 'Where does this secret live, and how is it rotated?'
    answer     = 'An environment variable or secret store, never logs, prompts, or committed source.'
    triggers   = '(?i)\b(secret|token|password|credential|api[_-]?key|auth|private key)\b'
    approach   = @('Read the value from the environment or a secret store; rotate the exposed value.', 'Add a test that the value never appears in logs or prompts.')
  },
  @{
    id         = 'focus-is-a-gift'
    name       = 'Focus is the user''s'
    statement  = 'A window that never asked for focus cannot steal it.'
    mechanism  = 'A helper window that activates breaks the typing it was meant to help.'
    gaps       = @()
    codeRules  = @('code-focus')
    question   = 'Who owns the keyboard focus?'
    answer     = 'The user. Helper windows show without activating, at any DPI and on any monitor.'
    triggers   = '(?i)\b(window|overlay|wpf|xaml|dpi|focus|screen|ui|dialog|toast)\b'
    approach   = @('Show without activating and keep the window inside the screen at any DPI.', 'Test while the user is typing.')
  },
  @{
    id         = 'trust-boundary'
    name       = 'Trust boundary'
    statement  = 'Every input crosses a boundary; validate at the boundary, not after the damage.'
    mechanism  = 'Unvalidated input becomes injection, privilege escalation, or a corrupted state, and the failure surfaces far from the entry point.'
    gaps       = @()
    codeRules  = @()
    question   = 'Who can call this, and what do you trust from them?'
    answer     = 'Validate and authorize at the boundary; use least privilege; keep secrets and raw input out of logs.'
    triggers   = '(?i)\b(auth|token|permission|role|input|parse|request|endpoint|sql|query|upload|webhook|sandbox|shell|exec)\b'
    approach   = @('Name the boundary, validate the input, and test the hostile case.', 'Use parameterized queries, least privilege, and a deny-by-default path.')
  },
  @{
    id         = 'measure-before-optimizing'
    name       = 'Measure before optimizing'
    statement  = 'Without a baseline, "faster" cannot be measured.'
    mechanism  = 'A regression you cannot measure ships unnoticed; an optimization without a baseline is a guess.'
    gaps       = @()
    codeRules  = @()
    question   = 'What is the baseline, and what number counts as faster?'
    answer     = 'A measured before/after on the real workload, not a feeling or a microbenchmark of the wrong thing.'
    triggers   = '(?i)\b(performance|slow|latency|faster|optimi[sz]|speed|memory|cpu|throughput)\b'
    approach   = @('Measure a baseline on the real workload, change one thing, and measure again.')
  },
  @{
    id         = 'state-and-concurrency'
    name       = 'State and concurrency'
    statement  = 'Two workers with no ordering rule double-apply the change.'
    mechanism  = 'Duplicate delivery, partial failure, and concurrent writers turn a simple update into a race.'
    gaps       = @()
    codeRules  = @()
    question   = 'What happens on duplicate delivery, partial failure, and concurrent writers?'
    answer     = 'An explicit state transition, idempotency key, ordering rule, and transaction or compensation.'
    triggers   = '(?i)\b(async|concurren|thread|race|queue|parallel|worker|transaction|lock|atomic|idempot|duplicate)\b'
    approach   = @('Name the state transition and test duplicate and concurrent delivery.', 'Make the operation idempotent or wrap it in a transaction with a compensation path.')
  },
  @{
    id         = 'read-the-bytecode'
    name       = 'Read the machine'
    statement  = 'At the machine level, the invariants are the contract.'
    mechanism  = 'Calling convention, alignment, bounds, integer width, endianness, and undefined behavior are invisible in the source and fatal at runtime.'
    gaps       = @()
    codeRules  = @()
    question   = 'What are the ABI, memory, and overflow assumptions?'
    answer     = 'Explicit invariants plus sanitizers, bounds checks, and a fuzz or edge-case test.'
    triggers   = '(?i)\b(asm|assembly|bytecode|unsafe|pointer|bounds|alignment|overflow|underflow|abi|calling convention|sanitizer|fuzz|compiler|jit|gc|endianness|memory)\b'
    approach   = @('State the ABI and memory invariants; run sanitizers and a bounds/overflow edge-case test.')
  },
  @{
    id         = 'observability'
    name       = 'Observable failure'
    statement  = 'If you cannot see it fail, you cannot fix it.'
    mechanism  = 'A failure with no log, metric, or trace becomes a user report with no reproduction.'
    gaps       = @()
    codeRules  = @()
    question   = 'What will you see when it fails in production?'
    answer     = 'A log, metric, or trace with the operation, correlation id, and no secrets.'
    triggers   = '(?i)\b(log|metric|trace|debug|monitor|observ|correlat|hidden|silent)\b'
    approach   = @('Add the smallest signal that distinguishes this failure and test that it appears.')
  },
  @{
    id         = 'data-migration'
    name       = 'Re-runnable data change'
    statement  = 'A migration with no rollback leaves the database in a state no test covers.'
    mechanism  = 'A partial migration cannot be retried safely; old and new rows must both remain readable.'
    gaps       = @()
    codeRules  = @()
    question   = 'How is this re-run, rolled back, and kept compatible?'
    answer     = 'Idempotent steps, a rollback path, and dual-read/write where old and new coexist.'
    triggers   = '(?i)\b(migration|migrat|schema|backfill|rollback|re-?run|column|table|database)\b'
    approach   = @('Make the change re-runnable, add a rollback, and test old and new rows.')
  }
)

function Get-Principle([string]$Id) {
  foreach ($p in $script:PrincipleCatalog) { if ($p.id -eq $Id) { return $p } }
  return $null
}

function Get-Principles { return @($script:PrincipleCatalog) }

function Get-PrincipleForGap([string]$GapId) {
  if (-not $GapId) { return $null }
  foreach ($p in $script:PrincipleCatalog) {
    if (@($p.gaps) -contains $GapId) { return $p }
  }
  return $null
}

function Get-PrincipleForCodeRule([string]$RuleId) {
  if (-not $RuleId) { return $null }
  foreach ($p in $script:PrincipleCatalog) {
    if (@($p.codeRules) -contains $RuleId) { return $p }
  }
  return $null
}

# Relevant principles are the ones the request actually touches. A gap is the
# strongest signal; a trigger word is the fallback when the request is already
# clear, which is exactly the case where spontaneous application should count.
function Get-PrinciplesForText {
  param([string]$Draft, $Ctx, $Gaps)
  $out = New-Object System.Collections.ArrayList
  if ([string]::IsNullOrWhiteSpace($Draft)) { return @() }
  $gapIds = @()
  if ($Gaps) { $gapIds = @($Gaps | ForEach-Object { [string]$_.id }) }
  foreach ($p in $script:PrincipleCatalog) {
    $hit = $false
    foreach ($g in @($p.gaps)) { if ($gapIds -contains $g) { $hit = $true; break } }
    if (-not $hit -and $p.triggers) {
      if ($p.id -eq 'checkpoint' -and (Get-Command Test-DestructiveAsk -ErrorAction SilentlyContinue)) {
        $hit = Test-DestructiveAsk $Draft
      } else {
        $hit = ($Draft -match [string]$p.triggers)
      }
    }
    if ($hit) { [void]$out.Add($p) }
  }
  $attempts = 0
  if ($Ctx) {
    $a = Get-CtxValue $Ctx 'Attempts'
    if ($a -ne $null) { $attempts = [int]$a }
  }
  $filtered = @($out | Where-Object {
    if ($_.id -eq 'change-the-input') { return ($attempts -ge 2 -or $gapIds -contains 'stuck') }
    return $true
  })
  return @($filtered | Select-Object -First 8)
}

# Applied means the request already carries the fact the principle asks for.
# This is measured, not guessed: the same test decides whether to stay silent.
function Test-PrincipleApplied {
  param($Principle, [string]$Draft, $Ctx)
  if (-not $Principle) { return $false }
  $d = [string]$Draft
  $files = @(Get-CtxList $Ctx 'Files')
  $errors = @(Get-CtxList $Ctx 'Errors')
  $tests = @(Get-CtxList $Ctx 'Tests')
  $success = @(Get-CtxList $Ctx 'Success')
  $constraints = @(Get-CtxList $Ctx 'Constraints')
  $attempts = 0
  if ($Ctx) {
    $a = Get-CtxValue $Ctx 'Attempts'
    if ($a -ne $null) { $attempts = [int]$a }
  }

  switch ([string]$Principle.id) {
    'finish-line' {
      return (($d -match $script:ExpectedWords) -or ($d -match '\d') -or ($success.Count -gt 0))
    }
    'name-the-place' {
      return ((Test-PlaceNamed $d) -or ($files.Count -gt 0))
    }
    'both-sides' {
      return (($d -match $script:FailureStates) -and (($d -match $script:ExpectedWords) -or ($success.Count -gt 0)))
    }
    'evidence-first' {
      return (($d -match $script:ErrorEvidence) -or ($errors.Count -gt 0))
    }
    'smallest-diff' {
      return (($d -match $script:LimitWords) -or ($constraints.Count -gt 0))
    }
    'checkpoint' {
      $guard = '(?i)\b(backup|backed up|committed|commit first|commit before|commit the current|dry[- ]?run|dry run|confirm|confirmed|snapshot)\b'
      return (($d -match $guard) -or ($d -match '(?i)\b(only|specific|exact|this file|one file)\b'))
    }
    'verify' {
      $check = '(?i)(\btest\w*\b|\bspec\b|\bnpm\b|\bpytest\b|\bgo test\b|\bdotnet\b|\brun\b|\bcheck\b|\bverify\b|\bexpected\b|\bshould\b|\bassert\w*\b|\bpasses?\b)'
      return (($d -match $check) -or ($tests.Count -gt 0))
    }
    'change-the-input' {
      return (($attempts -ge 2) -and ($d -match '(?i)\b(already|tried|ruled out|log says|evidence|after)\b'))
    }
    'trust-boundary' {
      return (($d -match '(?i)\b(validate|authorize|sanitize|parameterized|least privilege|deny|escape|allowlist)\b') -or ($constraints.Count -gt 0))
    }
    'measure-before-optimizing' {
      return (($d -match '(?i)\b(baseline|measured|benchmark|before|after)\b') -or ($d -match '\d+\s*(ms|s|%|mb|gb)'))
    }
    'state-and-concurrency' {
      return ($d -match '(?i)\b(idempot|duplicate|ordering|transaction|lock|atomic|compensat)\b')
    }
    'read-the-bytecode' {
      return ($d -match '(?i)\b(bounds|alignment|overflow|underflow|abi|sanitizer|fuzz|invariant)\b')
    }
    'observability' {
      return ($d -match '(?i)\b(log|metric|trace|correlat|observ)\b')
    }
    'data-migration' {
      return ($d -match '(?i)\b(idempot|re-?run|rollback|dual[- ]?read|dual[- ]?write|compatible)\b')
    }
    default { return $false }
  }
}

function Get-PrincipleReview([string]$Id) {
  $p = Get-Principle $Id
  if (-not $p) { return $null }
  return @{
    id        = [string]$p.id
    name      = [string]$p.name
    statement = [string]$p.statement
    question  = [string]$p.question
    answer    = [string]$p.answer
  }
}
