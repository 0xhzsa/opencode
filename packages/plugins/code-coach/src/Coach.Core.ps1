# Coach.Core.ps1 - the judgment engine. Pure functions: no UI, no network, no disk.
# Everything here is called by the daemon AND by the tests, so no test can drift
# from shipped behaviour. Constructed cases test one rule each; real drafts judge quality.

$script:StopStems = @('the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'has',
                      'was', 'were', 'are', 'you', 'your', 'can', 'will', 'would', 'should',
                      'please', 'just', 'into', 'when', 'what', 'how', 'not', 'but', 'its',
                      'it''s', 'also', 'then', 'than', 'them', 'they', 'there', 'here')

$script:ChangeVerbs = '(?i)\b(fix|fixes|fixing|make|makes|making|improve|improves|improving|refactor\w*|rewrite|update|updates|updating|change|changes|changing|clean\s?up|handle|handles|handling|support|add|adds|adding|move|moves|rename|remove|removes|removing)\b'
$script:VagueQuality = '(?i)\b(better|reliable|reliability|robust|faster|cleaner|nice|good|proper|properly|solid|stable|smoother|snappier|works?\s+(right|correctly)|quality)\b'
$script:FailureWords = '(?i)\b(bug|bugs|broken|breaks|broke|fails?|failing|failed|error|errors|crash\w*|(doesn|don|didn|isn|won|can)''?t\s+(work|working|run|load|show|update|detect)|not\s+(work\w*|run\w*|load\w*|show\w*|update\w*|detect\w*)|wrong|issue|problem)\b'
$script:ExpectedWords = '(?i)\b(should|expect\w*|expected|instead|supposed to|want it to|needs? to|so that|goal|acceptance)\b'
$script:ErrorEvidence = '(?i)(```|`[^`]+`|Error:|Exception|Traceback|at\s+\w+\(|line\s+\d+|stderr|stdout|console|the log\b|logs?\s+(say|show)|stack|\b[45]\d\d\b)'
$script:PlaceMarkers = '(?i)(\.(ps1|js|mjs|ts|tsx|jsx|py|cs|go|rs|rb|php|java|kt|swift|json|ya?ml|toml|md|css|html|sql|sh|bat|cmd)\b|\b[a-z][\w\-]*\.(ps1|js|ts|py|cs|go|rs|json|md|css|html|sql)\b|\b(module|service|component|screen|page|route|endpoint|function|class|file|controller|handler|view|readme|changelog)\b)'
# Identifiers are case sensitive: inside the (?i) group every [A-Z] would also
# match a lowercase word and make "the export is broken" look like a named place.
$script:PlaceNames = '(\b[A-Z][a-z]+-[A-Z][A-Za-z0-9]*\b|\b[a-z][a-z0-9]*(_[a-z0-9]+)+\b|\b[a-z]+[A-Z][A-Za-z0-9]*\b)'

function Test-PlaceNamed([string]$Draft) {
  if ([string]$Draft -match $script:PlaceMarkers) { return $true }
  if ([string]$Draft -cmatch $script:PlaceNames) { return $true }
  return $false
}
$script:FailureStates = '(?i)\b(bug|bugs|broken|breaks|broke|crash\w*|freez\w*|hangs?|stuck|regress\w*|fails?|failing|failed|wrong|(doesn|don|didn|isn|won|can)''?t\s+(work|working|run|load|show|update|detect)|not\s+(work\w*|run\w*|load\w*|show\w*|update\w*|detect\w*))\b'

# A question is a request for information, not a patch. The card has nothing
# to add until the user asks for a change.
function Test-QuestionDraft([string]$Draft) {
  $d = ([string]$Draft).Trim()
  if (-not $d) { return $false }
  if ($d.EndsWith('?')) { return $true }
  return ($d -match '(?i)^\s*(why|how|what|where|when|who|which|can|could|should|would|is|are|does|do|did|has|have)\b')
}
$script:LimitWords = '(?i)\b(without|don''t|do not|keep|must|compat\w*|only|just|no breaking|backward|smallest|minimal|limit)\b'

