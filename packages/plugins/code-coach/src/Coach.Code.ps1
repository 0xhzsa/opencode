# Coach.Code.ps1 - the code lane: deterministic scanners over files under roots
# the developer registered, applied to what changed since the last pass.
#
# Three rules keep this lane honest:
#   1. Nothing is read outside a registered root, and a reparse point is never
#      followed. No roots means no reads at all: the lane is opt-in.
#   2. A scanner is a regex over one line plus a short look-ahead for multi-line
#      statements. No model, no network, no spend, same answer twice.
#   3. A finding carries the flagged line for the card and nothing else. The
#      trace gets a path hash, the rule id and a line number - never the text.
#
# Known limit: a timeout set in a splat more than 12 lines above the call is not
# seen, so the http rule can fire on a request that already has one. That is the
# quiet failure mode: one wasted "add a timeout" instead of a missed one.

$script:CodeExtensions = @(
  '.ps1', '.psm1', '.psd1', '.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.cs', '.go', '.rs', '.java', '.kt', '.rb', '.sh', '.bash', '.sql',
  '.c', '.h', '.cpp', '.hpp'
)
$script:CodeExcludeDirs = @(
  '.git', 'node_modules', 'bin', 'obj', 'dist', 'build', 'out', 'target',
  '.venv', 'venv', 'env', '__pycache__', '.next', '.nuxt', 'coverage',
  'vendor', '.idea', '.vs', 'packages', '.cache', 'tmp'
)
$script:CodeMaxFileBytes = 524288
$script:CodeMaxBytesPerPass = 8388608
$script:CodeMaxDepth = 12
$script:CodeMaxFiles = 400
$script:CodeEvidenceChars = 160

# Single-quoted here-string: the pattern needs both quote characters, and
# doubling them inline is how the last one lost a parenthesis.
$script:CodeSecretPattern = @'
(?i)(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\bAKIA[0-9A-Z]{16}\b|\b(?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret|secret|password|passwd|pwd)\b\s*[:=]\s*["']([^"']{12,})["'])
'@

# ---------------------------------------------------------------------------
# Paths. A root is a directory the developer named; a file is in scope only if
# its full path is inside one of them, with the separator required so that
# "C:\work\app-other" is not inside "C:\work\app".
# ---------------------------------------------------------------------------
function Resolve-CodeFullPath([string]$Path) {
  if ([string]::IsNullOrWhiteSpace($Path)) { return $null }
  try { return [IO.Path]::GetFullPath($Path) } catch { return $null }
}

