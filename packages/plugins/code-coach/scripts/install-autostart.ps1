# install-autostart.ps1 - register the coach at logon (HKCU Run).
# Refuses while another coach install is live or registered, because two
# coaches would double-card.

param([switch]$Force)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $root 'src\Coach.Common.ps1')

$old = @(Test-OldCoachRunning)
if ($old.Count -gt 0 -and -not $Force) {
  Write-Output ('refused: the old install is still running (pid ' + (($old | ForEach-Object { $_.pid }) -join ',') + ')')
  Write-Output 'autostart is installed at cutover (phase 8), not before.'
  exit 3
}

# A second checkout is the same double-card failure as the pre-cutover install:
# two guards, two daemons, two cards. Refuse when this checkout is not the one
# already registered, or when a coach process points somewhere else.
$key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$registered = (Get-ItemProperty -Path $key -Name 'CodeCoach' -ErrorAction SilentlyContinue).CodeCoach
if ($registered -and ($registered -notlike ('*' + $root + '*')) -and -not $Force) {
  Write-Output ('refused: HKCU Run\CodeCoach already points at another checkout: ' + $registered)
  Write-Output 'run scripts\uninstall.ps1 there first, or pass -Force to replace it.'
  exit 4
}
$foreign = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -match 'coach-guard\.ps1|Coach\.Daemon\.ps1' -and $_.CommandLine -notlike ('*' + $root + '*') })
if ($foreign.Count -gt 0 -and -not $Force) {
  Write-Output ('refused: a coach from another checkout is running (pid ' + (($foreign | ForEach-Object { $_.ProcessId }) -join ',') + ')')
  Write-Output 'run scripts\uninstall.ps1 there first, or pass -Force to replace it.'
  exit 4
}

$daemon = Join-Path $root 'src\Coach.Daemon.ps1'
$guard = Join-Path $root 'scripts\coach-guard.ps1'
if (-not (Test-Path -LiteralPath $daemon)) { throw "missing $daemon" }
if (-not (Test-Path -LiteralPath $guard)) { throw "missing $guard" }

# The guard starts the daemon and restarts it if it dies. Pointing the Run key
# at the daemon directly would leave a crash silent until the next logon.
$cmd = 'powershell.exe -NoProfile -NonInteractive -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $guard + '" -Root "' + $root + '"'
Set-ItemProperty -Path $key -Name 'CodeCoach' -Value $cmd -Type String
Write-Output ('autostart written: HKCU Run\CodeCoach -> ' + $cmd)

$startup = [Environment]::GetFolderPath('Startup')
foreach ($name in @('CodeCoach.vbs')) {
  $p = Join-Path $startup $name
  if (Test-Path -LiteralPath $p) {
    Write-Output ('note: old startup shortcut still present, remove at cutover: ' + $p)
  }
}