# ---------------------------------------------------------------------------
# Gap taxonomy - one table. A gap fires only on evidence in the draft or the
# registered repo. Each row: consequence, lesson, guardrail addition, prior.
# The addition is one standalone sentence. The card appends it verbatim; it
# never rewrites the developer's words.
# ---------------------------------------------------------------------------
$script:GapRules = @(
  @{ id = 'outcome'
     prior = 0.35
     consequence = 'The model picks its own finish line and stops at the first plausible patch.'
     lesson = 'A request is done when you can tell afterward whether it was met.'
     addition = 'Before starting, state the exact behavior or number that proves the change worked.'
     mechanism = 'A change verb plus a word like "better" names no state to check, so the model substitutes its own idea of done.' }
  @{ id = 'target'
     prior = 0.30
     consequence = 'It searches the whole project and may edit the wrong place.'
     lesson = 'The model cannot see your screen; naming the place turns a search into a look.'
     addition = 'Before editing, name the file or screen; if it is still unclear, ask me.'
     mechanism = 'With no file, route or screen named, the model has to locate the code by keyword and often picks a neighbour.' }
  @{ id = 'observed-vs-expected'
     prior = 0.30
     consequence = 'It guesses which side to fix, and it may guess wrong.'
     lesson = 'A bug report is two facts: what happens now, and what should happen.'
     addition = 'State what happens now and what should happen instead before changing anything.'
     mechanism = 'With only one side of the bug stated, the model cannot tell whether the code or the expectation is wrong.' }
  @{ id = 'evidence'
     prior = 0.28
     consequence = 'It reasons about causes in general rather than the real one.'
     lesson = 'Exact error text cuts the search to a few lines.'
     addition = 'Reproduce the failure first and quote the exact error before editing.'
     mechanism = 'No error text means the model matches the symptom to its most common cause, not yours.' }
  @{ id = 'constraint'
     prior = 0.22
     consequence = 'It may rename or restructure things you would reject in review.'
     lesson = 'What you would reject in review is cheaper to say first.'
     addition = 'Do not rename public names or change the data shape without asking first.'
     mechanism = 'Touching an interface with no stated limits leaves the model free to change callers, names and shapes.' }
  @{ id = 'scope'
     prior = 0.25
     consequence = 'The diff grows past what you can review.'
     lesson = 'Unscoped asks produce unscoped diffs.'
     addition = 'Keep the change to the smallest set of files and list them before editing.'
     mechanism = 'A wide verb with no boundary lets the model improve neighbours you never asked about.' }
  @{ id = 'check'
     prior = 0.15
     consequence = 'You become the test.'
     lesson = 'Give it a check and it can verify its own work before you see it.'
     addition = 'Run the check that proves the change and show the command and result.'
     mechanism = 'With no command or expected output named, the model stops when the code looks right to it.' }
  @{ id = 'checkpoint'
     prior = 0.30
     consequence = 'There is no clean point to go back to.'
     lesson = 'Commit before an agent run so undo is one command.'
     addition = 'Do not start until the working tree is committed.'
     mechanism = 'A broad ask on a dirty tree turns one bad edit into a diff you cannot separate from your own work.' }
  @{ id = 'ref-check'
     prior = 0.35
     consequence = 'It invents or hunts for the missing name.'
     lesson = 'The model fills a missing name with a guess.'
     addition = 'Use only names that exist in the project; if a name is missing, say so instead of inventing one.'
     mechanism = 'A name that does not resolve becomes a plausible invention that looks right in the diff.' }
  @{ id = 'stuck'
     prior = 0.55
     consequence = 'Another near-identical attempt will probably fail the same way.'
     lesson = 'When the same ask fails twice, the model picture of the problem is wrong; change what it knows.'
     addition = 'Before changing code again, list the two most likely causes and the evidence for each.'
     mechanism = 'Similar retries resend the same context, so the model makes the same assumption again.' }
  @{ id = 'destructive'
     prior = 0.50
     consequence = 'This can destroy work that has no undo.'
     lesson = 'A checkpoint is cheaper than a restore.'
     addition = 'Name the exact target and confirm the working tree is committed before any destructive step.'
     mechanism = 'An irreversible verb with no checkpoint turns a bad guess into lost work.' }
)

