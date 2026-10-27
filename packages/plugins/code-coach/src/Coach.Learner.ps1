# Coach.Learner.ps1 - mastery, fading and lesson rotation.
#
# Two signals, deliberately separate:
#   dismiss  -> "I already know this": mastery up, interruption cost up
#   accept   -> "I needed this":       mastery down
#   send unchanged after a hold -> small mastery up (they read it and disagreed)
#
# Three dismissals in a row quiet that gap for a week. Quiet is stored with an
# expiry so the coach comes back on its own rather than staying mute forever.

function New-LearnerState {
  return @{
    version     = 2
    mastery     = @{}
    dismissals  = @{}
    accepts     = @{}
    streak      = @{}
    shown       = @{}
    quietUntil  = @{}
    lessonIndex = @{}
    principles  = @{}
    tags        = @{}
    updated     = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  }
}

function ConvertTo-HashtableDeep($Object) {
  if ($null -eq $Object) { return $null }
  if ($Object -is [string]) { return $Object }
  if ($Object -is [System.Collections.IDictionary]) {
    $h = @{}
    foreach ($k in $Object.Keys) { $h[[string]$k] = ConvertTo-HashtableDeep $Object[$k] }
    return $h
  }
  if ($Object -is [pscustomobject]) {
    $h = @{}
    foreach ($p in $Object.PSObject.Properties) { $h[$p.Name] = ConvertTo-HashtableDeep $p.Value }
    return $h
  }
  if ($Object -is [System.Collections.IEnumerable]) {
    return @($Object | ForEach-Object { ConvertTo-HashtableDeep $_ })
  }
  return $Object
}

function Get-LearnerState {
  $raw = Read-JsonFile $script:LearnerPath
  $state = New-LearnerState
  if (-not $raw) { return $state }
  $h = ConvertTo-HashtableDeep $raw
  foreach ($k in @('mastery', 'dismissals', 'accepts', 'streak', 'shown', 'quietUntil', 'lessonIndex', 'principles', 'tags')) {
    if ($h.ContainsKey($k) -and $h[$k] -is [System.Collections.IDictionary]) { $state[$k] = $h[$k] }
  }
  if ($h.ContainsKey('updated')) { $state.updated = $h.updated }
  return $state
}

function Save-LearnerState($State) {
  $State.updated = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  Write-JsonAtomic $script:LearnerPath $State
}

function Get-GapQuietUntil($State, [string]$GapId) {
  if (-not $State.quietUntil.ContainsKey($GapId)) { return $null }
  try { return [DateTimeOffset]::Parse([string]$State.quietUntil[$GapId]) } catch { return $null }
}

function Test-GapQuiet($State, [string]$GapId) {
  $until = Get-GapQuietUntil $State $GapId
  if (-not $until) { return $false }
  return ($until -gt [DateTimeOffset]::UtcNow)
}

function Set-GapQuiet($State, [string]$GapId, [int]$Days = 7) {
  $State.quietUntil[$GapId] = [DateTimeOffset]::UtcNow.AddDays($Days).ToString('o')
}