function Test-CodePathInside([string]$FilePath, [string]$Root) {
  $f = Resolve-CodeFullPath $FilePath
  $r = Resolve-CodeFullPath $Root
  if (-not $f -or -not $r) { return $false }
  $r = $r.TrimEnd('\', '/')
  $sep = [IO.Path]::DirectorySeparatorChar
  return $f.StartsWith(($r + $sep), [StringComparison]::OrdinalIgnoreCase)
}

function Resolve-CodeRoot([string]$Path) {
  $full = Resolve-CodeFullPath $Path
  if (-not $full) { return $null }
  if (-not (Test-Path -LiteralPath $full -PathType Container)) { return $null }
  return $full
}

function Test-CodePathExcluded([string]$Path, [string[]]$Excluded) {
  $p = Resolve-CodeFullPath $Path
  if (-not $p) { return $false }
  foreach ($x in @($Excluded)) {
    if ([string]::IsNullOrWhiteSpace($x)) { continue }
    $q = Resolve-CodeFullPath $x
    if (-not $q) { continue }
    if ($p.TrimEnd('\', '/') -eq $q.TrimEnd('\', '/')) { return $true }
    if (Test-CodePathInside $p $q) { return $true }
  }
  return $false
}

function Get-CodeScanTargets {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [DateTime]$SinceUtc = [DateTime]::MinValue,
    [string[]]$Extensions = $script:CodeExtensions,
    [int]$MaxFiles = 0,
    [string[]]$ExcludePaths
  )
  if ($MaxFiles -le 0) { $MaxFiles = $script:CodeMaxFiles }
  $out = New-Object System.Collections.ArrayList
  $queue = New-Object System.Collections.Queue
  $queue.Enqueue(@{ path = $Root; depth = 0 })

  while ($queue.Count -gt 0 -and $out.Count -lt $MaxFiles) {
    $d = $queue.Dequeue()
    if ($d.depth -gt $script:CodeMaxDepth) { continue }

    $dirs = @()
    try { $dirs = @(Get-ChildItem -LiteralPath $d.path -Directory -Force -ErrorAction Stop) } catch { $dirs = @() }
    foreach ($sub in $dirs) {
      if ($script:CodeExcludeDirs -contains $sub.Name.ToLowerInvariant()) { continue }
      if ($sub.Attributes -band [IO.FileAttributes]::ReparsePoint) { continue }
      if (Test-CodePathExcluded $sub.FullName $ExcludePaths) { continue }
      $queue.Enqueue(@{ path = $sub.FullName; depth = ($d.depth + 1) })
    }

    $files = @()
    try { $files = @(Get-ChildItem -LiteralPath $d.path -File -Force -ErrorAction Stop) } catch { $files = @() }
    foreach ($f in $files) {
      if ($out.Count -ge $MaxFiles) { break }
      if ($Extensions -notcontains $f.Extension.ToLowerInvariant()) { continue }
      if ($f.Attributes -band [IO.FileAttributes]::ReparsePoint) { continue }
      if (Test-CodePathExcluded $f.FullName $ExcludePaths) { continue }
      if ($SinceUtc -ne [DateTime]::MinValue -and $f.LastWriteTimeUtc -le $SinceUtc) { continue }
      if (-not (Test-CodePathInside $f.FullName $Root)) { continue }
      [void]$out.Add($f)
    }
  }
  return @($out | Sort-Object FullName)
}

# ---------------------------------------------------------------------------
# Reading. Oversize and binary files are skipped rather than guessed at.
# ---------------------------------------------------------------------------
function Read-CodeText([string]$Path) {
  try {
    $info = Get-Item -LiteralPath $Path -ErrorAction Stop
    if ($info.Length -gt $script:CodeMaxFileBytes) { return $null }
    if ($info.Length -eq 0) { return $null }
    $bytes = [IO.File]::ReadAllBytes($Path)
    $probe = [math]::Min($bytes.Length, 4096)
    for ($i = 0; $i -lt $probe; $i++) {
      if ($bytes[$i] -eq 0) { return $null }
    }
    $text = (New-Object Text.UTF8Encoding($false)).GetString($bytes)
    if ($text.Length -gt 0 -and [int]$text[0] -eq 0xFEFF) { $text = $text.Substring(1) }
    return $text
  } catch { return $null }
}

function Get-CodeShortLine([string]$Line) {
  $t = ([string]$Line).Trim()
  if ($t.Length -gt $script:CodeEvidenceChars) { $t = $t.Substring(0, $script:CodeEvidenceChars) + '...' }
  return $t
}

function Get-CodeMaskedLine([string]$Line, [string]$Secret) {
  $t = [string]$Line
  if ($Secret -and $Secret.Length -ge 4) { $t = $t.Replace($Secret, '***') }
  return (Get-CodeShortLine $t)
}

function Get-CodeHash([string]$Text) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes([string]$Text))
    $hex = -join ($bytes | ForEach-Object { $_.ToString('x2') })
    return $hex.Substring(0, 16)
  } finally { $sha.Dispose() }
}

# Findings already shown, keyed by rule + file + line, persisted so a daemon
# restart does not re-card something the developer has already seen. Timestamps
# are epoch seconds; anything older than the repeat window is dropped on load.
function Read-CodeSeen([string]$Path, [double]$RepeatHours = 24) {
  $map = @{}
  if (-not $Path) { return $map }
  $raw = Read-JsonFile $Path
  if (-not $raw) { return $map }
  if ($RepeatHours -le 0) { $RepeatHours = 24 }
  $cutoff = [DateTime]::UtcNow.AddHours(-$RepeatHours)
  foreach ($p in $raw.PSObject.Properties) {
    $t = [long]$p.Value
    if ($t -le 0) { continue }
    try { $at = [DateTimeOffset]::FromUnixTimeSeconds($t).UtcDateTime } catch { continue }
    if ($at -lt $cutoff) { continue }
    $map[[string]$p.Name] = $at
  }
  return $map
}