function Get-GapRule([string]$Id) {
  foreach ($r in $script:GapRules) { if ($r.id -eq $Id) { return $r } }
  return $null
}

# One principle can own more than one gap. The learner stores mastery by
# principle as well as by gap, so a lesson learned in one surface fades the
# other surface too.
$script:GapPrinciple = @{
  'outcome'              = 'finish-line'
  'target'               = 'name-the-place'
  'observed-vs-expected' = 'both-sides'
  'evidence'             = 'evidence-first'
  'constraint'           = 'smallest-diff'
  'scope'                = 'smallest-diff'
  'check'                = 'verify'
  'checkpoint'           = 'checkpoint'
  'ref-check'            = 'name-the-place'
  'stuck'                = 'change-the-input'
  'destructive'          = 'checkpoint'
  'code-secret'          = 'secrets-out-of-source'
  'code-timeout'         = 'bounded-retries'
  'code-swallowed'       = 'errors-are-data'
  'code-retry'           = 'bounded-retries'
  'code-focus'           = 'focus-is-a-gift'
}

$script:GapLabels = @{
  'outcome'              = 'FINISH LINE'
  'target'               = 'PLACE'
  'observed-vs-expected' = 'SYMPTOM'
  'evidence'             = 'EVIDENCE'
  'constraint'           = 'CONSTRAINTS'
  'scope'                = 'SCOPE'
  'check'                = 'CHECK'
  'checkpoint'           = 'CHECKPOINT'
  'ref-check'            = 'NAMES'
  'stuck'                = 'RETRY'
  'destructive'          = 'IRREVERSIBLE'
  'code-secret'          = 'SECRET'
  'code-timeout'         = 'TIMEOUT'
  'code-swallowed'       = 'ERROR HANDLING'
  'code-retry'           = 'RETRY CAP'
  'code-focus'           = 'FOCUS'
}

function Get-GapLabel([string]$Id) {
  if ($script:GapLabels.ContainsKey($Id)) { return $script:GapLabels[$Id] }
  return ([string]$Id).ToUpperInvariant()
}

# ---------------------------------------------------------------------------
# Stems and grounding
# ---------------------------------------------------------------------------
function Get-Stem([string]$Word) {
  if ([string]::IsNullOrWhiteSpace($Word)) { return '' }
  $w = $Word.ToLowerInvariant()
  if ($w.Length -le 5) { return $w }
  return $w.Substring(0, 5)
}

function Get-ContentStems([string]$Text) {
  $out = New-Object System.Collections.ArrayList
  foreach ($m in [regex]::Matches($Text, "[A-Za-z][A-Za-z0-9_\-]{1,}")) {
    $w = $m.Value.ToLowerInvariant()
    if ($script:StopStems -contains $w) { continue }
    $s = Get-Stem $w
    if ($s -and -not ($out -contains $s)) { [void]$out.Add($s) }
  }
  return $out
}

function Get-Numbers([string]$Text) {
  $out = New-Object System.Collections.ArrayList
  foreach ($m in [regex]::Matches($Text, '(?<!\d)\d+(?:[.,]\d+)?(?!\d)')) { [void]$out.Add($m.Value) }
  return $out
}

function Test-Grounded([string]$Item, [string]$Draft) {
  if ([string]::IsNullOrWhiteSpace($Item)) { return $false }
  $itemStems = @(Get-ContentStems $Item)
  if ($itemStems.Count -eq 0) { return $false }
  $draftStems = @(Get-ContentStems $Draft)
  $hit = 0
  foreach ($s in $itemStems) { if ($draftStems -contains $s) { $hit++ } }
  if (($hit / $itemStems.Count) -lt 0.60) { return $false }
  foreach ($n in @(Get-Numbers $Item)) {
    if ($Draft -notmatch ('(?<!\d)' + [regex]::Escape($n) + '(?!\d)')) { return $false }
  }
  return $true
}

function Get-WordSet([string]$Text) {
  $set = @{}
  foreach ($m in [regex]::Matches($Text.ToLowerInvariant(), '[a-z][a-z0-9_\-]{1,}')) {
    if ($script:StopStems -contains $m.Value) { continue }
    $set[(Get-Stem $m.Value)] = $true
  }
  return $set
}