function Update-LearnerState {
  param(
    [Parameter(Mandatory = $true)]$State,
    [Parameter(Mandatory = $true)][string]$GapId,
    [Parameter(Mandatory = $true)][ValidateSet('shown', 'accepted', 'copied', 'dismissed', 'sent_unchanged')][string]$Action
  )

  $m = if ($State.mastery.ContainsKey($GapId)) { [double]$State.mastery[$GapId] } else { 0.0 }
  $streak = if ($State.streak.ContainsKey($GapId)) { [int]$State.streak[$GapId] } else { 0 }
  if (-not $State.shown.ContainsKey($GapId)) { $State.shown[$GapId] = 0 }
  if (-not $State.dismissals.ContainsKey($GapId)) { $State.dismissals[$GapId] = 0 }
  if (-not $State.accepts.ContainsKey($GapId)) { $State.accepts[$GapId] = 0 }
  if (-not $State.lessonIndex.ContainsKey($GapId)) { $State.lessonIndex[$GapId] = 0 }

  switch ($Action) {
    'shown' {
      $State.shown[$GapId] = [int]$State.shown[$GapId] + 1
      $State.lessonIndex[$GapId] = ([int]$State.lessonIndex[$GapId] + 1) % 3
    }
    'accepted' {
      $State.accepts[$GapId] = [int]$State.accepts[$GapId] + 1
      $m = [math]::Max(0.0, $m - 0.10)
      $streak = 0
    }
    'copied' {
      $State.accepts[$GapId] = [int]$State.accepts[$GapId] + 1
      $m = [math]::Max(0.0, $m - 0.05)
      $streak = 0
    }
    'dismissed' {
      $State.dismissals[$GapId] = [int]$State.dismissals[$GapId] + 1
      $m = [math]::Min(1.0, $m + 0.06)
      $streak = $streak + 1
      if ($streak -ge 3) {
        Set-GapQuiet $State $GapId 7
        $streak = 0
        Write-TraceEvent 'learner_quiet' @{ gap = $GapId; days = 7 }
      }
    }
    'sent_unchanged' {
      $m = [math]::Min(1.0, $m + 0.03)
      $streak = 0
    }
  }

  $State.mastery[$GapId] = [math]::Round($m, 3)
  $State.streak[$GapId] = $streak
  return $State
}

# Principle mastery is the same lesson across surfaces. A code finding and a
# vague prompt can both teach "verify"; applying either should fade the other.
function Update-PrincipleState {
  param(
    [Parameter(Mandatory = $true)]$State,
    [Parameter(Mandatory = $true)][string]$PrincipleId,
    [Parameter(Mandatory = $true)][ValidateSet('shown', 'accepted', 'copied', 'dismissed', 'applied', 'retained', 'review_pass', 'review_fail')][string]$Action
  )
  if (-not $State.principles.ContainsKey($PrincipleId)) {
    $State.principles[$PrincipleId] = @{
      mastery      = 0.0
      shown        = 0
      accepted     = 0
      applied      = 0
      retained     = 0
      streak       = 0
      lastSeen     = $null
      dueAt        = $null
      intervalDays = 1
    }
  }
  $p = $State.principles[$PrincipleId]
  $m = [double]$p.mastery
  $now = [DateTimeOffset]::UtcNow
  $p.lastSeen = $now.ToString('o')

  switch ($Action) {
    'shown' {
      $p.shown = [int]$p.shown + 1
      if (-not $p.dueAt) { $p.dueAt = $now.AddDays(1).ToString('o'); $p.intervalDays = 1 }
    }
    'accepted' {
      $p.accepted = [int]$p.accepted + 1
      $m = [math]::Max(0.0, $m - 0.10)
      $p.streak = 0
      $p.intervalDays = 1
      $p.dueAt = $now.AddDays(1).ToString('o')
    }
    'copied' {
      $p.accepted = [int]$p.accepted + 1
      $m = [math]::Max(0.0, $m - 0.05)
      $p.intervalDays = 1
      $p.dueAt = $now.AddDays(1).ToString('o')
    }
    'dismissed' {
      $m = [math]::Min(1.0, $m + 0.06)
      $p.streak = [int]$p.streak + 1
      if ([int]$p.streak -ge 3) {
        $p.intervalDays = 7
        $p.dueAt = $now.AddDays(7).ToString('o')
        $p.streak = 0
      } else {
        $p.intervalDays = 1
        $p.dueAt = $now.AddDays(1).ToString('o')
      }
    }
    'applied' {
      $p.applied = [int]$p.applied + 1
      $m = [math]::Min(1.0, $m + 0.08)
      $p.streak = 0
    }
    'retained' {
      $p.retained = [int]$p.retained + 1
      $m = [math]::Min(1.0, $m + 0.10)
      $p.streak = 0
    }
    'review_pass' {
      $m = [math]::Min(1.0, $m + 0.15)
      $next = [int]$p.intervalDays * 2
      if ($next -lt 2) { $next = 2 }
      if ($next -gt 30) { $next = 30 }
      $p.intervalDays = $next
      $p.dueAt = $now.AddDays($next).ToString('o')
      $p.streak = 0
    }
    'review_fail' {
      $m = [math]::Max(0.0, $m - 0.10)
      $p.intervalDays = 1
      $p.dueAt = $now.AddDays(1).ToString('o')
      $p.streak = 0
    }
  }
  $p.mastery = [math]::Round($m, 3)
  return $State
}