function Save-CodeSeen([string]$Path, $Map, [double]$RepeatHours = 24) {
  if (-not $Path) { return }
  if ($RepeatHours -le 0) { $RepeatHours = 24 }
  $cutoff = [DateTime]::UtcNow.AddHours(-$RepeatHours)
  $out = @{}
  if ($Map) {
    foreach ($k in @($Map.Keys)) {
      $v = $Map[$k]
      if ($v -isnot [DateTime]) { continue }
      if ($v -lt $cutoff) { continue }
      $out[[string]$k] = ([DateTimeOffset]$v.ToUniversalTime()).ToUnixTimeSeconds()
    }
  }
  Write-JsonAtomic $Path $out
}

# ---------------------------------------------------------------------------
# The scanners. Each gets (line, all lines, index) and returns $null or
# @{ line = 1-based; evidence = masked, short }.
# ---------------------------------------------------------------------------
$script:CodeScanners = @(
  @{
    id = 'code-secret'
    mechanism = 7
    severity = 'high'
    requirement = 'Name where the secret lives, and prove it never reaches a log or a prompt'
    consequence = 'A key in source is a key in git history; rotating it later costs more than moving it now'
    followUp = 'That credential is written into the source. Read it from the environment instead, and make sure it never reaches a log or a prompt.'
    lesson = 'Secrets belong in the environment, not in the source tree.'
    run = {
      param($Line, $Lines, $i)
      $m = [regex]::Match($Line, $script:CodeSecretPattern)
      if (-not $m.Success) { return $null }
      $value = $m.Groups[1].Value
      if ($value -match '(?i)^(your|example|sample|placeholder|replace|changeme|dummy|x{4,}|<|\$\{|\$env|process\.env|os\.environ|%[A-Z_]+%)') { return $null }
      return @{ line = ($i + 1); evidence = (Get-CodeMaskedLine $Line $value) }
    }
  },
  @{
    id = 'code-timeout'
    mechanism = 10
    severity = 'medium'
    requirement = 'Name the timeout, the rate or cost cap, and the fallback when the call fails'
    consequence = 'One call with no timeout stalls the loop it runs in, and nothing tells you why'
    followUp = 'That request has no timeout. Add an explicit one and say what happens when it fires.'
    lesson = 'Every outbound call needs a timeout and a fallback.'
    run = {
      param($Line, $Lines, $i)
      if ($Line -notmatch '(?i)(Invoke-RestMethod|Invoke-WebRequest|\brequests\.(?:get|post|put|patch|delete|head)\s*\(|\bfetch\s*\(|\baxios\.|\burlopen\s*\(|\bhttp\.(?:Get|Post|Put|Delete)\w*\s*\()') { return $null }
      $end = [math]::Min($Lines.Count - 1, $i + 12)
      for ($k = $i; $k -le $end; $k++) {
        if ($Lines[$k] -match '(?i)(-TimeoutSec\b|\btimeout\s*[:=]|\bsignal\s*:|\bAbortSignal\b|\bClientTimeout\b|-maxtime\b)') { return $null }
      }
      return @{ line = ($i + 1); evidence = (Get-CodeShortLine $Line) }
    }
  },
  @{
    id = 'code-swallowed'
    mechanism = 8
    severity = 'medium'
    requirement = 'Say which failures are expected, and what the caller sees when one is not'
    consequence = 'A swallowed error turns a crash into a wrong answer, and the wrong answer is harder to find'
    followUp = 'That catch swallows the error. Log or rethrow it, and say which failures are expected.'
    lesson = 'An empty catch is a lie about what went wrong.'
    run = {
      param($Line, $Lines, $i)
      if ($Line -match '(?i)^\s*except\b[^:]*:\s*pass\s*$') { return @{ line = ($i + 1); evidence = (Get-CodeShortLine $Line) } }
      if ($Line -match '(?i)\bcatch\b[^{]*\{\s*\}\s*$') { return @{ line = ($i + 1); evidence = (Get-CodeShortLine $Line) } }
      if ($Line -match '(?i)\bcatch\b[^{]*\{\s*$') {
        $end = [math]::Min($Lines.Count - 1, $i + 2)
        for ($k = $i + 1; $k -le $end; $k++) {
          $n = ([string]$Lines[$k]).Trim()
          if ($n -eq '') { continue }
          if ($n -eq '}') { return @{ line = ($i + 1); evidence = (Get-CodeShortLine $Line) } }
          break
        }
      }
      return $null
    }
  },
  @{
    id = 'code-retry'
    mechanism = 1
    severity = 'medium'
    requirement = 'Name the retry budget, add jitter, and say which failures are retryable'
    consequence = 'An uncapped retry storms in lockstep and duplicates every side effect it repeats'
    followUp = 'That retry loop has no cap. Give it a maximum attempt count and a jittered delay.'
    lesson = 'A retry without a budget is a loop that waits for a bad day.'
    run = {
      param($Line, $Lines, $i)
      if ($Line -notmatch '(?i)(\bwhile\s*\(\s*\$?true\s*\)|\bwhile\s+True\s*:|\bfor\s*\(\s*;\s*;\s*\))') { return $null }
      $from = [math]::Max(0, $i - 8)
      for ($k = $from; $k -le $i; $k++) {
        if ($Lines[$k] -match '(?i)(\bmax[A-Za-z]*\b|\battempts?\s*[<>=]|\bbudget\b|retryLimit)') { return $null }
      }
      $end = [math]::Min($Lines.Count - 1, $i + 14)
      $sleep = $false
      $work = $false
      for ($k = $i + 1; $k -le $end; $k++) {
        if ($Lines[$k] -match '(?i)(Start-Sleep|\bsleep\s*\(|asyncio\.sleep|setTimeout|time\.sleep)') { $sleep = $true }
        if ($Lines[$k] -match '(?i)(Invoke-RestMethod|Invoke-WebRequest|\brequests\.|\bfetch\s*\(|\bcurl\b|WebClient|HttpClient)') { $work = $true }
      }
      if (-not ($sleep -and $work)) { return $null }
      return @{ line = ($i + 1); evidence = (Get-CodeShortLine $Line) }
    }
  },
  @{
    id = 'code-focus'
    mechanism = 11
    severity = 'high'
    requirement = 'State the focus behaviour, the DPI and multi-monitor bounds, and what happens off-screen'
    consequence = 'A helper window that steals focus breaks the typing it was meant to help'
    followUp = 'That call takes focus from whatever the developer is typing in. Show the window without activating it.'
    lesson = 'A window that never asked for focus cannot steal it.'
    run = {
      param($Line, $Lines, $i)
      if ($Line -notmatch '(?i)(\.Activate\s*\(\s*\)|\.Focus\s*\(\s*\)|SetForegroundWindow\s*\(|SetFocus\s*\()') { return $null }
      $from = [math]::Max(0, $i - 12)
      $to = [math]::Min($Lines.Count - 1, $i + 4)
      for ($k = $from; $k -le $to; $k++) {
        if ($Lines[$k] -match '(?i)(NOACTIVATE|ShowActivated\s*=\s*\$false|Focusable\s*=\s*\$false)') { return $null }
      }
      return @{ line = ($i + 1); evidence = (Get-CodeShortLine $Line) }
    }
  }
)

