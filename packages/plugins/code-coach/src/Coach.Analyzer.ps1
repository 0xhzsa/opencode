# Coach.Analyzer.ps1 - the background analysis engine.
#
# The deterministic lane watches code with regexes and can only say what a rule
# already knows. This lane watches the same code with a model, in the
# background, and can say what the change actually breaks.
#
# Shape of the engine:
#   1. A pack is built from the repo state: branch, changed files, the diff,
#      and for each changed file the enclosing symbol and its test file.
#   2. Specialized passes read the pack. `review` reports failures; `brief`
#      reports what a file is for. One prompt per job, because each has a
#      different objective and a different output contract. A single
#      all-purpose prompt optimizes for coverage and returns generic advice.
#   3. A deterministic selector ranks and dedupes the candidates. It is not a
#      model call: it has to be reproducible, and the model already paid for
#      the thinking.
#   4. Results are cached by file content hash. A file the model has not seen
#      is never re-analyzed, and a brief is only served while the file on disk
#      still hashes to the content the model read.
#
# Two rules are load-bearing:
#   1. The analyzer never blocks a send. The gate reads the cache; it never
#      starts a model call.
#   2. Every failure path is empty, not an error. A missing CLI, a 429, a
#      timeout, or unparseable output all degrade to "no analysis" and trace it.

# ---------------------------------------------------------------------------
# Tuning. These live in config.json so a slow machine or a paid model can be
# dialed back without touching code.
# ---------------------------------------------------------------------------
$script:AnalyzerPasses = @('review', 'brief')
$script:AnalyzerSeverities = @{ critical = 0; major = 1; minor = 2; nit = 3 }
# Phrases that mean the model did not do the work. A finding carrying one is
# dropped rather than shown, because showing it is what makes the lane useless.
$script:AnalyzerGenericPhrases = @(
  'consider adding', 'you might want', 'it would be good', 'best practice',
  'good idea to', 'add some tests', 'write tests', 'add a test', 'unit test',
  'error handling', 'edge cases', 'more robust', 'code review', 'refactor',
  'naming', 'readability', 'add comments', 'documentation', 'be careful',
  'make sure to', 'consider using', 'consider refactoring'
)

# ---------------------------------------------------------------------------
# Cache. Keyed by file content hash, so an unchanged file costs nothing.
# ---------------------------------------------------------------------------
function Get-AnalyzerCachePath {
  if ($script:CoachData) { return (Join-Path $script:CoachData 'analyzer-cache.json') }
  if ($script:State -and $script:State.dataDir) { return (Join-Path ([string]$script:State.dataDir) 'analyzer-cache.json') }
  return $null
}

function Read-AnalyzerCache([string]$Path) {
  $empty = @{ version = 1; files = @{}; updated = 0 }
  if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path)) { return $empty }
  try {
    $raw = Read-JsonFile $Path
    if (-not $raw) { return $empty }
    # ConvertFrom-Json hands back PSCustomObject; the rest of the engine indexes
    # by key, so normalize once here instead of guarding at every call site.
    $files = @{}
    if ($raw.files) {
      foreach ($p in $raw.files.PSObject.Properties) { $files[$p.Name] = $p.Value }
    }
    return @{ version = 1; files = $files; updated = $(if ($raw.updated) { [long]$raw.updated } else { 0 }) }
  } catch { return $empty }
}

function Save-AnalyzerCache([string]$Path, $Cache) {
  if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
  $Cache.version = 1
  $Cache.updated = [DateTime]::UtcNow.Ticks
  # Keep the cache bounded: a long-lived install would otherwise grow without
  # limit. Two hundred briefs is more than a work session needs.
  $files = $Cache.files
  if ($files -and $files.Count -gt 200) {
    $keep = @($files.GetEnumerator() | Sort-Object { [long]$_.Value.at } -Descending | Select-Object -First 200)
    $trimmed = @{}
    foreach ($p in $keep) { $trimmed[$p.Key] = $p.Value }
    $Cache.files = $trimmed
  }
  try { Write-JsonAtomic $Path $Cache; return $true } catch { return $false }
}

# ---------------------------------------------------------------------------
# The pack. Everything the model sees is grounded in git or on disk, and the
# bytes are capped before the prompt is built.
# ---------------------------------------------------------------------------
function Get-AnalyzerGit([string]$Root) {
  if ([string]::IsNullOrWhiteSpace($Root)) { return $null }
  $git = Get-Command git -ErrorAction SilentlyContinue
  if (-not $git) { return $null }
  $oldLocks = $env:GIT_OPTIONAL_LOCKS
  # git writes progress and line-ending warnings to stderr. Under EAP=Stop a
  # redirected stderr line becomes terminating, so the whole function would
  # return null on a clean repo with a CRLF warning.
  $oldEap = $ErrorActionPreference
  $ErrorActionPreference = 'SilentlyContinue'
  $env:GIT_OPTIONAL_LOCKS = '0'
  try {
    $top = @(& git -C $Root rev-parse --show-toplevel 2>$null)
    if ($LASTEXITCODE -ne 0 -or $top.Count -eq 0) { return $null }
    $root = ([string]$top[0]).Trim()
    if (-not $root) { return $null }
    $branch = @(& git -C $root branch --show-current 2>$null)
    $untracked = @(& git -C $root ls-files --others --exclude-standard 2>$null)
    $staged = @(& git -C $root diff --cached --no-color --stat 2>$null)
    $unstaged = @(& git -C $root diff --no-color --stat 2>$null)
    $diff = @(& git -C $root diff HEAD --no-color -U3 2>$null)
    $diffText = ($diff -join "`n")
    $changed = New-Object System.Collections.ArrayList
    foreach ($line in @($unstaged) + @($staged)) {
      $s = ([string]$line).Trim()
      if (-not $s) { continue }
      if ($s -match '\s\|\s') {
        $p = ($s -split '\s+\|\s+')[0].Trim()
        if ($p -match ' -> ') { $p = ($p -split ' -> ')[-1] }
        if ($p) { [void]$changed.Add(($p -replace '"', '')) }
      }
    }
    foreach ($p in @($untracked)) {
      $s = ([string]$p).Trim()
      if ($s) { [void]$changed.Add(($s -replace '"', '')) }
    }
    $dedup = @{}
    $out = New-Object System.Collections.ArrayList
    foreach ($p in @($changed)) {
      $k = $p.ToLowerInvariant()
      if ($dedup.ContainsKey($k)) { continue }
      $dedup[$k] = $true
      [void]$out.Add($p)
    }
    return @{
      root    = $root
      name    = (Split-Path -Leaf $root)
      branch  = if ($branch.Count -gt 0) { ([string]$branch[0]).Trim() } else { '' }
      staged  = (@($staged) -join "`n").Trim()
      stat    = ((@($unstaged) + @($staged)) -join "`n").Trim()
      diff    = $diffText
      changed = @($out)
    }
  } catch { return $null }
  finally {
    $ErrorActionPreference = $oldEap
    if ($oldLocks -eq $null) { Remove-Item Env:\GIT_OPTIONAL_LOCKS -ErrorAction SilentlyContinue }
    else { $env:GIT_OPTIONAL_LOCKS = $oldLocks }
  }
}