function Get-PrincipleMastery($State, [string]$PrincipleId) {
  if (-not $State -or -not $State.principles -or -not $State.principles.ContainsKey($PrincipleId)) { return 0.0 }
  return [double]$State.principles[$PrincipleId].mastery
}

# Spaced review: weakest first, then oldest due. Only principles that have been
# seen and whose due time has passed are eligible. The tray can show one; the
# daemon never interrupts a send for a review.
function Get-DueReviews($State, [int]$Max = 3) {
  if (-not $State -or -not $State.principles) { return @() }
  $now = [DateTimeOffset]::UtcNow
  $out = New-Object System.Collections.ArrayList
  foreach ($id in $State.principles.Keys) {
    $p = $State.principles[$id]
    if (-not $p.dueAt) { continue }
    $due = $null
    try { $due = [DateTimeOffset]::Parse([string]$p.dueAt) } catch { $due = $null }
    if (-not $due -or $due -gt $now) { continue }
    $review = $null
    if (Get-Command Get-PrincipleReview -ErrorAction SilentlyContinue) { $review = Get-PrincipleReview ([string]$id) }
    if (-not $review) {
      $review = @{ id = [string]$id; name = [string]$id; statement = ''; question = ''; answer = '' }
    }
    $review.mastery = [double]$p.mastery
    $review.dueAt = [string]$p.dueAt
    [void]$out.Add($review)
  }
  return @($out | Sort-Object @{ Expression = { [double]$_.mastery }; Ascending = $true }, @{ Expression = { [string]$_.dueAt }; Ascending = $true } | Select-Object -First $Max)
}

# The shape Coach.Core expects: mastery lowers the prior, dismissals raise the cost.
# concept_tags are the learner profile's growth channel: each accepted or
# dismissed card teaches one tag, and the counts tell the triage prompt two
# things: skip a lesson the developer has already mastered, and when the same
# tag fires 3+ times, say so and raise the depth.
function Update-TriageTags($State, [string[]]$Tags, [ValidateSet('accepted', 'dismissed')][string]$Action) {
  if (-not $State) { return }
  if (-not $State.tags) { $State.tags = @{} }
  foreach ($tag in @($Tags)) {
    $t = ([string]$tag).Trim()
    if (-not $t) { continue }
    $cur = 0
    if ($State.tags.ContainsKey($t)) { $cur = [int]$State.tags[$t] }
    $State.tags[$t] = $cur + 1
  }
  Save-LearnerState $State
}

function Get-LearnerTriageProfile($State) {
  if (-not $State) { return $null }
  $tags = if ($State.tags) { $State.tags } else { @{} }
  return @{ mastery = $State.mastery; dismissals = $State.dismissals; accepts = $State.accepts; tags = $tags }
}

function Get-LearnerModifiers($State) {

  if (-not $State) { return $null }
  $mastery = @{}
  foreach ($k in $State.mastery.Keys) { $mastery[$k] = [double]$State.mastery[$k] }
  foreach ($k in @($State.quietUntil.Keys)) {
    if (Test-GapQuiet $State $k) { $mastery[$k] = 1.0 }
  }
  $principles = @{}
  if ($State.principles) {
    foreach ($k in $State.principles.Keys) { $principles[$k] = [double]$State.principles[$k].mastery }
  }
  return @{ mastery = $mastery; dismissals = $State.dismissals; accepts = $State.accepts; principles = $principles }
}