function New-CodeFinding {
  param($Scanner, [string]$File, [int]$Line, [string]$Evidence, $Symbol, [string]$TestFile)
  return @{
    rule = [string]$Scanner.id
    gapId = [string]$Scanner.id
    mechanism = [int]$Scanner.mechanism
    severity = [string]$Scanner.severity
    file = $File
    line = [int]$Line
    evidence = $Evidence
    requirement = [string]$Scanner.requirement
    consequence = [string]$Scanner.consequence
    followUp = [string]$Scanner.followUp
    lesson = [string]$Scanner.lesson
    symbol = $Symbol
    testFile = $TestFile
  }
}

# The nearest function/class above a finding turns "somewhere in this file" into
# a place a reviewer can open. It is a lexical hint, not a parser: the card says
# "inside <name>" only when the name is within 120 lines and looks like a
# declaration, and the code still carries the exact line.
function Get-CodeSymbol($Lines, [int]$Index) {
  if (-not $Lines -or $Index -lt 0) { return $null }
  $patterns = @(
    @{ kind = 'function'; re = '(?i)^\s*function\s+([A-Za-z_][\w-]*)' },
    @{ kind = 'function'; re = '(?i)^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)' },
    @{ kind = 'function'; re = '(?i)^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(' },
    @{ kind = 'function'; re = '(?i)^\s*def\s+([A-Za-z_][\w!?]*)' },
    @{ kind = 'function'; re = '(?i)^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)' },
    @{ kind = 'function'; re = '(?i)^\s*(?:pub\s+)?fn\s+([A-Za-z_][\w]*)' },
    @{ kind = 'class'; re = '(?i)^\s*(?:export\s+)?(?:public\s+|private\s+|internal\s+|abstract\s+|sealed\s+|static\s+)*class\s+([A-Za-z_][\w]*)' },
    @{ kind = 'method'; re = '(?i)^\s*(?:public|private|protected|internal|static|async|override|virtual|final)\s+[\w<>\[\],.?]+\s+([A-Za-z_][\w]*)\s*\(' }
  )
  $from = [math]::Max(0, $Index - 120)
  for ($i = $Index; $i -ge $from; $i--) {
    $line = [string]$Lines[$i]
    foreach ($p in $patterns) {
      $m = [regex]::Match($line, $p.re)
      if ($m.Success) {
        return @{ kind = [string]$p.kind; name = [string]$m.Groups[1].Value; line = ($i + 1) }
      }
    }
  }
  return $null
}

