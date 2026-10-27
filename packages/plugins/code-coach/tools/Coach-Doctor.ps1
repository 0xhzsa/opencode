# Coach-Doctor.ps1 - one command: is the coach watching me, and can it nudge me?
# Prints only facts that are safe to share: modes, names, numbers, timestamps.
# Never prints keys (there are none on disk by design) or prompt text (there
# is none anywhere in these files by design).

$ErrorActionPreference = 'Continue'
$data = if ($env:COACH_DATA_DIR) { $env:COACH_DATA_DIR } else { Join-Path $env:LOCALAPPDATA 'CodeCoachData' }
$fails = 0
$warns = 0

function Line([string]$State, [string]$Text) { Write-Output ("[$State] " + $Text) }
function Fail([string]$Text) { $script:fails++; Line 'FAIL' $Text }
function Warn([string]$Text) { $script:warns++; Line 'WARN' $Text }
function Ok([string]$Text)   { Line 'OK'   $Text }

Write-Output "Code Coach doctor  -  $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Write-Output "data dir: $data"
Write-Output ""

# 1. daemon
$pidPath = Join-Path $data 'daemon.pid'
$proc = $null
if (Test-Path $pidPath) {
  $daemonPid = [int](Get-Content $pidPath -ErrorAction SilentlyContinue)
  $proc = Get-Process -Id $daemonPid -ErrorAction SilentlyContinue
  if ($proc) {
    $up = [int]((Get-Date) - $proc.StartTime).TotalMinutes
    Ok ("daemon alive: pid $daemonPid, up $up min")
  } else {
    Fail "pid $daemonPid in daemon.pid is not running - the guard should restart it within ~15 s; rerun this script"
  }
} else {
  Fail "no daemon.pid - the daemon never started; run scripts\install-autostart.ps1 once"
}

# 2. autonomy guard (restarts the daemon after a crash)
$run = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -ErrorAction SilentlyContinue
$guardCmd = $run.CodeCoach
if ($guardCmd -and ($guardCmd -like '*coach-guard*')) {
  Ok 'logon guard installed: HKCU Run\CodeCoach points at coach-guard.ps1'
} elseif ($guardCmd) {
  Warn "HKCU Run\CodeCoach exists but does not point at coach-guard.ps1: $guardCmd"
} else {
  Warn 'no HKCU Run\CodeCoach - a crashed daemon stays down until logon; run scripts\install-autostart.ps1'
}

# 3. the opencode plugin (the watcher half). `opencode plugin add` writes the
# Git specifier into the global config; a checkout alone never loads. A local
# directory under the auto-load plugin tree is the development layout, and both
# count as registered here.
$globalDir = Join-Path $env:USERPROFILE '.config\opencode'
$pluginSpec = $null
foreach ($candidate in @((Join-Path $globalDir 'opencode.json'), (Join-Path $globalDir 'opencode.jsonc'))) {
  if (-not (Test-Path -LiteralPath $candidate)) { continue }
  try {
    $raw = Get-Content -LiteralPath $candidate -Raw -ErrorAction Stop
    $json = ($raw -replace '(?m)^\s*//.*$', '') | ConvertFrom-Json -ErrorAction Stop
    $entry = @($json.plugins | Where-Object { $_ -is [string] -and $_ -match 'code-coach' }) | Select-Object -First 1
    if ($entry) { $pluginSpec = $entry; break }
  } catch { }
}
$pluginFile = @(
  (Join-Path $globalDir 'plugin\code-coach\index.ts'),
  (Join-Path $globalDir 'plugin\code-coach\index.js')
) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if ($pluginSpec) {
  Ok ("opencode plugin registered in global config: $pluginSpec")
} elseif ($pluginFile) {
  Ok ("opencode plugin present in the auto-load tree: $pluginFile")
} else {
  Fail "plugin is not registered - run: opencode plugin add 'git+https://github.com/anomalyco/opencode.git#path:packages/plugins/code-coach'"
}