function Get-LearnerForCore($State, [string]$GapId) {
  if (-not $State) { return $null }
  $principles = @{}
  if ($State.principles) {
    foreach ($k in $State.principles.Keys) { $principles[$k] = [double]$State.principles[$k].mastery }
  }
  if (Test-GapQuiet $State $GapId) {
    return @{ mastery = @{ $GapId = 1.0 }; dismissals = $State.dismissals; accepts = $State.accepts; principles = $principles; quiet = $true }
  }
  return @{ mastery = $State.mastery; dismissals = $State.dismissals; accepts = $State.accepts; principles = $principles; quiet = $false }
}

function Get-NextLesson($State, [string]$GapId) {
  $idx = 0
  if ($State -and $State.lessonIndex.ContainsKey($GapId)) { $idx = [int]$State.lessonIndex[$GapId] }
  return (Get-LessonForm -GapId $GapId -Index $idx)
}

# Interruptions are capped per hour; a coach that fires eight times an hour gets muted.
# This used to re-read the entire trace on every gate decision. At the old
# build's 16,982 events that is ~1.8 s inside a 1.5 s verdict budget, so the
# coach failed open exactly when it had enough history to be useful. Card times
# are now kept in memory and pruned on read.
$script:CardTimes = New-Object System.Collections.Generic.List[datetime]

# Triage keeps its own list. It used to share CardTimes with the interruption
# cap, so six quiet gap cards silently ate the prompt lane's whole budget and a
# nudge ate a code-review slot. Two knobs, two lists: maxInterruptionsPerHour
# counts every card, triageMaxPerHour counts nudges. A nudge still counts as an
# interruption, which is why it is appended to both.
$script:TriageTimes = New-Object System.Collections.Generic.List[datetime]

function Add-CardTime([datetime]$At) {
  if ($At -eq [datetime]::MinValue) { $At = [datetime]::UtcNow }
  $script:CardTimes.Add($At)
}

function Add-TriageTime([datetime]$At) {
  if ($At -eq [datetime]::MinValue) { $At = [datetime]::UtcNow }
  $script:TriageTimes.Add($At)
}

function Test-HourlyBudget {
  param([int]$Max = 6)
  $cut = [datetime]::UtcNow.AddHours(-1)
  while ($script:CardTimes.Count -gt 0 -and $script:CardTimes[0] -lt $cut) {
    $script:CardTimes.RemoveAt(0)
  }
  return ($script:CardTimes.Count -lt $Max)
}

function Test-TriageBudget {
  param([int]$Max = 4)
  $cut = [datetime]::UtcNow.AddHours(-1)
  while ($script:TriageTimes.Count -gt 0 -and $script:TriageTimes[0] -lt $cut) {
    $script:TriageTimes.RemoveAt(0)
  }
  return ($script:TriageTimes.Count -lt $Max)
}

# One place decides what showing a card costs. A nudge is an interruption and
# spends both budgets; a gap card spends only the interruption budget; a
# rebuild (Explain why) is the same card and spends nothing. The daemon used to
# inline this, and the rebuild path quietly bought a second slot.
function Register-ShownCard([string]$Kind, [datetime]$At, [switch]$Rebuild) {
  if ($Rebuild) { return }
  if ($At -eq [datetime]::MinValue) { $At = [datetime]::UtcNow }
  Add-CardTime $At
  if ($Kind -eq 'nudge') { Add-TriageTime $At }
}

# Seed both lists from persisted state at boot. Only the last hour can affect a
# budget, so anything older is dropped on the way in rather than pruned later.
function Restore-BudgetTimes($CardTimes, $TriageTimes) {
  $cut = [datetime]::UtcNow.AddHours(-1)
  foreach ($raw in @($CardTimes)) {
    try {
      $at = [datetime]::Parse([string]$raw, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
      if ($at -ge $cut) { $script:CardTimes.Add($at) }
    } catch { }
  }
  foreach ($raw in @($TriageTimes)) {
    try {
      $at = [datetime]::Parse([string]$raw, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
      if ($at -ge $cut) { $script:TriageTimes.Add($at) }
    } catch { }
  }
  $script:CardTimes.Sort()
  $script:TriageTimes.Sort()
}
