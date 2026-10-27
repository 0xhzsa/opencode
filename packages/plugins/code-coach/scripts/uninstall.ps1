# uninstall.ps1 - remove what the coach created, leave opencode alone.
# Stops only processes whose command line points at THIS repo.

param([switch]$KeepData, [switch]$WhatIf)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $root 'src\Coach.Common.ps1')

$key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
if (Get-ItemProperty -Path $key -Name 'CodeCoach' -ErrorAction SilentlyContinue) {
  if (-not $WhatIf) { Remove-ItemProperty -Path $key -Name 'CodeCoach' -Force }
  if ($WhatIf) { Write-Output 'would remove autostart entry HKCU Run\CodeCoach' }
  else { Write-Output 'removed autostart entry HKCU Run\CodeCoach' }
}

$guardPath = Join-Path $root 'scripts\coach-guard.ps1'
$daemonPath = Join-Path $root 'src\Coach.Daemon.ps1'
function Stop-Matching([string]$pattern) {
  try {
    $procs = Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" -ErrorAction Stop |
      Where-Object { $_.CommandLine -and $_.CommandLine -like ('*' + $pattern + '*') }
    foreach ($p in @($procs)) {
      Write-Output ('stopping pid ' + $p.ProcessId)
      if (-not $WhatIf) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
    }
  } catch { }
}

# The guard restarts the daemon, so it has to go first or the daemon returns
# seconds after this script reports it stopped.
Stop-Matching $guardPath
Stop-Matching $daemonPath

$globalDir = Join-Path $env:USERPROFILE '.config\opencode'
$registered = $false
foreach ($candidate in @((Join-Path $globalDir 'opencode.json'), (Join-Path $globalDir 'opencode.jsonc'))) {
  if (-not (Test-Path -LiteralPath $candidate)) { continue }
  try {
    $raw = Get-Content -LiteralPath $candidate -Raw -ErrorAction Stop
    $json = ($raw -replace '(?m)^\s*//.*$', '') | ConvertFrom-Json -ErrorAction Stop
    if (@($json.plugins | Where-Object { $_ -is [string] -and $_ -match 'code-coach' }).Count -gt 0) { $registered = $true }
  } catch { }
}
if ($registered) {
  Write-Output 'note: the plugin is still registered in the global config; remove it with:'
  Write-Output "  opencode plugin remove 'git+https://github.com/anomalyco/opencode.git#path:packages/plugins/code-coach'"
}
$pluginDir = Join-Path $globalDir 'plugin\code-coach'
if (Test-Path -LiteralPath $pluginDir) {
  Write-Output ('note: a local plugin copy is still at ' + $pluginDir + '; remove that folder to stop loading it.')
}

if (-not $KeepData) {
  if (Test-Path -LiteralPath $script:CoachData) {
    Write-Output ('removing data folder ' + $script:CoachData)
    if (-not $WhatIf) { Remove-Item -LiteralPath $script:CoachData -Recurse -Force }
  }
} else {
  Write-Output ('kept data folder ' + $script:CoachData)
}

Write-Output 'done. opencode and its provider keys were not touched.'