# A follow-up is only specific if it points at the test that should change.
# This repo names runners Run-<Module>.ps1; JS/Python/C# conventions are checked
# beside the file and under tests/. A miss returns $null, never a guess.
function Find-CodeTestFile([string]$Root, [string]$Rel) {
  if (-not $Root -or -not $Rel) { return $null }
  $full = Join-Path $Root $Rel
  $dir = Split-Path -Parent $full
  $base = [IO.Path]::GetFileNameWithoutExtension($full)
  $ext = [IO.Path]::GetExtension($full)
  $candidates = New-Object System.Collections.ArrayList
  foreach ($suffix in @('.test', '.spec')) {
    [void]$candidates.Add((Join-Path $dir ($base + $suffix + $ext)))
    [void]$candidates.Add((Join-Path $dir ('test_' + $base + $ext)))
  }
  [void]$candidates.Add((Join-Path $dir ($base + 'Tests' + $ext)))
  $rootTests = Join-Path $Root 'tests'
  if (Test-Path -LiteralPath $rootTests) {
    foreach ($suffix in @('.test', '.spec')) {
      [void]$candidates.Add((Join-Path $rootTests ($base + $suffix + $ext)))
      [void]$candidates.Add((Join-Path $rootTests ('test_' + $base + $ext)))
    }
    [void]$candidates.Add((Join-Path $rootTests ($base + 'Tests' + $ext)))
    if ($base -match '^Coach\.(.+)$') { [void]$candidates.Add((Join-Path $rootTests ('Run-' + $Matches[1] + '.ps1'))) }
    [void]$candidates.Add((Join-Path $rootTests ('Run-' + $base + '.ps1')))
  }
  $trim = $Root.TrimEnd('\', '/').Length
  foreach ($c in $candidates) {
    if (Test-Path -LiteralPath $c) {
      return $c.Substring($trim).TrimStart('\', '/')
    }
  }
  return $null
}

# ---------------------------------------------------------------------------
# The pass. Findings come back in file order, at most MaxPerFile per file and
# MaxFindings per pass, one per line, highest rule order first.
# ---------------------------------------------------------------------------
function Invoke-CodeScan {
  param(
    [string[]]$Roots,
    [DateTime]$SinceUtc = [DateTime]::MinValue,
    [int]$MaxFindings = 5,
    [int]$MaxPerFile = 2,
    [long]$MaxBytes = 0,
    [string[]]$ExcludePaths
  )
  $findings = New-Object System.Collections.ArrayList
  if (-not $Roots -or @($Roots).Count -eq 0) { return @() }
  if ($MaxBytes -le 0) { $MaxBytes = $script:CodeMaxBytesPerPass }
  $budget = [long]0

  foreach ($root in @($Roots)) {
    if ($findings.Count -ge $MaxFindings) { break }
    $resolved = Resolve-CodeRoot $root
    if (-not $resolved) { continue }
    if (Test-CodePathExcluded $resolved $ExcludePaths) { continue }
    $targets = @(Get-CodeScanTargets -Root $resolved -SinceUtc $SinceUtc -ExcludePaths $ExcludePaths)
    foreach ($f in $targets) {
      if ($findings.Count -ge $MaxFindings) { break }
      $budget += [long]$f.Length
      if ($budget -gt $MaxBytes) { break }
      $text = Read-CodeText $f.FullName
      if ($null -eq $text) { continue }
      $rel = $f.FullName.Substring($resolved.TrimEnd('\', '/').Length).TrimStart('\', '/')
      $lines = @($text -split "\r?\n")
      $perFile = 0
      $seen = @{}

      for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($perFile -ge $MaxPerFile -or $findings.Count -ge $MaxFindings) { break }
        foreach ($sc in $script:CodeScanners) {
          $hit = $null
          try { $hit = & $sc.run $lines[$i] $lines $i } catch { $hit = $null }
          if (-not $hit) { continue }
          $key = ('{0}|{1}' -f $sc.id, [int]$hit.line)
          if ($seen.ContainsKey($key)) { continue }
          $seen[$key] = $true
          $sym = Get-CodeSymbol $lines ([int]$hit.line - 1)
          $testFile = Find-CodeTestFile $resolved $rel
          [void]$findings.Add((New-CodeFinding -Scanner $sc -File $rel -Line ([int]$hit.line) -Evidence ([string]$hit.evidence) -Symbol $sym -TestFile $testFile))
          $perFile++
          break
        }
      }
    }
  }
  return @($findings)
}

# The card model for a finding. The follow-up is prose the developer can paste
# into an agent, exactly like a prompt rewrite, so the same rule applies: it
# names what the code does and adds one requirement. The symbol and test file
# make the follow-up specific to this line instead of this rule in general.
function New-CodeDecision($Finding, [string]$Lesson) {
  if (-not $Finding) { return $null }
  $l = $Lesson
  if (-not $l) { $l = [string]$Finding.lesson }
  $principle = $null
  if (Get-Command Get-PrincipleForCodeRule -ErrorAction SilentlyContinue) {
    $principle = Get-PrincipleForCodeRule ([string]$Finding.rule)
  }
  $principleId = $null
  $principleName = $null
  if ($principle) { $principleId = [string]$principle.id; $principleName = [string]$principle.name }
  $symbolName = $null
  if ($Finding.symbol) { $symbolName = [string]$Finding.symbol.name }
  $where = ('{0}:{1}' -f [string]$Finding.file, [int]$Finding.line)
  if ($symbolName) { $where = $where + ' in ' + $symbolName }
  $followUp = ([string]$Finding.followUp).Trim()
  if ($symbolName) { $followUp = $followUp + ' This is in ' + $symbolName + ' at ' + $where + '.' }
  if ($Finding.testFile) { $followUp = $followUp + ' Cover it in ' + [string]$Finding.testFile + '.' }

  $approach = New-Object System.Collections.ArrayList
  if ($Finding.analyzer) {
    # The model's own words, once each: the problem, then the move. A card that
    # repeats the same sentence three times reads as boilerplate, and a boiler
    # plate card trains the developer to dismiss the next one.
    $what = [string]$Finding.evidence
    if (-not ($what -and $what.Trim())) { $what = [string]$Finding.requirement }
    [void]$approach.Add('What Code Coach saw: ' + $what.Trim())
    $move = [string]$Finding.followUp
    if ($move -and $move.Trim()) {
      [void]$approach.Add('Fix: ' + $move.Trim())
    } else {
      [void]$approach.Add('Apply the smallest change that satisfies: ' + [string]$Finding.requirement)
    }
    if ($Finding.testFile) {
      [void]$approach.Add('Check: run ' + [string]$Finding.testFile + ' before and after.')
    }
  } else {
    [void]$approach.Add('Open ' + $where + ' and read the surrounding function before changing it.')
    [void]$approach.Add('Apply the smallest change that satisfies: ' + [string]$Finding.requirement)
    if ($Finding.testFile) {
      [void]$approach.Add('Add or update ' + [string]$Finding.testFile + ' to cover this path; run it before and after.')
    } else {
      [void]$approach.Add('Add the smallest test that would have caught this, then run it before and after.')
    }
  }
  $grounding = New-Object System.Collections.ArrayList
  [void]$grounding.Add('file: ' + $where)
  if ($principleName) { [void]$grounding.Add('principle: ' + $principleName) }
  if ($Finding.testFile) { [void]$grounding.Add('test: ' + [string]$Finding.testFile) }

  return @{
    kind = 'code'
    gapId = [string]$Finding.gapId
    consequence = [string]$Finding.consequence
    gaps = @(@{ id = [string]$Finding.gapId; evidence = [string]$Finding.requirement })
    followUp = $followUp
    approach = @($approach)
    grounding = @($grounding)
    principles = if ($principleId) { @($principleId) } else { @() }
    principle = $principleId
    principleName = $principleName
    smart = $true
    ctxFilled = @{}
    finding = @{
      file = [string]$Finding.file
      line = [int]$Finding.line
      text = [string]$Finding.evidence
      symbol = $Finding.symbol
      testFile = [string]$Finding.testFile
    }
    lesson = $l
  }
}

# What the trace may hold about a finding: no path, no line text.
function Get-CodeFindingTrace($Finding) {
  if (-not $Finding) { return $null }
  $principleId = $null
  if (Get-Command Get-PrincipleForCodeRule -ErrorAction SilentlyContinue) {
    $p = Get-PrincipleForCodeRule ([string]$Finding.rule)
    if ($p) { $principleId = [string]$p.id }
  }
  return @{
    rule = [string]$Finding.rule
    ln = [int]$Finding.line
    sev = [string]$Finding.severity
    path_hash = (Get-CodeHash ([string]$Finding.file))
    principle = $principleId
    has_test = [bool]$Finding.testFile
    ai = [bool]$Finding.analyzer
  }
}

function Get-CodeRule([string]$Id) {
  foreach ($sc in $script:CodeScanners) { if ($sc.id -eq $Id) { return $sc } }
  return $null
}

# ---------------------------------------------------------------------------
# Off-thread scanning. The status tick runs on the UI thread; walking a real
# Projects tree measured 640 ms cold and would sit between a prompt and its
# verdict. A worker runspace does the walk; the tick collects the result later.
# ---------------------------------------------------------------------------
$script:CodeScanJob = $null

function Start-CodeScanAsync {
  param(
    [string[]]$Roots,
    [DateTime]$SinceUtc = [DateTime]::MinValue,
    [int]$Max = 1,
    [string[]]$ExcludePaths,
    [string]$CoachRoot
  )
  if ($script:CodeScanJob) { return $false }
  if (-not $CoachRoot) {
    if ($script:CoachHome) { $CoachRoot = [string]$script:CoachHome }
    else { $CoachRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path }
  }
  $worker = @'
param($Roots, $SinceUtc, $Max, $ExcludePaths, $CoachRoot)
. (Join-Path $CoachRoot 'src\Coach.Common.ps1')
. (Join-Path $CoachRoot 'src\Coach.Code.ps1')
@(Invoke-CodeScan -Roots $Roots -SinceUtc $SinceUtc -MaxFindings $Max -ExcludePaths $ExcludePaths)
'@
  $ps = [powershell]::Create()
  [void]$ps.AddScript($worker)
  [void]$ps.AddParameter('Roots', $Roots)
  [void]$ps.AddParameter('SinceUtc', $SinceUtc)
  [void]$ps.AddParameter('Max', $Max)
  [void]$ps.AddParameter('ExcludePaths', $ExcludePaths)
  [void]$ps.AddParameter('CoachRoot', $CoachRoot)
  try {
    $handle = $ps.BeginInvoke()
    $script:CodeScanJob = @{ ps = $ps; handle = $handle; started = [DateTime]::UtcNow }
    return $true
  } catch {
    try { $ps.Dispose() } catch { }
    Write-CoachLog ('code async: ' + $_.Exception.Message)
    return $false
  }
}

function Complete-CodeScanAsync {
  $job = $script:CodeScanJob
  if (-not $job) { return $null }
  $age = ([DateTime]::UtcNow - $job.started).TotalSeconds
  if (-not $job.handle.IsCompleted) {
    if ($age -lt 120) { return $null }
    # Async stop on purpose: PowerShell.Stop() blocks until the pipeline lands,
    # and a scan frozen inside its walk would freeze the shared dispatcher with
    # it - the live pump kept going stale for ~30 s every 121 s while a killed
    # scan sat down. BeginStop does the same job off the UI thread; the stopped
    # pipeline completes on its own and the next tick collects it.
    if (-not $job.stopPending) {
      try { $job.ps.BeginStop($null, $null) } catch { }
      $job.stopPending = $true
    }
    return $null
  }
  $script:CodeScanJob = $null
  try {
    $out = @($job.ps.EndInvoke($job.handle))
    return @{ done = $true; findings = @($out) }
  } catch {
    Write-CoachLog ('code async: ' + $_.Exception.Message)
    return @{ done = $true; findings = @() }
  } finally {
    try { $job.ps.Dispose() } catch { }
  }
}