# 4. plugin evidence it actually gated a send recently
$plogPath = Join-Path $data 'logs\plugin.log'
$lastPrompt = $null
$lastLine = $null
if (Test-Path $plogPath) {
  $lines = @(Get-Content $plogPath -Tail 400 -ErrorAction SilentlyContinue)
  for ($i = $lines.Count - 1; $i -ge 0; $i--) {
    # New lines carry [pid]; old ones do not, so both shapes match.
    if ($lines[$i] -match '^\S+\s+(?:\[\d+\]\s+)?prompt ') { $lastPrompt = $lines[$i]; break }
  }
  $lastLine = $lines | Select-Object -Last 1
}
if ($lastPrompt) {
  $ts = [DateTime]$lastPrompt.Substring(0, 23)
  $ageMin = [int]((Get-Date).ToUniversalTime() - $ts).TotalMinutes
  $len = if ($lastPrompt -match 'prompt len=(\d+)') { $Matches[1] } else { '?' }
  if ($ageMin -le 60) { Ok ("plugin gated a prompt ${ageMin} min ago (len $len) - it is live and watching") }
  else { Warn "last gated prompt was $ageMin min ago (len $len) - recent sessions may have been bypassed" }
} else {
  Warn "no 'prompt' lines in plugin.log yet - send one prompt from opencode and rerun"
}
# The analyzer runs its own `opencode run` children with COACH_BYPASS set, and
# they log 'skip: bypass' without ever gating a prompt. Only a process that
# gated prompts and then bypassed is worth a warning.
if ($lastLine -and $lastLine -match 'skip: bypass') {
  $bypassPid = if ($lastLine -match '\[(\d+)\]') { $Matches[1] } else { '' }
  $samePidPrompts = 0
  if ($bypassPid) {
    $samePidPrompts = @($lines | Where-Object { $_ -match ('\[' + $bypassPid + '\] prompt ') }).Count
  }
  if ($samePidPrompts -gt 0) {
    Warn "newest plugin entry says 'skip: bypass' for pid $bypassPid, which gated prompts earlier - that session had COACH_BYPASS set; your main sessions should not."
  } else {
    Ok ("newest plugin entry is a bypass from a side-spawn (pid $bypassPid); it never gated a prompt")
  }
}
$envBypass = $env:COACH_BYPASS
if ($envBypass -and ($envBypass.Trim() -notin @('0', 'false', 'no'))) {
  Warn "THIS shell has COACH_BYPASS=$envBypass - sends made from it skip the coach"
}

# 5. the IPC folder must be writable (plugin <> daemon courier)
$ipc = Join-Path $data 'ipc'
if (-not (Test-Path $ipc)) { Fail "missing $ipc - the gate has nowhere to talk" }
else {
  $probe = Join-Path $ipc '.doctor-write-probe.tmp'
  try {
    Set-Content -LiteralPath $probe -Value 'probe' -ErrorAction Stop
    $null = Get-Content $probe -ErrorAction Stop
    Remove-Item $probe -Force -ErrorAction Stop
    Ok 'ipc folder writable (probe round-tripped)'
  } catch {
    Fail "ipc folder not writable: $($_.Exception.Message)"
  }
}