function Get-Similarity([string]$A, [string]$B) {
  $sa = Get-WordSet $A
  $sb = Get-WordSet $B
  if ($sa.Count -eq 0 -or $sb.Count -eq 0) { return 0.0 }
  $inter = 0
  foreach ($k in $sa.Keys) { if ($sb.ContainsKey($k)) { $inter++ } }
  $union = $sa.Count + $sb.Count - $inter
  if ($union -eq 0) { return 0.0 }
  return [math]::Round($inter / $union, 3)
}

# ---------------------------------------------------------------------------
# Gap detection. Each returns $null or a hashtable with evidence.
# ---------------------------------------------------------------------------
function Find-Gaps([string]$Draft, $Ctx) {
  $gaps = New-Object System.Collections.ArrayList
  if ([string]::IsNullOrWhiteSpace($Draft)) { return $gaps }
  $d = $Draft.Trim()
  $words = @([regex]::Matches($d, '\S+')).Count
  $ctx = if ($Ctx) { $Ctx } else { @{} }

  # Context fills a slot only when the fact is actually present. This is what
  # lets "make it reliable" be a different request on turn 2: the file, error,
  # check and constraint from the earlier turns are already in the digest.
  $ctxFiles = @(Get-CtxList $ctx 'Files')
  $ctxErrors = @(Get-CtxList $ctx 'Errors')
  $ctxTests = @(Get-CtxList $ctx 'Tests')
  $ctxSuccess = @(Get-CtxList $ctx 'Success')
  $ctxConstraints = @(Get-CtxList $ctx 'Constraints')
  $ctxAttempts = 0
  $a = Get-CtxValue $ctx 'Attempts'
  if ($a -ne $null) { $ctxAttempts = [int]$a }
  $hasTarget = (Test-PlaceNamed $d) -or ($ctxFiles.Count -gt 0)
  $hasEvidence = ($d -match $script:ErrorEvidence) -or ($ctxErrors.Count -gt 0)
  $hasExpected = ($d -match $script:ExpectedWords) -or ($ctxSuccess.Count -gt 0)
  $hasCheck = ($d -match '(?i)(\btest\w*\b|\bspec\b|\bnpm\b|\bpytest\b|\bgo test\b|\bdotnet\b|\brun\b|\bcheck\b|\bverify\b|\bexpected\b|\bshould\b|\bassert\w*\b|\bpasses?\b)') -or ($ctxTests.Count -gt 0)
  $hasLimits = ($d -match $script:LimitWords) -or ($ctxConstraints.Count -gt 0)

  if (($d -match $script:ChangeVerbs) -and ($d -match $script:VagueQuality) -and
      (-not ($d -match '\d')) -and (-not $hasExpected)) {
    [void]$gaps.Add(@{ id = 'outcome'; evidence = 'a change verb with no state or number to check' })
  }

  if (($d -match $script:FailureWords -or $d -match $script:ChangeVerbs) -and
      (-not $hasTarget)) {
    [void]$gaps.Add(@{ id = 'target'; evidence = 'no file, function, route or screen named' })
  }

  if (($d -match $script:FailureStates) -and (-not $hasExpected)) {
    [void]$gaps.Add(@{ id = 'observed-vs-expected'; evidence = 'only the failing side is stated' })
  }

  if (($d -match $script:FailureStates) -and (-not $hasEvidence)) {
    [void]$gaps.Add(@{ id = 'evidence'; evidence = 'no error text, log line or steps' })
  }

  if (($d -match '(?i)\b(dependency|dependencies|package|schema|api|interface|rename|upgrade|migrat\w*|public|signature|contract|tsconfig|build)\b') -and
      (-not $hasLimits)) {
    [void]$gaps.Add(@{ id = 'constraint'; evidence = 'touches an interface with no stated limits' })
  }

  if (($d -match '(?i)\b(refactor\w*|rewrite|reorganize|modernize|clean\s?up|update everywhere|across the (codebase|project)|all files|everywhere)\b') -and
      (-not $hasTarget) -and (-not $hasLimits)) {
    [void]$gaps.Add(@{ id = 'scope'; evidence = 'a wide verb with no boundary' })
  }

  if ($words -ge 5 -and ($d -match $script:ChangeVerbs) -and (-not $hasCheck)) {
    [void]$gaps.Add(@{ id = 'check'; evidence = 'no command or expected output named' })
  }

  $uncommitted = Get-CtxValue $ctx 'UncommittedFiles'
  $broadAsk = Get-CtxValue $ctx 'BroadAsk'
  if ($uncommitted -ne $null -and $broadAsk -ne $null) {
    if ([int]$uncommitted -ge 20 -and [bool]$broadAsk) {
      [void]$gaps.Add(@{ id = 'checkpoint'; evidence = ('{0} uncommitted files before a broad ask' -f [int]$uncommitted) })
    }
  }

  $missingNames = @(Get-CtxList $ctx 'MissingNames')
  if ($missingNames.Count -gt 0) {
    [void]$gaps.Add(@{ id = 'ref-check'; evidence = ('not in the project: ' + ($missingNames -join ', ')) })
  }

  if ($ctxAttempts -ge 2) {
    [void]$gaps.Add(@{ id = 'stuck'; evidence = ('attempt {0} of a near-identical ask' -f ($ctxAttempts + 1)) })
  }

  # Irreversible asks get a checkpoint card even on a continuation. The verbs
  # only count when they name data, files, history or a whole repo; deleting a
  # single unused import is a normal edit, not a checkpoint moment.
  if (Test-DestructiveAsk $d) {
    [void]$gaps.Add(@{ id = 'destructive'; evidence = 'an irreversible action with no checkpoint or dry run' })
  }

  return $gaps
}