# The registered root is usually a folder of projects, not a repo. One failed
# `rev-parse` is cheap; a recursive scan for .git is not.
function Get-AnalyzerRepoRoot([string]$Path) {
  if ([string]::IsNullOrWhiteSpace($Path)) { return $null }
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) { return $null }
  $oldEap = $ErrorActionPreference
  $oldLocks = $env:GIT_OPTIONAL_LOCKS
  $ErrorActionPreference = 'SilentlyContinue'
  $env:GIT_OPTIONAL_LOCKS = '0'
  try {
    $top = @(& git -C $Path rev-parse --show-toplevel 2>$null)
    if ($LASTEXITCODE -ne 0 -or $top.Count -eq 0) { return $null }
    $root = ([string]$top[0]).Trim()
    if (-not $root) { return $null }
    return $root
  } catch { return $null }
  finally {
    $ErrorActionPreference = $oldEap
    if ($oldLocks -eq $null) { Remove-Item Env:\GIT_OPTIONAL_LOCKS -ErrorAction SilentlyContinue }
    else { $env:GIT_OPTIONAL_LOCKS = $oldLocks }
  }
}

# Resolve the roots the model should read. A root that is already a repo is
# used as-is; a container root is resolved through the files the developer has
# touched recently, newest first, so the pass follows the work instead of
# walking every project on disk.
function Resolve-AnalyzerRepos {
  param(
    [string[]]$Roots,
    [int]$MaxRepos = 2,
    [double]$RecentHours = 72,
    [int]$MaxFiles = 80
  )
  $out = New-Object System.Collections.ArrayList
  if ($MaxRepos -le 0) { $MaxRepos = 1 }
  $seen = @{}
  foreach ($root in @($Roots)) {
    if ($out.Count -ge $MaxRepos) { break }
    if ([string]::IsNullOrWhiteSpace($root)) { continue }
    $self = Get-AnalyzerGit $root
    if ($self) {
      $key = ([string]$self.root).TrimEnd('\', '/').ToLowerInvariant()
      if (-not $seen.ContainsKey($key)) {
        $seen[$key] = $true
        [void]$out.Add([string]$self.root)
      }
      continue
    }
    if (-not (Get-Command Get-CodeScanTargets -ErrorAction SilentlyContinue)) { continue }
    $since = [DateTime]::UtcNow.AddHours(-[math]::Abs($RecentHours))
    $targets = @(Get-CodeScanTargets -Root $root -SinceUtc $since -MaxFiles $MaxFiles |
        Sort-Object LastWriteTimeUtc -Descending)
    foreach ($t in $targets) {
      if ($out.Count -ge $MaxRepos) { break }
      $top = Get-AnalyzerRepoRoot (Split-Path -Parent $t.FullName)
      if (-not $top) { continue }
      $key = $top.TrimEnd('\', '/').ToLowerInvariant()
      if ($seen.ContainsKey($key)) { continue }
      $seen[$key] = $true
      [void]$out.Add($top)
    }
  }
  return @($out)
}

function Get-AnalyzerRelPath([string]$Root, [string]$Full) {
  $r = $Root.TrimEnd('\', '/')
  $f = $Full.TrimEnd('\', '/')
  if ($f.StartsWith(($r + [IO.Path]::DirectorySeparatorChar), [StringComparison]::OrdinalIgnoreCase)) {
    return $f.Substring($r.Length).TrimStart('\', '/')
  }
  return (Split-Path -Leaf $Full)
}

# A bounded, line-numbered excerpt of a changed file. The model gets the real
# code around a change, which is what turns "add error handling" into "this
# catch swallows a 401".
function Get-AnalyzerExcerpt([string]$Root, [string]$Rel, [long]$MaxBytes) {
  if ([string]::IsNullOrWhiteSpace($Root) -or [string]::IsNullOrWhiteSpace($Rel)) { return '' }
  if (-not (Get-Command Read-CodeText -ErrorAction SilentlyContinue)) { return '' }
  $full = Join-Path $Root $Rel
  $text = Read-CodeText $full
  if (-not $text) { return '' }
  $lines = @($text -split "\r?\n")
  $budget = if ($MaxBytes -gt 0) { [int]$MaxBytes } else { 40000 }
  if ($text.Length -le $budget) {
    $sb = New-Object System.Text.StringBuilder
    for ($i = 0; $i -lt $lines.Count; $i++) {
      if ($i -gt 0) { [void]$sb.Append("`n") }
      [void]$sb.Append(('{0,4}: {1}' -f ($i + 1), $lines[$i]))
    }
    $out = $sb.ToString()
    # Line numbers are part of the bytes the model reads. A file just under
    # the budget can still produce a numbered excerpt over it.
    if ($out.Length -gt $budget) {
      $cut = $out.LastIndexOf("`n", [Math]::Min([int]$budget, $out.Length - 1))
      if ($cut -lt 0) { $cut = [int]$budget }
      return ($out.Substring(0, $cut) + "`n   ... (excerpt truncated) ...")
    }
    return $out
  }
  # Oversize: the head plus the tail, where the changed hunks usually live.
  $head = @($lines | Select-Object -First 400)
  $tail = @($lines | Select-Object -Last 300)
  $sb = New-Object System.Text.StringBuilder
  for ($i = 0; $i -lt $head.Count; $i++) { if ($i -gt 0) { [void]$sb.Append("`n") }; [void]$sb.Append(('{0,4}: {1}' -f ($i + 1), $head[$i])) }
  [void]$sb.Append("`n   ... (file continues) ...`n")
  $start = $lines.Count - $tail.Count
  for ($i = 0; $i -lt $tail.Count; $i++) { [void]$sb.Append(('{0,4}: {1}' -f ($start + $i + 1), $tail[$i])); if ($i -lt $tail.Count - 1) { [void]$sb.Append("`n") } }
  $out = $sb.ToString()
  # The caller's budget is bytes, not lines: 700 numbered lines of a wide file
  # can be ten times the cap and still look "bounded" here. Trim to the budget
  # on a line boundary so a single excerpt can never blow the pack.
  if ($out.Length -gt $budget) {
    $cut = $out.LastIndexOf("`n", [Math]::Min([int]$budget, $out.Length - 1))
    if ($cut -lt 0) { $cut = [int]$budget }
    return ($out.Substring(0, $cut) + "`n   ... (excerpt truncated) ...")
  }
  return $out
}

function Get-AnalyzerPack {
  param(
    [string]$Root,
    $Git,
    [int]$MaxFiles = 6,
    [long]$MaxBytes = 0,
    [string[]]$IncludeFiles,
    [switch]$NoDiff
  )
  if (-not $Git) { $Git = Get-AnalyzerGit $Root }
  if (-not $Git) { return $null }
  # Nothing changed means nothing to review. Asking the model to review an
  # empty change is how a pass spends 30 seconds to say "looks fine".
  # Target files from the triage heal are the exception: a send may name a
  # file that is clean in git, and orientation for it is still real grounding,
  # not an invented one.
  if (@($Git.changed).Count -eq 0 -and [string]::IsNullOrWhiteSpace([string]$Git.diff) -and -not (@($IncludeFiles | Where-Object { $_ }).Count)) { return $null }
  $budget = if ($MaxBytes -gt 0) { [long]$MaxBytes } else { 120000 }
  # The budget is a total, not a per-section allowance. A review pack keeps a
  # slice for the diff; a brief pack has no use for the diff at all, so every
  # byte goes to the code the model must orient.
  $excerptBudget = if ($NoDiff) { $budget } else { [long][Math]::Min($budget, [Math]::Max(2000, [int]($budget * 0.6))) }
  $parts = New-Object System.Collections.ArrayList
  [void]$parts.Add('repo: ' + $Git.name + ' (' + $Git.branch + ')')
  [void]$parts.Add('changed files: ' + $(if (@($Git.changed).Count -gt 0) { (@($Git.changed) -join ', ') } else { '(none)' }))

  $excerpts = New-Object System.Collections.ArrayList
  $used = [long]0

  # Target files from the triage heal come first: they are the reason this
  # pass exists, and the developer is waiting on their briefs. Files already
  # in the changed set are skipped here — the changed loop below covers them.
  $changedSet = @{}
  foreach ($c in @($Git.changed)) { $changedSet[[string]$c] = $true }
  foreach ($rel in @($IncludeFiles | Where-Object { $_ })) {
    if ($changedSet.ContainsKey([string]$rel)) { continue }
    $remaining = $excerptBudget - $used
    if ($remaining -lt 2000) { break }
    $excerpt = Get-AnalyzerExcerpt $Root ([string]$rel) ([Math]::Min(60000, $remaining))
    if (-not $excerpt) { continue }
    [void]$excerpts.Add('--- target file: ' + $rel + ' (named by the current ask; unchanged in git) ---')
    [void]$excerpts.Add($excerpt)
    $used += $excerpt.Length
  }

  foreach ($rel in @(@($Git.changed) | Select-Object -First ([Math]::Max(1, $MaxFiles)))) {
    $remaining = $excerptBudget - $used
    if ($remaining -lt 2000) { break }
    $excerpt = Get-AnalyzerExcerpt $Root $rel ([Math]::Min(40000, $remaining))
    if (-not $excerpt) { continue }
    $sym = $null
    if (Get-Command Get-CodeSymbol -ErrorAction SilentlyContinue) {
      $lines = @($excerpt -split "`n")
      if ($lines.Count -gt 0) { $sym = Get-CodeSymbol $lines ([math]::Min($lines.Count - 1, 40)) }
    }
    $test = $null
    if (Get-Command Find-CodeTestFile -ErrorAction SilentlyContinue) { $test = Find-CodeTestFile $Root $rel }
    [void]$excerpts.Add('--- ' + $rel + ' ---')
    [void]$excerpts.Add($excerpt)
    if ($test) { [void]$excerpts.Add('test file: ' + $test) }
    if ($sym) { [void]$excerpts.Add('nearest symbol: ' + $sym.name) }
    $used += $excerpt.Length
  }
  [void]$parts.Add('')
  foreach ($e in $excerpts) { [void]$parts.Add([string]$e) }
  if (-not $NoDiff -and $Git.diff) {
    $remaining = $budget - $used
    if ($remaining -gt 2000) {
      $diff = $Git.diff
      if ($diff.Length -gt $remaining) { $diff = $diff.Substring(0, [int]$remaining) + "`n... (diff truncated)" }
      [void]$parts.Add('')
      [void]$parts.Add('diff:')
      [void]$parts.Add($diff)
    }
  }
  return ($parts -join "`n")
}

# ---------------------------------------------------------------------------
# The prompts. Each states its output contract, because an unstated contract is
# how a model returns prose you cannot parse and advice you cannot act on.
# ---------------------------------------------------------------------------
function New-AnalyzerReviewPrompt($Pack) {
  if (-not $Pack) { return '' }
  return @"
You are reviewing a code change. You have no tools and cannot read files. Work only from the CONTEXT below; never invent a file, symbol, or line number.

CONTEXT
$Pack

OUTPUT CONTRACT
Respond with prose, then a single fenced ```json block, nothing after it:
{"findings":[{"file":"...","line":1,"severity":"critical|major|minor","topic":"kebab-topic","issue":"one sentence: what breaks","fix":"one sentence: the concrete change","test":"the test that would catch it"}]}
Rules:
- file and line must exist in the context. No line => omit the finding.
- At most 4 findings, one per distinct failure.
- Never report: missing tests, naming, style, "consider adding", "you might want to".
- Each finding must be a failure you can state as: when X happens, Y happens wrongly.
- If the change is sound, findings is [].
"@
}

function New-AnalyzerBriefPrompt($Pack) {
  if (-not $Pack) { return '' }
  return @"
You are writing a short orientation brief for files a developer is about to change. You have no tools and cannot read files. Work only from the CONTEXT below; never invent a file, symbol, or line number.

CONTEXT
$Pack

OUTPUT CONTRACT
Respond with a single fenced ```json block and nothing else:
{"briefs":[{"file":"...","purpose":"two sentences: what this file is for and what it must not do","fragile":"one sentence: the part most likely to break next, or empty","symbols":["name"]}]}
Rules:
- One entry per changed or target file in the context, no others.
- purpose and fragile must be statements about the code shown, not advice.
- No "consider", no "should", no generic practice. If nothing is fragile, use "".
- At most 3 symbols per file, real names from the code.
"@
}

# ---------------------------------------------------------------------------
# Invoke. A model call is a child process, a timeout, and two files. It must
# never sit on the UI thread and must never be retried in a way that burns
# quota: the caller holds the cooldown.
# ---------------------------------------------------------------------------
function Quote-WinArg([string]$s) {
  if ([string]::IsNullOrEmpty($s)) { return '""' }
  if ($s -notmatch '[\s"]') { return $s }
  return '"' + ($s -replace '(\\*)"', '$1\"') + '"'
}

function New-AnalyzerCommandLine([string]$Exe, [string]$Prompt, [string]$Model, [string]$Agent, [string]$WorkDir, [string]$PromptFile = '') {
  $parts = @('run', '--standalone', '--format', 'json')
  if ($Agent) { $parts += @('--agent', $Agent) }
  if ($Model) { $parts += @('-m', $Model) }
  if ($PromptFile) { $parts += @('--file', (Quote-WinArg $PromptFile)) }
  $parts += @((Quote-WinArg $Prompt))
  return ($parts -join ' ')
}

# The CLI is shipped as a .cmd/.ps1 shim around a real exe. Start-Process on a
# shim leaves the node child alive when a timeout kills the shim, so resolve the
# exe behind it when the layout is recognizable.
function Resolve-AnalyzerExe([string]$Configured = '') {
  if (-not [string]::IsNullOrWhiteSpace($Configured)) {
    if (Test-Path -LiteralPath $Configured) { return $Configured }
    return ''
  }
  foreach ($name in @('opencode.cmd', 'opencode.exe', 'opencode')) {
    $c = Get-Command $name -ErrorAction SilentlyContinue
    if (-not $c -or -not $c.Source) { continue }
    $src = [string]$c.Source
    $dir = Split-Path -Parent $src
    if ($dir) {
      $cand = Join-Path $dir 'node_modules\@opencode\cli\bin\opencode.exe'
      if (Test-Path -LiteralPath $cand) { return $cand }
    }
    if ($src -match '\.(exe|cmd)$') { return $src }
  }
  return ''
}

function Invoke-AnalyzerModel {
  param(
    [string]$Prompt,
    [string]$Exe = '',
    [string]$Model = '',
    [string]$Agent = '',
    [string]$WorkDir = '',
    [int]$TimeoutMs = 90000
  )
  if ([string]::IsNullOrWhiteSpace($Prompt)) { return @{ ok = $false; why = 'empty-prompt' } }
  if (-not $Exe) { $Exe = Resolve-AnalyzerExe '' }
  if (-not $Exe -or -not (Test-Path -LiteralPath $Exe)) { return @{ ok = $false; why = 'no-cli' } }
  if (-not $WorkDir) { $WorkDir = (Get-Location).Path }
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ('coach-analyzer-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  $out = Join-Path $tmp 'out.jsonl'
  $err = Join-Path $tmp 'err.txt'
  $promptFile = ''
  # Windows caps the command line at ~32,767 chars; a real pack is ~120k. When the
  # prompt would overflow, write it to a file and attach it instead of passing it
  # on the command line. The model sees the same text, just from a handle.
  if ($Prompt.Length -gt 24000) {
    $promptFile = Join-Path $tmp 'prompt.txt'
    [IO.File]::WriteAllText($promptFile, $Prompt, (New-Object Text.UTF8Encoding($false)))
    $Prompt = 'Read the attached context file and follow its output contract exactly.'
  }
  $oldBypass = $env:COACH_BYPASS
  $oldMark = $env:COACH_ANALYZER
  $env:COACH_BYPASS = '1'
  $env:COACH_ANALYZER = '1'
  # Hermetic child: the analyzer's CLI must never inherit the controlling TUI's
  # session/terminal/server state. A daemon can start days after the session it
  # was born from died, and a session id that disappears mid-life is one of the
  # errors this lane used to log as `Session not found`.
  $strip = @{}
  foreach ($name in @('OPENCODE_SESSION_ID', 'OPENCODE_SERVER', 'OPENCODE_TERMINAL')) {
    $v = [Environment]::GetEnvironmentVariable($name, 'Process')
    if ($null -ne $v) { $strip[$name] = $v; [Environment]::SetEnvironmentVariable($name, $null, 'Process') }
  }
  $proc = $null
  try {
    $cmdline = New-AnalyzerCommandLine $Exe $Prompt $Model $Agent $WorkDir $promptFile
    $proc = Start-Process -FilePath $Exe -ArgumentList $cmdline -WorkingDirectory $WorkDir -PassThru -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err
    $finished = $proc.WaitForExit($TimeoutMs)
    if (-not $finished) {
      try { $proc.Kill() } catch { }
      return @{ ok = $false; why = 'timeout' }
    }
    # WaitForExit(ms) can return before the redirected streams flush and before
    # ExitCode is populated; the no-arg wait is what makes both real.
    try { $proc.WaitForExit() } catch { }
    try { $proc.Refresh() } catch { }
    $code = $null
    try { $code = $proc.ExitCode } catch { $code = $null }
    $stderrText = ''
    if (Test-Path -LiteralPath $err) { $stderrText = ([IO.File]::ReadAllText($err)).Trim() }
    if ($null -ne $code -and $code -ne 0) {
      return @{ ok = $false; why = ('exit-' + $code); error = $stderrText }
    }
    if (-not (Test-Path -LiteralPath $out)) { return @{ ok = $false; why = 'no-output' } }
    $text = ''
    foreach ($line in @([IO.File]::ReadLines($out))) {
      if ([string]::IsNullOrWhiteSpace($line)) { continue }
      try { $o = $line | ConvertFrom-Json } catch { continue }
      if ($o.type -eq 'text' -and $o.part -and $o.part.text) { $text += [string]$o.part.text + "`n" }
      elseif ($o.type -eq 'error') {
        $msg = ''
        if ($o.error) { $msg = [string]$o.error.message }
        if ($msg -match '(?i)free.?usage|rate.?limit|429') { return @{ ok = $false; why = 'rate-limited'; error = $msg } }
        if ($msg) { return @{ ok = $false; why = 'model-error'; error = $msg } }
      }
    }
    if (-not $text) {
      # A .cmd shim does not expose ExitCode through Start-Process. Stderr with
      # no stdout is the same signal: the CLI failed before it answered.
      if ($stderrText) { return @{ ok = $false; why = 'exit-fail'; error = $stderrText } }
      return @{ ok = $false; why = 'no-text' }
    }
    return @{ ok = $true; text = $text.Trim() }
  } catch {
    return @{ ok = $false; why = 'exception'; error = $_.Exception.Message }
  } finally {
    foreach ($name in @($strip.Keys)) { [Environment]::SetEnvironmentVariable($name, [string]$strip[$name], 'Process') }
    if ($oldBypass -eq $null) { Remove-Item Env:\COACH_BYPASS -ErrorAction SilentlyContinue } else { $env:COACH_BYPASS = $oldBypass }
    if ($oldMark -eq $null) { Remove-Item Env:\COACH_ANALYZER -ErrorAction SilentlyContinue } else { $env:COACH_ANALYZER = $oldMark }
    if ($proc) { try { $proc.Dispose() } catch { } }
    try { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue } catch { }
  }
}

# ---------------------------------------------------------------------------
# Parse. The model is asked for a fenced json block. It sometimes forgets the
# quotes around keys, so the parser repairs that before it gives up.
# ---------------------------------------------------------------------------
function Read-AnalyzerJsonBlock([string]$Text) {
  if ([string]::IsNullOrWhiteSpace($Text)) { return '' }
  $fence = [regex]::Match($Text, '(?s)```(?:json|JSON)?\s*(.+?)```')
  if ($fence.Success) { return $fence.Groups[1].Value.Trim() }
  $open = $Text.IndexOf('{')
  $close = $Text.LastIndexOf('}')
  if ($open -lt 0 -or $close -le $open) { return '' }
  return $Text.Substring($open, ($close - $open + 1)).Trim()
}

function ConvertFrom-AnalyzerJson([string]$Text) {
  $block = Read-AnalyzerJsonBlock $Text
  if (-not $block) { return $null }
  $candidates = New-Object System.Collections.ArrayList
  [void]$candidates.Add($block)
  # Bare keys: {ok:true,n:1}. Quote them and retry.
  $repaired = [regex]::Replace($block, '([{,]\s*)([A-Za-z_][A-Za-z0-9_\-]*)(\s*:)', '$1"$2"$3')
  if ($repaired -ne $block) { [void]$candidates.Add($repaired) }
  foreach ($c in $candidates) {
    try { return ($c | ConvertFrom-Json) } catch { continue }
  }
  return $null
}

function Read-AnalyzerFindings([string]$Text) {
  $obj = ConvertFrom-AnalyzerJson $Text
  if (-not $obj -or -not $obj.findings) { return @() }
  $out = New-Object System.Collections.ArrayList
  foreach ($f in @($obj.findings)) {
    if (-not $f) { continue }
    [void]$out.Add(@{
      file     = [string]$f.file
      line     = [int]$f.line
      severity = ([string]$f.severity).Trim().ToLowerInvariant()
      topic    = ([string]$f.topic).Trim().ToLowerInvariant()
      issue    = [string]$f.issue
      fix      = [string]$f.fix
      test     = [string]$f.test
    })
  }
  return @($out)
}

function Read-AnalyzerBriefs([string]$Text) {
  $obj = ConvertFrom-AnalyzerJson $Text
  if (-not $obj -or -not $obj.briefs) { return @() }
  $out = New-Object System.Collections.ArrayList
  foreach ($b in @($obj.briefs)) {
    if (-not $b) { continue }
    [void]$out.Add(@{
      file     = [string]$b.file
      purpose  = [string]$b.purpose
      fragile  = [string]$b.fragile
      symbols  = @(@($b.symbols | ForEach-Object { [string]$_ }))
    })
  }
  return @($out)
}

# ---------------------------------------------------------------------------
# Select. The model proposes; the selector disposes. It is deterministic
# because the same candidates must always produce the same card.
# ---------------------------------------------------------------------------
function Test-AnalyzerFindingGeneric($Finding) {
  if (-not $Finding) { return $true }
  $blob = (([string]$Finding.issue) + ' ' + ([string]$Finding.fix) + ' ' + ([string]$Finding.test)).ToLowerInvariant()
  foreach ($p in $script:AnalyzerGenericPhrases) {
    if ($blob.Contains($p)) { return $true }
  }
  if ([string]::IsNullOrWhiteSpace([string]$Finding.issue)) { return $true }
  if ([string]::IsNullOrWhiteSpace([string]$Finding.fix)) { return $true }
  return $false
}

# A finding is only worth a card if it can be located. No line means the model
# described a file it could not see.
function Test-AnalyzerFindingGrounded($Finding, $Pack) {
  if (-not $Finding) { return $false }
  $file = ([string]$Finding.file).Trim()
  if (-not $file) { return $false }
  if ([int]$Finding.line -le 0) { return $false }
  if ($Pack -and ($Pack.IndexOf($file, [StringComparison]::OrdinalIgnoreCase) -lt 0)) { return $false }
  return $true
}

function Get-AnalyzerSeverityRank([string]$Severity) {
  $s = ([string]$Severity).Trim().ToLowerInvariant()
  if ($script:AnalyzerSeverities.ContainsKey($s)) { return [int]$script:AnalyzerSeverities[$s] }
  return 9
}

# The signature the repeat window keys on. Two different phrasings of the same
# problem share a topic, so the same file is not lectured twice.
function Get-AnalyzerFindingKey($Finding) {
  if (-not $Finding) { return '' }
  $topic = ([string]$Finding.topic).Trim().ToLowerInvariant()
  if (-not $topic) { $topic = 'untitled' }
  $pathHash = ''
  if (Get-Command Get-CodeHash -ErrorAction SilentlyContinue) { $pathHash = Get-CodeHash ([string]$Finding.file) }
  return ('ai|' + $topic + '|' + $pathHash)
}

function Select-AnalyzerFindings {
  param($Candidates, [int]$Max = 2, $Pack = $null)
  $picked = New-Object System.Collections.ArrayList
  $seen = @{}
  foreach ($f in @($Candidates)) {
    if ($picked.Count -ge $Max) { break }
    if (-not (Test-AnalyzerFindingGrounded $f $Pack)) { continue }
    if (Test-AnalyzerFindingGeneric $f) { continue }
    $key = Get-AnalyzerFindingKey $f
    if ($seen.ContainsKey($key)) { continue }
    $seen[$key] = $true
    [void]$picked.Add($f)
  }
  return @($picked | Sort-Object { Get-AnalyzerSeverityRank $_.severity })
}

# A model finding becomes the shape the code card already renders, so the card
# path, the trace, and the repeat window do not fork.
function New-AnalyzerCodeFinding($Finding) {
  if (-not $Finding) { return $null }
  $topic = ([string]$Finding.topic).Trim()
  if (-not $topic) { $topic = 'analyzer' }
  $rule = 'ai-' + ($topic -replace '[^A-Za-z0-9\-]', '-')
  # The model's `test` is usually a sentence, not a path. A path goes to the
  # card's test slot; a sentence becomes the last line of the follow-up, where
  # it is the concrete check the developer can ask for.
  $testPath = $null
  $testIdea = ''
  $t = ([string]$Finding.test).Trim()
  if ($t -match '^[\w.\-/\\]+\.(ps1|psm1|js|mjs|cjs|ts|tsx|py|cs|go|rs|rb|java|kt|swift|sh|sql)$') { $testPath = $t }
  elseif ($t) { $testIdea = $t }
  $follow = ([string]$Finding.fix).Trim()
  if ($testIdea) { $follow = ($follow.TrimEnd() + ' ' + $testIdea).Trim() }
  return @{
    rule        = $rule
    gapId       = $rule
    mechanism   = 0
    severity    = if ($script:AnalyzerSeverities.ContainsKey(([string]$Finding.severity).ToLowerInvariant())) { ([string]$Finding.severity).ToLowerInvariant() } else { 'minor' }
    file        = [string]$Finding.file
    line        = [int]$Finding.line
    evidence    = (Get-CodeShortLine ([string]$Finding.issue))
    requirement = [string]$Finding.issue
    consequence = [string]$Finding.issue
    followUp     = $follow
    lesson = if ([string]$Finding.fix -and ([string]$Finding.fix).Trim()) { ([string]$Finding.fix).Trim() } else { ([string]$Finding.issue).Trim() }
    symbol      = $null
    testFile    = $testPath
    analyzer    = $true
    topic       = $topic
  }
}

# A model finding is only shown while the line it names still exists. A stale
# finding from the previous pass is dropped, not rendered against a file that
# has moved on.
function Test-AnalyzerFindingLive($Finding, [string[]]$Roots) {
  if (-not $Finding) { return $false }
  $rel = [string]$Finding.file
  if ([string]::IsNullOrWhiteSpace($rel)) { return $false }
  if ([int]$Finding.line -le 0) { return $false }
  foreach ($root in @($Roots)) {
    $full = Join-Path ([string]$root) $rel
    if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { continue }
    $text = ''
    if (Get-Command Read-CodeText -ErrorAction SilentlyContinue) { $text = Read-CodeText $full }
    if (-not $text) { return $false }
    $lines = @($text -split "\r?\n")
    if ([int]$Finding.line -gt $lines.Count) { return $false }
    return $true
  }
  return $false
}

# ---------------------------------------------------------------------------
# The brief service. The prompt lane calls this synchronously and must be able
# to answer in microseconds, so it only reads the cache and only serves a brief
# whose file still hashes to the content the model read.
# ---------------------------------------------------------------------------
# One key for one file. The heal names a file with native separators
# (src\Ok.ps1) while the model answers with the repo-relative form the prompt
# used (src/Ok.ps1); hashing those two strings gives two different keys and a
# brief that exists looks missing. Normalize separators before hashing, on both
# the write and the read.
function Get-AnalyzerCacheKey([string]$RelPath) {
  if ([string]::IsNullOrWhiteSpace($RelPath)) { return '' }
  $p = $RelPath.Replace('\', '/')
  if (Get-Command Get-CodeHash -ErrorAction SilentlyContinue) { return (Get-CodeHash $p) }
  return $p.ToLowerInvariant()
}

function Get-CachedFileBrief {
  param([string]$RelPath, [string]$Root = '', [int]$MaxChars = 220)
  if ([string]::IsNullOrWhiteSpace($RelPath)) { return $null }
  $cachePath = Get-AnalyzerCachePath
  if (-not $cachePath) { return $null }
  $cache = Read-AnalyzerCache $cachePath
  if (-not $cache -or -not $cache.files) { return $null }
  $hash = Get-AnalyzerCacheKey $RelPath
  $entry = $null
  if ($cache.files.ContainsKey($hash)) { $entry = $cache.files[$hash] }
  if (-not $entry) { return $null }
  # Grounding check: the brief is only true while the file is unchanged.
  if ($Root) {
    $full = Join-Path $Root $RelPath
    if (Test-Path -LiteralPath $full -PathType Leaf) {
      $now = ''
      if (Get-Command Get-CodeHash -ErrorAction SilentlyContinue) { $now = Get-CodeHash ([IO.File]::ReadAllText($full)) }
      if ($now -and $entry.hash -and $now -ne [string]$entry.hash) { return $null }
    }
  }
  $purpose = ([string]$entry.purpose).Trim()
  if (-not $purpose) { return $null }
  $fragile = ([string]$entry.fragile).Trim()
  $line = $purpose
  if ($fragile) { $line = $line + ' ' + $fragile }
  if ($line.Length -gt $MaxChars) { $line = $line.Substring(0, $MaxChars).TrimEnd() + '...' }
  return $line
}

# The prompt lane's share of the engine. It returns the cached briefs for the
# files the developer actually named, and nothing for files they did not. A
# brief about a file the draft never mentions is noise, and a brief about a file
# that changed since the model read it is not served at all.
function Get-AnalyzerFactsForDraft {
  param([string]$Draft, $Ctx, [int]$Max = 2, [int]$MaxChars = 220)
  if ([string]::IsNullOrWhiteSpace($Draft)) { return @() }
  $names = New-Object System.Collections.ArrayList
  foreach ($f in @(Get-FileTokens $Draft)) { [void]$names.Add([string]$f) }
  if ($Ctx) {
    foreach ($name in @('Files', 'TestFiles')) {
      foreach ($f in @(Get-CtxList $Ctx $name)) { [void]$names.Add([string]$f) }
    }
  }
  $seen = @{}
  $unique = New-Object System.Collections.ArrayList
  foreach ($n in @($names)) {
    $k = ([string]$n).ToLowerInvariant()
    if ($seen.ContainsKey($k)) { continue }
    $seen[$k] = $true
    [void]$unique.Add([string]$n)
  }
  if ($unique.Count -eq 0) { return @() }

  $root = ''
  if ($Ctx) {
    $repo = Get-CtxValue $Ctx 'Repo'
    if ($repo) { $root = [string]$repo.root }
  }
  if (-not $root) { $repoCtx = Get-RepoContext ''; if ($repoCtx) { $root = [string]$repoCtx.root } }

  $facts = New-Object System.Collections.ArrayList
  foreach ($rel in @($unique)) {
    if ($facts.Count -ge $Max) { break }
    $brief = Get-CachedFileBrief -RelPath $rel -Root $root -MaxChars $MaxChars
    if (-not $brief) { continue }
    [void]$facts.Add('- ' + $rel + ': ' + $brief)
  }
  return @($facts)
}

# ---------------------------------------------------------------------------
# Off-thread analysis. The pass runs two model calls and can take minutes, so
# it lives in a worker runspace exactly like the scan: the tick starts it, the
# tick collects it, and the UI thread never waits.
# ---------------------------------------------------------------------------
$script:AnalyzerJob = $null
$script:AnalyzerNotBefore = [DateTime]::MinValue

function Start-AnalyzerAsync {
  param(
    [string[]]$Roots,
    [string]$Exe = '',
    [string]$Model = '',
    [string]$Agent = '',
    [int]$TimeoutMs = 90000,
    [int]$MaxFiles = 6,
    [long]$MaxBytes = 0,
    [string]$CoachRoot = '',
    [string]$CachePath = '',
    [string[]]$IncludeFiles
  )
  if ($script:AnalyzerJob) { return $false }
  if (-not $CoachRoot) {
    if ($script:CoachHome) { $CoachRoot = [string]$script:CoachHome }
    else { $CoachRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path }
  }
  if (-not $CachePath) { $CachePath = Get-AnalyzerCachePath }
  $worker = @'
param($Roots, $Exe, $Model, $Agent, $TimeoutMs, $MaxFiles, $MaxBytes, $CoachRoot, $CachePath, $IncludeFiles)
. (Join-Path $CoachRoot 'src\Coach.Common.ps1')
. (Join-Path $CoachRoot 'src\Coach.Code.ps1')
. (Join-Path $CoachRoot 'src\Coach.Analyzer.ps1')
$all = New-Object System.Collections.ArrayList
$repos = @(Resolve-AnalyzerRepos -Roots $Roots -MaxRepos 2)
if ($repos.Count -eq 0) { return @{ findings = @(); why = 'no-git'; briefs = 0 } }
$why = 'ok'
$errText = ''
$briefTotal = 0
$briefWhy = ''
$briefErr = ''
foreach ($root in $repos) {
  $git = Get-AnalyzerGit $root
  if (-not $git) { $why = 'no-git'; continue }
  # A pass with IncludeFiles is the triage heal: it exists to orient the model
  # on the file the developer just named, and it runs while a real send waits
  # for its retry. Reviewing the dirty diff is not its job and doubles the time
  # the pipe is held, so a heal pass is brief-only.
  $isHeal = (@($IncludeFiles | Where-Object { $_ }).Count -gt 0)
  if (-not $isHeal) {
    $pack = Get-AnalyzerPack -Root $root -Git $git -MaxFiles $MaxFiles -MaxBytes $MaxBytes -IncludeFiles $IncludeFiles
    if (-not $pack) { $why = 'no-pack'; continue }
    $rev = Invoke-AnalyzerModel -Prompt (New-AnalyzerReviewPrompt $pack) -Exe $Exe -Model $Model -Agent $Agent -WorkDir $root -TimeoutMs $TimeoutMs
    if (-not $rev.ok) { $why = $rev.why; $errText = [string]$rev.error; continue }
    foreach ($f in @(Read-AnalyzerFindings $rev.text)) { [void]$all.Add($f) }
  }
  # The brief is orientation, not review: the diff adds bytes the brief cannot
  # use and, on a dirty repo, can make the prompt large enough that the call
  # times out. A diff-free pack keeps the target excerpt first and the prompt
  # small; a brief that never lands is a heal that never retries. A heal pack
  # is smaller still: one named file, not the whole change set.
  $briefCap = if ($isHeal) { 24000 } else { 60000 }
  $briefBudget = if ($MaxBytes -gt 0) { [long][Math]::Min($briefCap, [long]$MaxBytes) } else { $briefCap }
  $briefPack = Get-AnalyzerPack -Root $root -Git $git -MaxFiles $MaxFiles -MaxBytes $briefBudget -IncludeFiles $IncludeFiles -NoDiff
  if (-not $briefPack) { continue }
  $br = Invoke-AnalyzerModel -Prompt (New-AnalyzerBriefPrompt $briefPack) -Exe $Exe -Model $Model -Agent $Agent -WorkDir $root -TimeoutMs $TimeoutMs
  # A brief failure is not a review failure: the findings are still real. But
  # the heal lives on briefs, and a free-pool rate limit or a one-off timeout is
  # transient. Retry those once, then report the reason instead of going quiet.
  if (-not $br.ok -and ([string]$br.why -in @('rate-limited', 'timeout'))) {
    Start-Sleep -Seconds 3
    $br = Invoke-AnalyzerModel -Prompt (New-AnalyzerBriefPrompt $briefPack) -Exe $Exe -Model $Model -Agent $Agent -WorkDir $root -TimeoutMs $TimeoutMs
  }
  if (-not $br.ok) {
    $briefWhy = [string]$br.why
    $briefErr = ([string]$br.error).Trim()
    continue
  }
  $cache = Read-AnalyzerCache $CachePath
  foreach ($b in @(Read-AnalyzerBriefs $br.text)) {
    $full = Join-Path $root ([string]$b.file)
    if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { continue }
    $text = ''
    if (Get-Command Read-CodeText -ErrorAction SilentlyContinue) { $text = Read-CodeText $full }
    if (-not $text) { continue }
    $key = Get-AnalyzerCacheKey ([string]$b.file)
    $cache.files[$key] = @{
      path    = ([string]$b.file).Replace('\', '/')
      hash    = (Get-CodeHash $text)
      purpose = [string]$b.purpose
      fragile = [string]$b.fragile
      symbols = @(@($b.symbols | ForEach-Object { [string]$_ }))
      at      = [DateTime]::UtcNow.Ticks
    }
    $briefTotal++
  }
  Save-AnalyzerCache $CachePath $cache | Out-Null
}
return @{ findings = @($all); repos = @($repos); why = $why; error = $errText; briefs = $briefTotal; briefWhy = $briefWhy; briefErr = $briefErr }
'@
  $ps = [powershell]::Create()
  [void]$ps.AddScript($worker)
  [void]$ps.AddParameter('Roots', $Roots)
  [void]$ps.AddParameter('Exe', $Exe)
  [void]$ps.AddParameter('Model', $Model)
  [void]$ps.AddParameter('Agent', $Agent)
  [void]$ps.AddParameter('TimeoutMs', $TimeoutMs)
  [void]$ps.AddParameter('MaxFiles', $MaxFiles)
  [void]$ps.AddParameter('MaxBytes', $MaxBytes)
  [void]$ps.AddParameter('CoachRoot', $CoachRoot)
  [void]$ps.AddParameter('CachePath', $CachePath)
  [void]$ps.AddParameter('IncludeFiles', @($IncludeFiles | Where-Object { $_ }))
  try {
    $handle = $ps.BeginInvoke()
    $script:AnalyzerJob = @{ ps = $ps; handle = $handle; started = [DateTime]::UtcNow; timeoutMs = $TimeoutMs }
    return $true
  } catch {
    try { $ps.Dispose() } catch { }
    Write-CoachLog ('analyzer async: ' + $_.Exception.Message)
    return $false
  }
}

function Complete-AnalyzerAsync {
  $job = $script:AnalyzerJob
  if (-not $job) { return $null }
  # Two repos, each with a review call and a brief call, is the ceiling. The
  # budget has to cover that or the pass is killed after it already paid.
  $budget = [int]($job.timeoutMs * 4) + 60000
  $age = ([DateTime]::UtcNow - $job.started).TotalMilliseconds
  if (-not $job.handle.IsCompleted) {
    if ($age -lt $budget) { return $null }
    # Async stop: a model call blocked inside its child process must not cost
    # the dispatcher; BeginStop runs the stop off the UI thread and the next
    # tick sees IsCompleted and collects.
    if (-not $job.stopPending) {
      try { $job.ps.BeginStop($null, $null) } catch { }
      $job.stopPending = $true
    }
    return $null
  }
  $script:AnalyzerJob = $null
  try {
    $out = @($job.ps.EndInvoke($job.handle))
    if ($out.Count -gt 0 -and $out[0]) { return $out[0] }
    return @{ findings = @(); why = 'empty' }
  } catch {
    Write-CoachLog ('analyzer async: ' + $_.Exception.Message)
    return @{ findings = @(); why = 'exception' }
  } finally {
    try { $job.ps.Dispose() } catch { }
  }
}
