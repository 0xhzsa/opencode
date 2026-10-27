# coach-guard.ps1 - keep one coach daemon alive between logons.
#
# The daemon is a tray app; if it dies, nothing else notices. The old install
# had a guard, the cutover deleted it, and this is its replacement: a small
# loop that starts the daemon when the pid file is missing or stale, and exits
# when the data folder contains a guard.stop file. It never starts a second
# daemon while one is alive; the daemon's own per-data-dir mutex is the final
# backstop.

param(
  [string]$Root = (Split-Path -Parent $PSScriptRoot),
  [int]$IntervalSeconds = 15
)

$ErrorActionPreference = 'SilentlyContinue'
. (Join-Path $Root 'src\Coach.Common.ps1')

$daemon = Join-Path $Root 'src\Coach.Daemon.ps1'
if (-not (Test-Path -LiteralPath $daemon)) { exit 2 }

$pidPath = Join-Path $script:CoachData 'daemon.pid'
$stopPath = Join-Path $script:CoachData 'guard.stop'

Write-CoachLog ('guard: started (interval ' + $IntervalSeconds + 's)')
while (-not (Test-Path -LiteralPath $stopPath)) {
  if (-not (Test-DaemonAlive -PidPath $pidPath)) {
    Write-CoachLog 'guard: daemon not alive, starting'
    # Clear a stale pid so the wait below observes the new daemon's file, not
    # the corpse of the old one.
    Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
    $daemonArgs = @(
      '-NoProfile', '-NonInteractive', '-STA', '-WindowStyle', 'Hidden',
      '-ExecutionPolicy', 'Bypass', '-File', ('"' + $daemon + '"')
    )
    Start-Process -FilePath 'powershell.exe' -ArgumentList $daemonArgs -WindowStyle Hidden
    # A start is successful once the new pid file appears. Do not require that
    # daemon to still be alive: a crash during startup must not turn into a
    # 45-second blind spot (15 s wait + 30 s backoff). The main loop retries.
    $deadline = (Get-Date).AddSeconds(10)
    while ((Get-Date) -lt $deadline -and -not (Test-Path -LiteralPath $pidPath)) {
      Start-Sleep -Seconds 1
    }
    if (-not (Test-Path -LiteralPath $pidPath)) {
      Write-CoachLog 'guard: daemon wrote no pid; retrying next tick'
      Start-Sleep -Seconds 5
    }
  }
  Start-Sleep -Seconds $IntervalSeconds
}
Write-CoachLog 'guard: stopped (guard.stop)'