# One place decides whether an ask is actually destructive, so the prompt
# compiler and the gap detector cannot disagree. "Clean that up" about code is
# not a reason to tell someone to snapshot their database.
function Test-DestructiveAsk([string]$Draft) {
  $d = ([string]$Draft)
  if ([string]::IsNullOrWhiteSpace($d)) { return $false }
  $hardDestructive = '(?i)\b(rm\s+-rf|git\s+clean|force[- ]?push|uninstall\w*|nuke\w*)\b'
  $destructiveVerb = '(?i)\b(delete|deletes|deleting|reset|resets|resetting|revert|reverts|reverting|drop|drops|dropping|truncate|truncates|truncating|overwrite|overwrites|overwriting|wipe|wipes|wiping|purge|purges|purging|destroy|destroys|destroying|remove|removes|removing|clean\s?up|cleanup|clear|clears|clearing)\b'
  $destructiveObject = '(?i)\b(files?|folders?|directories?|dirs?|data|database|db|tables?|rows?|records?|logs?|history|branch(es)?|commits?|repo(sitory)?|worktree|build|output|cache|config|credentials?|secrets?|disk|drive|migrations?|migration folder)\b'
  $destructiveBroad = '(?i)\b(all|everything)\b'
  $destructiveGuard = '(?i)\b(backup|backed up|committed|commit first|commit before|commit the current|dry[- ]?run|dry run|confirm|confirmed|only|specific|exact|this file|one file|snapshot)\b'
  $namedPlace = Test-PlaceNamed $d
  $concreteTarget = ($d -match $destructiveObject)
  $broadTarget = ($d -match $destructiveBroad) -and (-not $namedPlace)
  return [bool]((($d -match $hardDestructive) -or
       (($d -match $destructiveVerb) -and ($concreteTarget -or $broadTarget))) -and
      (-not ($d -match $destructiveGuard)))
}