# 6. config sanity (keys never live here; only env-var names and model names)
$cfgPath = Join-Path $data 'config.json'
if (-not (Test-Path $cfgPath)) { Fail 'no config.json - falling back to defaults silently' }
else {
  $cfg = $null
  try { $cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json -ErrorAction Stop } catch { Fail "config.json is not readable JSON: $($_.Exception.Message)" }
  if ($cfg) {
    Ok ("promptMode: $($cfg.promptMode)  (autosend = weaker drafts get context attached silently; review = cards pre-send; off = prompt lane off)")
    $roots = @($cfg.registeredRoots | Where-Object { $_ })
    foreach ($r in $roots) {
      if (Test-Path $r) { Ok "registered root exists: $r" } else { Fail "registered root missing on disk: $r" }
    }
    $byo = ($cfg.triageApiBase -and $cfg.triageApiKeyEnv -and $cfg.triageModelName)
    $envVal = $null
    if ($cfg.triageApiKeyEnv) { $envVal = [Environment]::GetEnvironmentVariable($cfg.triageApiKeyEnv, 'User'); if (-not $envVal) { $envVal = [Environment]::GetEnvironmentVariable($cfg.triageApiKeyEnv, 'Machine') } }
    if ($byo -and $envVal) {
      Ok "triage lane: your own provider $($cfg.triageApiBase) -> $($cfg.triageModelName), env var $($cfg.triageApiKeyEnv) is set"
    } elseif ($byo) {
      Warn "triage lane points at $($cfg.triageApiBase) but env var $($cfg.triageApiKeyEnv) is not visible here (set it for User, then restart the daemon from a new shell)"
    } elseif ($cfg.triageFallbackModels -and @($cfg.triageFallbackModels).Count -gt 0) {
      Ok "triage lane: built-in free pool (fallback chain with $(@($cfg.triageFallbackModels).Count) model(s))"
    } else {
      Warn 'no triage lane configured and no free-pool fallbacks - post-send nudges would be skipped (why=no-cli)'
    }
    $triHour = [int]$cfg.triageMaxPerHour
    if ($triHour -le 0) { $triHour = 3 }   # default in src/Coach.Common.ps1 $script:CoachDefaults
    $snoozeMin = if ($cfg.triageSnoozeMinutes) { [int]$cfg.triageSnoozeMinutes } else { 0 }
    if ($snoozeMin -le 0) { $snoozeMin = 120 }
    Ok ("interruption budget: max $($cfg.maxInterruptionsPerHour) prompt-cards/hour, triage max $triHour/hour, snooze buys $snoozeMin min")
  }
}

# 7. analyzer cache age (facts for triage and prompt attachment). The cache is
# keyed by file content hash, so an unchanged repo never rewrites it; compare
# against the configured TTL, not wall-clock freshness.
$cache = Join-Path $data 'analyzer-cache.json'
if (Test-Path $cache) {
  $ageH = [int]((Get-Date) - (Get-Item $cache).LastWriteTime).TotalHours
  $ttlH = 168
  if ($cfg -and $cfg.analyzerCacheHours) { $ttlH = [int]$cfg.analyzerCacheHours }
  if ($ageH -le $ttlH) { Ok "analyzer briefs: cache written ${ageH}h ago, content-keyed, TTL ${ttlH}h (current)" }
  else { Warn "analyzer briefs are $ageH h old (TTL ${ttlH}h) - nudges about changed files answer why=no-facts until a pass re-runs" }
} else {
  Warn 'no analyzer cache yet - first pass after boot builds it (needs git repos under a registered root)'
}

# 8. last thing the coach showed, for peace of mind ("it is working")
$trace = Join-Path $data 'trace.jsonl'
if (Test-Path $trace) {
  $card = $null
  $lines = @(Get-Content $trace -Tail 600 -ErrorAction SilentlyContinue)
  for ($i = $lines.Count - 1; $i -ge 0; $i--) {
    if ($lines[$i] -match '"ev":"card_shown"') { $card = $lines[$i]; break }
  }
  if ($card -and $card -match '"ts":(\d+)') {
    $min = [int](((Get-Date).ToUniversalTime() - [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$Matches[1]).UtcDateTime).TotalMinutes)
    $kind = if ($card -match '"kind":"([^"]*)"') { $Matches[1] } else { '?' }
    Ok ("most recent card: kind=$kind, $min min ago")
  } else {
    Warn 'no cards in the recent trace window - remember, silence is the default and is correct'
  }
}

Write-Output ""
if ($script:fails -gt 0) { Write-Output "doctor verdict: NO-GO ($script:fails fail, $script:warns warn)"; exit 2 }
Write-Output "doctor verdict: GO ($script:warns warn, $script:fails fail)"
exit 0
