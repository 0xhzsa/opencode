# Coach.Common.ps1 - paths, config, atomic writes, kill switch, single instance.
# Loaded by the daemon and by the tests. No UI, no UIA, no network.

$script:CoachRoot = Split-Path -Parent $PSScriptRoot

$script:CoachData = if ($env:COACH_DATA_DIR) { $env:COACH_DATA_DIR } else { Join-Path $env:LOCALAPPDATA 'CodeCoachData' }
$script:ConfigPath   = Join-Path $script:CoachData 'config.json'
$script:TracePath    = Join-Path $script:CoachData 'trace.jsonl'
$script:EventsPath   = Join-Path $script:CoachData 'events.jsonl'
$script:LearnerPath  = Join-Path $script:CoachData 'learner.json'
$script:ProjectsPath = Join-Path $script:CoachData 'projects.json'
$script:DraftsPath   = Join-Path $script:CoachData 'drafts.local'
$script:SeenCodePath = Join-Path $script:CoachData 'seen-code.json'
$script:StatePath    = Join-Path $script:CoachData 'state.json'
$script:KillPath     = Join-Path $script:CoachData 'KILL'
$script:LogPath      = Join-Path $script:CoachData 'coach.log'

$script:CoachDefaults = @{
  version                 = 2
  capture                 = $false
  storeDraftText          = $false
  maxInterruptionsPerHour = 6
  cardExcludeFromCapture  = $true
  watchSurfaces           = $false
  pauseUntil              = $null
  registeredRoots         = @()
  codeScanSeconds         = 180
  codeMaxFindings         = 1
  codeCardSeconds         = 45
  codeRepeatHours         = 24
  promptMode              = 'autosend'
  # The analyzer is the background engine: it watches the diff and the files in
  # it with a model, off the UI thread, and its results feed the code card and
  # the prompt context. It never blocks a send; the gate only reads its cache.
  analyzerEnabled         = $true
  analyzerExe             = ''
  analyzerModel           = 'opencode/glm-5.3-flash-free'
  analyzerAgent           = 'code-reviewer'
  analyzerTimeoutSeconds  = 90
  analyzerScanSeconds     = 300
  analyzerCooldownMinutes = 60
  analyzerMaxFindings     = 2
  analyzerMaxContextBytes = 120000
  analyzerCacheHours      = 168
  # Triage is the prompt lane's model partner: a fast call on the digest, in
  # the seconds after a send leaves, that either shows a nudge card or says
  # nothing. Silence is the default. Timeout covers the CLI's own boot plus
  # the model call: standalone opencode run measured ~8s warm, more cold.
  triageEnabled           = $true
  triageModel             = 'opencode/glm-5.3-flash-free'
  triageTimeoutSeconds    = 75
  triageScanSeconds       = 30
  triageMaxPerHour        = 3
  triageExplainSeconds    = 180
  # How long the first nudge card stays on screen. Long enough to read 60
  # words and pick an action; hovering freezes the countdown. Explain why has
  # its own, longer window because the teaching is the part worth reading.
  nudgeCardSeconds        = 120
  surfaceCardSeconds      = 30
  # Tried when the primary triageModel fails fast (dead key, model gone,
  # capacity wall) and budget remains: a healthy fallback inside the same
  # triage window is how the lane survives an upstream rotating a free model
  # away. Empty means primary only.
  triageFallbackModels    = @('opencode/glm-5.3-flash-free')
  # Minutes of quiet a Snooze click on a nudge card buys. Only the post-send
  # triage lane goes silent; gap cards keep their own discipline. Zero or a
  # negative number falls back to the 120 default.
  triageSnoozeMinutes     = 120
  # Optional direct provider lane. When all three are set, triage calls any
  # OpenAI-compatible /chat/completions endpoint with the developer's own
  # key: OpenAI, DeepSeek, Kimi, OpenRouter, or a local Ollama/LM Studio.
  # The key is read from the named environment variable at call time and is
  # never logged, traced or stored. When any of the three is empty, triage
  # falls back to the legacy CLI lane above (the Nous free pool).
  triageApiBase           = ''
  triageApiKeyEnv         = ''
  triageModelName         = ''
}