# ---------------------------------------------------------------------------
# Mechanism reference: these explain the consequence behind a gap. The card
# appends the gap addition, not these clauses.
# ---------------------------------------------------------------------------
$script:Mechanisms = @(
  @{ re = '(?i)\b(retry|retries|backoff|re-?tr(y|ied|ying))\w*\b'
     clause = 'cap the attempts, add jitter, and only retry calls that are safe to repeat'
     consequence = 'A retry of a call that is not idempotent duplicates its side effect.'
     lesson = 'Retries with no cap come back in lockstep, so the busiest moment gets a storm of the same failed call.' }
  @{ re = '(?i)\b(poll\w*|tick\w*|interval|watcher|listener|every\s+\d+\s*(ms|s|sec|secs|second|seconds|min|mins|minute|minutes))\b'
     clause = 'name the signal it watches, how often it samples, and what happens when a sample is missed'
     consequence = 'A watcher with no sampling bound has a blind window, and the bug reads as random.'
     lesson = 'The case you care about lands inside the gap between samples.' }
  @{ re = '(?i)\b(cach(e|ed|ing)\w*|memo\w*)\b'
     clause = 'state how the cache is invalidated and how large it can grow'
     consequence = 'A cache with no invalidation rule serves yesterday''s answer forever.'
     lesson = 'A stale hit looks exactly like a logic bug, which is why it costs a round trip to find.' }
  @{ re = '(?i)\b(regex\w*|pars(e|er|ed|ing)\w*|extract\w*|split\w*)\b'
     clause = 'run the parser against empty, huge, unicode and trailing-space input before calling it done'
     consequence = 'A parser tested on one happy input breaks on the first real-world string.'
     lesson = 'The string that breaks it is usually the one a user pastes.' }
  @{ re = '(?i)\b(delet(e|ed|ing|ion)\w*|remov(e|ed|ing|al)\w*|purg(e|ed|ing)\w*|cleanup|drop\w*)\b'
     clause = 'say exactly what gets deleted, prove it on a dry run, and name what must survive'
     consequence = 'The first wrong glob removes data no test can restore.'
     lesson = 'An irreversible delete with no dry run has no undo to fall back on.' }
  @{ re = '(?i)\b(migrat\w*|backfill\w*|schema\w*)\b'
     clause = 'make the migration safe to re-run and give it a rollback path'
     consequence = 'A partial migration cannot be retried safely.'
     lesson = 'A migration with no rollback leaves the database in a state no test covers.' }
  @{ re = '(?i)\b(auth\w*|token\w*|secret\w*|password\w*|credential\w*|api\s?key)\b'
     clause = 'keep the secret out of logs and prompts, and say when it expires'
     consequence = 'Secrets leak through logs and prompts first, long before auth fails.'
     lesson = 'By the time the failure shows, the credential is already in history.' }
  @{ re = '(?i)\b(concurren\w*|async\w*|thread\w*|rac(e|es|ing)\b|queue\w*|parallel\w*|worker\w*)\b'
     clause = 'say what happens on duplicate delivery and in what order the work runs'
     consequence = 'Two workers with no ordering rule double-apply the change.'
     lesson = 'It shows up as a crash under load, never in the unit test.' }
  @{ re = '(?i)\b(atomic\w*|persist\w*|save to disk|write to disk|read from disk|fsync|flush\w*)\b'
     clause = 'write atomically and say what a half-written file does on the next read'
     consequence = 'A crash mid-write leaves half a file that reads as corruption.'
     lesson = 'A temp file plus a rename is the whole fix, and it is cheaper before the crash than after.' }
  @{ re = '(?i)\b(api|https?|request\w*|endpoint\w*|webhook\w*|fetch\w*)\b'
     clause = 'give the call a timeout, a cost cap, and a fallback when it fails'
     consequence = 'One call with no timeout stalls the whole loop.'
     lesson = 'With no cap the bill spikes before the bug is visible.' }
  @{ re = '(?i)\b((?!windows\b)window\w*|overlay\w*|wpf|xaml|dpi|focus\w*|screen\w*|ui)\b'
     clause = 'never take keyboard focus, and keep the window inside the screen at any DPI'
     consequence = 'A helper window that steals focus breaks the typing it was meant to help.'
     lesson = 'The fastest way to be uninstalled is to interrupt the person you are helping.' }
  @{ re = '(?i)\b(performance|slow\w*|latenc\w*|faster|optimi[sz]\w*|speed\w*)\b'
     clause = 'measure a baseline first, name the target number, and keep the before and after'
     consequence = 'Without a baseline "faster" cannot be measured.'
     lesson = 'A regression you cannot measure ships unnoticed.' }
)

function Find-Mechanisms([string]$Draft) {
  $out = New-Object System.Collections.ArrayList
  if ([string]::IsNullOrWhiteSpace($Draft)) { return $out }
  $pos = 0
  foreach ($m in $script:Mechanisms) {
    $match = [regex]::Match($Draft, $m.re)
    if ($match.Success) {
      [void]$out.Add(@{ index = $match.Index; clause = $m.clause; consequence = $m.consequence; lesson = $m.lesson })
    }
    $pos++
  }
  return @($out | Sort-Object { $_.index })
}

function Build-Guardrail([string]$Draft, [string]$Addition) {
  $d = $Draft.Trim()
  if ([string]::IsNullOrWhiteSpace($Addition)) { return $d }
  return ($d + "`n`nGuardrail: " + $Addition.Trim())
}

# ---------------------------------------------------------------------------
# Faithfulness. A guardrail that loses a number or a named thing is rejected.
# ---------------------------------------------------------------------------
function Test-GuardrailFaithful([string]$Draft, [string]$Guardrail) {
  if ([string]::IsNullOrWhiteSpace($Guardrail)) { return @{ ok = $false; why = 'empty' } }

  if ($Guardrail.Length -gt ([math]::Max(220, $Draft.Length * 3))) {
    return @{ ok = $false; why = 'too-long' }
  }
  if ($Guardrail -match '(?i)(<task>|</task>|<requirements>|^\s*(task|requirements|context|role)\s*:|\bas an ai\b)') {
    return @{ ok = $false; why = 'label-syntax' }
  }

  foreach ($n in @(Get-Numbers $Draft)) {
    if ($Guardrail -notmatch ('(?<!\d)' + [regex]::Escape($n) + '(?!\d)')) {
      return @{ ok = $false; why = ('number-lost:' + $n) }
    }
  }

  $draftStems = @(Get-ContentStems $Draft)
  $guardrailStems = @(Get-ContentStems $Guardrail)
  if ($draftStems.Count -gt 0) {
    $hit = 0
    foreach ($s in $draftStems) { if ($guardrailStems -contains $s) { $hit++ } }
    $keep = $hit / $draftStems.Count
    if ($keep -lt 0.60) { return @{ ok = $false; why = ('low-retention:{0:N2}' -f $keep) } }
  }

  foreach ($m in [regex]::Matches($Draft, '`[^`]+`')) {
    if ($Guardrail.IndexOf($m.Value, [StringComparison]::Ordinal) -lt 0) {
      return @{ ok = $false; why = 'specific-lost' }
    }
  }

  return @{ ok = $true; why = 'ok' }
}

# ---------------------------------------------------------------------------
# Cost gating. Hold only when expected savings beat the interruption.
# ---------------------------------------------------------------------------
function Get-ContextFilled([string]$Draft, $Ctx) {
  $d = [string]$Draft
  if (-not $Ctx) { return @{} }
  return @{
    target      = ((-not (Test-PlaceNamed $d)) -and (@(Get-CtxList $Ctx 'Files').Count -gt 0))
    evidence    = ((-not ($d -match $script:ErrorEvidence)) -and (@(Get-CtxList $Ctx 'Errors').Count -gt 0))
    success     = ((-not ($d -match $script:ExpectedWords)) -and (@(Get-CtxList $Ctx 'Success').Count -gt 0))
    check       = ((-not ($d -match '(?i)(\btest\w*\b|\bspec\b|\bnpm\b|\bpytest\b|\bgo test\b|\bdotnet\b|\brun\b|\bcheck\b|\bverify\b|\bexpected\b|\bshould\b|\bassert\w*\b|\bpasses?\b)')) -and (@(Get-CtxList $Ctx 'Tests').Count -gt 0))
    constraints = ((-not ($d -match $script:LimitWords)) -and (@(Get-CtxList $Ctx 'Constraints').Count -gt 0))
  }
}