# autosend: compile and send, no card, no wait. review: hold the send behind a
# card. off: never touch a prompt. An unknown value is autosend, because the
# compiled prompt is the product and a typo should not silently disable it.
function Get-PromptMode($Config) {
  $mode = ([string](Get-CtxValue $Config 'promptMode')).Trim().ToLowerInvariant()
  if ($mode -in @('autosend', 'review', 'off')) { return $mode }
  return 'autosend'
}

function Initialize-CoachData {
  if (-not (Test-Path -LiteralPath $script:CoachData)) {
    New-Item -ItemType Directory -Force -Path $script:CoachData | Out-Null
  }
  if (-not (Test-Path -LiteralPath $script:ConfigPath)) {
    Write-JsonAtomic $script:ConfigPath $script:CoachDefaults
  }
}

function Write-JsonAtomic([string]$Path, $Object) {
  $dir = Split-Path -Parent $Path
  if ($dir -and -not (Test-Path -LiteralPath $dir)) {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
  }
  $tmp = $Path + '.' + [Guid]::NewGuid().ToString('N').Substring(0, 8) + '.tmp'
  $json = $Object | ConvertTo-Json -Depth 8
  [IO.File]::WriteAllText($tmp, $json, (New-Object Text.UTF8Encoding($false)))
  Move-Item -LiteralPath $tmp -Destination $Path -Force
}

function Read-JsonFile([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  try {
    $raw = [IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8)
    if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
    return ($raw | ConvertFrom-Json)
  } catch {
    # Silence here once deleted a developer's whole setup with no word of it:
    # malformed JSON -> $null -> the session ran on defaults and the provider
    # keys "disappeared". Name the file and the parse error. If the log
    # helper is not loaded yet, the original failure surface stays $null.
    if (Get-Command Write-CoachLog -ErrorAction SilentlyContinue) {
      Write-CoachLog ('json read failed at ' + $Path + ': ' + $_.Exception.Message)
    }
    return $null
  }
}

# Cross-restart memory for the two things a restart must not refund: the hourly
# budgets and a Snooze the developer clicked. Everything else in the daemon is
# deliberately in-memory, but "quiet for 120 minutes" that ends when the process
# restarts is a lie. The file is small, written atomically, and optional: a
# missing file is a cold start, not an error.
function Read-CoachState {
  return (Read-JsonFile $script:StatePath)
}

function Save-CoachState($State) {
  try {
    Write-JsonAtomic $script:StatePath $State
    return $true
  } catch {
    if (Get-Command Write-CoachLog -ErrorAction SilentlyContinue) {
      Write-CoachLog ('state write failed at ' + $script:StatePath + ': ' + $_.Exception.Message)
    }
    return $false
  }
}

# The gate request carries a compact context digest from the plugin. It can be
# a hashtable (tests, PowerShell callers) or a PSCustomObject (JSON from the
# plugin), so every reader goes through these two helpers.
function Get-CtxValue($Ctx, [string]$Name) {
  if (-not $Ctx) { return $null }
  if ($Ctx -is [System.Collections.IDictionary]) {
    if ($Ctx.Contains($Name)) { return $Ctx[$Name] }
    return $null
  }
  $p = $Ctx.PSObject.Properties[$Name]
  if ($p) { return $p.Value }
  return $null
}

function Get-CtxList($Ctx, [string]$Name) {
  $v = Get-CtxValue $Ctx $Name
  if ($null -eq $v) { return @() }
  if ($v -is [string]) { if ([string]::IsNullOrWhiteSpace($v)) { return @() }; return @($v) }
  return @($v | Where-Object { $_ -ne $null -and -not [string]::IsNullOrWhiteSpace([string]$_) } | ForEach-Object { [string]$_ })
}

function Get-CoachConfig {
  $cfg = $null
  if (Test-Path -LiteralPath $script:ConfigPath) {
    $cfg = Read-JsonFile $script:ConfigPath
    if (-not $cfg) {
      # The file exists but yields nothing: malformed JSON (the parse error
      # is already in coach.log). Say the fallback out loud here too - the
      # config is state someone cares about.
      Write-CoachLog ('config unreadable at ' + $script:ConfigPath + ' - running on defaults until it is fixed')
    }
  }
  $out = @{}
  foreach ($k in $script:CoachDefaults.Keys) { $out[$k] = $script:CoachDefaults[$k] }
  if ($cfg) {
    foreach ($p in $cfg.PSObject.Properties) {
      if ($out.ContainsKey($p.Name)) { $out[$p.Name] = $p.Value }
    }
  }
  return $out
}

function Save-CoachConfig($Config) { Write-JsonAtomic $script:ConfigPath $Config }

function Test-CoachKilled { return (Test-Path -LiteralPath $script:KillPath) }

function Get-CoachPauseSeconds($Config) {
  if (-not $Config -or -not $Config.pauseUntil) { return 0 }
  try {
    $until = [DateTimeOffset]::Parse([string]$Config.pauseUntil)
    $left = ($until - [DateTimeOffset]::UtcNow).TotalSeconds
    if ($left -gt 0) { return [int]$left }
  } catch { }
  return 0
}

function Test-CoachSilent($Config) {
  if (Test-CoachKilled) { return $true }
  if ((Get-CoachPauseSeconds $Config) -gt 0) { return $true }
  return $false
}

function Write-CoachLog([string]$Message) {
  try {
    if (-not (Test-Path -LiteralPath $script:CoachData)) {
      New-Item -ItemType Directory -Force -Path $script:CoachData | Out-Null
    }
    if ((Test-Path -LiteralPath $script:LogPath) -and (Get-Item -LiteralPath $script:LogPath).Length -gt 1MB) {
      Move-Item -LiteralPath $script:LogPath -Destination (Join-Path $script:CoachData 'coach.1.log') -Force
    }
    $line = '{0} {1}' -f ([DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss.fff')), $Message
    [IO.File]::AppendAllText($script:LogPath, $line + "`r`n", (New-Object Text.UTF8Encoding($false)))
  } catch { }
}

# The old install is the live coach until cutover. Never touch it; only notice it.
function Test-OldCoachRunning {
  $found = @()
  try {
    $procs = Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" -ErrorAction Stop |
      Where-Object { $_.CommandLine -and $_.CommandLine -match 'AppData\\Local\\CodeCoach\\coach-(daemon|guard)\.ps1' }
    foreach ($p in $procs) {
      $found += [pscustomobject]@{ pid = [int]$p.ProcessId; cmd = [string]$p.CommandLine }
    }
  } catch { }
  return $found
}

function Enter-CoachInstance {
  # One instance per data folder, not per machine: the tests run a second daemon
  # against a temp folder while the real one is live, and they cannot collide.
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    $h = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($script:CoachData.TrimEnd('\').ToLowerInvariant()))
    $tag = (($h[0..5] | ForEach-Object { $_.ToString('x2') }) -join '')
  } finally { $sha.Dispose() }
  $m = New-Object Threading.Mutex($false, ('Local\CodeCoachV2-' + $tag))
  $got = $false
  try {
    $got = $m.WaitOne(0)
  } catch [Threading.AbandonedMutexException] {
    $got = $true
  }
  if (-not $got) {
    $m.Dispose()
    return $null
  }
  return $m
}

# Supervision: is the pid in the file a live process? The guard uses this to
# decide whether the daemon needs a restart. Any unreadable or stale pid file
# is dead, not an error.
function Test-DaemonAlive {
  param([string]$PidPath = (Join-Path $script:CoachData 'daemon.pid'))
  if (-not $PidPath -or -not (Test-Path -LiteralPath $PidPath)) { return $false }
  $raw = ''
  try { $raw = [string](Get-Content -LiteralPath $PidPath -Raw -ErrorAction Stop) } catch { return $false }
  $m = [regex]::Match($raw, '\d+')
  if (-not $m.Success) { return $false }
  $procId = 0
  if (-not [int]::TryParse($m.Value, [ref]$procId)) { return $false }
  if ($procId -le 0) { return $false }
  return [bool](Get-Process -Id $procId -ErrorAction SilentlyContinue)
}