function Get-HoldDecision {
  param(
    [Parameter(Mandatory = $true)][string]$Draft,
    $Ctx,
    $Learner,
    [double]$SecondsPerReprompt = 45.0,
    [double]$BaseInterruptionSeconds = 10.0
  )

  $ctx = if ($Ctx) { $Ctx } else { @{} }
  $ctxFilled = Get-ContextFilled $Draft $ctx
  if (Test-QuestionDraft $Draft) {
    return @{
      hold = $false; gapId = $null; gaps = @(); consequence = $null; lesson = $null
      addition = $null; guardrail = $null; faithful = $null; score = $null; terms = $null; mechanism = $null
      ctxFilled = $ctxFilled; principle = $null
    }
  }
  $gaps = Find-Gaps $Draft $ctx
  $mech = Find-Mechanisms $Draft

  $scored = New-Object System.Collections.ArrayList
  foreach ($g in $gaps) {
    $rule = Get-GapRule $g.id
    $prior = [double]$rule.prior
    $principleId = $null
    if ($script:GapPrinciple.ContainsKey($g.id)) { $principleId = [string]$script:GapPrinciple[$g.id] }
    if ($Learner -and $Learner.mastery -and $Learner.mastery.ContainsKey($g.id)) {
      $mastery = [double]$Learner.mastery[$g.id]
      $prior = $prior * (1.0 - [math]::Min(0.8, $mastery * 0.8))
    }
    # Principle mastery is the same lesson seen through another gap. Take the
    # stronger of the two so a lesson learned in the code lane fades the prompt.
    if ($principleId -and $Learner -and $Learner.principles -and $Learner.principles.ContainsKey($principleId)) {
      $pm = [double]$Learner.principles[$principleId]
      $prior = $prior * (1.0 - [math]::Min(0.8, $pm * 0.8))
    }
    $interrupt = $BaseInterruptionSeconds
    if ($Learner) {
      if ($Learner.dismissals -and $Learner.dismissals.ContainsKey($g.id)) {
        $interrupt += [double]$Learner.dismissals[$g.id] * 2.0
      }
      if ($Learner.accepts -and $Learner.accepts.ContainsKey($g.id)) {
        $interrupt -= [double]$Learner.accepts[$g.id] * 1.0
      }
    }
    if ($interrupt -lt 4.0) { $interrupt = 4.0 }
    if ($interrupt -gt 60.0) { $interrupt = 60.0 }

    $expected = $prior * $SecondsPerReprompt
    $score = $expected - $interrupt
    [void]$scored.Add(@{
      id = $g.id
      evidence = $g.evidence
      prior = [math]::Round($prior, 3)
      expected = [math]::Round($expected, 2)
      interrupt = [math]::Round($interrupt, 2)
      score = [math]::Round($score, 2)
      consequence = $rule.consequence
      lesson = $rule.lesson
      mechanism = $rule.mechanism
      addition = [string]$rule.addition
      principle = $principleId
    })
  }

  $best = $null
  foreach ($s in $scored) { if ($best -eq $null -or $s.score -gt $best.score) { $best = $s } }

  $hold = ($best -ne $null) -and ($best.score -gt 0)
  $addition = $null
  $guardrail = $null
  $faithful = $null
  if ($hold) {
    $addition = [string]$best.addition
    if ($addition) {
      $guardrail = Build-Guardrail $Draft $addition
      $faithful = Test-GuardrailFaithful $Draft $guardrail
      if (-not $faithful.ok) {
        # Never show a card whose only action cannot be applied faithfully.
        $hold = $false
        $addition = $null
        $guardrail = $null
      }
    } else {
      $hold = $false
    }
  }

  $consequence = $null
  if ($best) { $consequence = $best.consequence }

  $lesson = $null
  if ($best) { $lesson = $best.lesson }

  return @{
    hold = $hold
    gapId = if ($best) { $best.id } else { $null }
    gaps = $scored
    consequence = $consequence
    lesson = $lesson
    addition = $addition
    guardrail = $guardrail
    faithful = $faithful
    score = if ($best) { $best.score } else { $null }
    terms = if ($best) { @{ prior = $best.prior; expected = $best.expected; interrupt = $best.interrupt } } else { $null }
    mechanism = if ($mech.Count -gt 0) { $mech[0].clause } else { $null }
    principle = if ($best) { $best.principle } else { $null }
    ctxFilled = $ctxFilled
  }
}
