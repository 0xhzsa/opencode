# Rules.ps1 - headless tests for src/Coach.Rules.ps1.
#
# No daemon, no window, no clipboard, no desktop: the rules are pure string
# matching, so every branch is asserted directly. This is the test that runs
# anywhere PowerShell runs, including a CI box with no interactive session.
#
# Exits non-zero if any check fails.

$ErrorActionPreference = 'Stop'

. (Join-Path (Split-Path -Parent $PSScriptRoot) 'src\Coach.Rules.ps1')

$checks = 0
$fails = 0

function Check([string]$Name, [bool]$Ok, [string]$Detail = '') {
  $script:checks++
  if ($Ok) {
    Write-Output ('[PASS] ' + $Name)
  } else {
    $script:fails++
    if ($Detail) { Write-Output ('[FAIL] ' + $Name + ' :: ' + $Detail) }
    else { Write-Output ('[FAIL] ' + $Name) }
  }
}

function Kind([string]$Text) { (Get-CoachDecision $Text).kind }

# --- destructive -----------------------------------------------------------

Check 'delete logs -> destructive' ((Kind 'delete all the logs from last week') -eq 'destructive')
Check 'remove cache -> destructive' ((Kind 'remove the old cache') -eq 'destructive')
Check 'clear build output -> destructive' ((Kind 'clear the build output') -eq 'destructive')
Check 'delete users table -> destructive' ((Kind 'delete the users table') -eq 'destructive')
Check 'drop table -> destructive' ((Kind 'drop table users') -eq 'destructive')
Check 'rm -rf -> destructive' ((Kind 'rm -rf node_modules') -eq 'destructive')
Check 'guarded delete -> silent' ((Kind 'delete the old logs after committing the current state first') -eq 'none')
Check 'dry run -> silent' ((Kind 'delete the cache, dry run only') -eq 'none')
Check 'one file -> silent' ((Kind 'reset this file only') -eq 'none')
Check 'delete a named file -> silent' ((Kind 'delete src/app.ts') -eq 'none')
Check 'delete all .ts files -> destructive' ((Kind 'delete all the .ts files in src') -eq 'destructive')

# --- silence ---------------------------------------------------------------

Check 'plain question -> silent' ((Kind 'summarize the current state of the parser') -eq 'none')
Check 'login bug fix -> silent' ((Kind 'fix the login flow so the second attempt works') -eq 'none')
Check 'unrelated endpoint -> silent' ((Kind 'create an API endpoint that returns the current time') -eq 'none')
Check 'empty -> silent' ((Kind '') -eq 'none')

# --- security: the example from the design issue ---------------------------

$example = 'Add a login endpoint that checks the user''s password against the database'
$d = Get-CoachDecision $example
$ids = @($d.findings | ForEach-Object { $_.id })
Check 'password example -> security card' ($d.kind -eq 'security')
Check 'password example names two findings' (@($d.findings).Count -eq 2) (@($d.findings).Count.ToString() + ' findings')
Check 'password example finds plaintext compare' ($ids -contains 'password')
Check 'password example finds missing rate limit' ($ids -contains 'rate')
Check 'password example title counts two' ($d.title -eq '2 things before you accept this') $d.title
Check 'password example body numbers the findings' ($d.body -like '1. *' -and $d.body -like '*2. *')
Check 'password example has explain text' ($d.explain.body -like '*one-way function*')
Check 'password example has three buttons' (@($d.buttons).Count -eq 3)
$explainCount = @($d.buttons | Where-Object { $_.action -eq 'explain' }).Count
$fixCount = @($d.buttons | Where-Object { $_.action -eq 'fix' }).Count
$ignoreCount = @($d.buttons | Where-Object { $_.action -eq 'ignore' }).Count
Check 'password example offers Explain why' ($explainCount -eq 1) ($explainCount.ToString())
Check 'password example offers Fix my prompt' ($fixCount -eq 1) ($fixCount.ToString())
Check 'password example offers Ignore' ($ignoreCount -eq 1) ($ignoreCount.ToString())
Check 'fixed prompt keeps the original ask' ($d.fixed -like 'Add a login endpoint*')
Check 'fixed prompt names bcrypt or argon2' ($d.fixed -match 'bcrypt|argon2id')
Check 'fixed prompt adds rate limiting' ($d.fixed -match 'rate-limit')
Check 'fixed prompt adds generic errors' ($d.fixed -match 'generic errors')
Check 'fixed prompt is not the original' ($d.fixed -ne $example)

# --- security: suppression --------------------------------------------------

$safe = 'Add a login endpoint. Hash passwords with bcrypt, compare in constant time, rate-limit to 5 attempts per minute per IP'
Check 'hashed and rate limited -> silent' ((Kind $safe) -eq 'none') (Kind $safe)
$bcryptFindings = @((Get-CoachDecision 'Add a login endpoint that stores bcrypt passwords in the database').findings | Where-Object { $_.id -eq 'password' })
$limitedFindings = @((Get-CoachDecision 'Add a login endpoint that checks the password against the database, rate limited to 5 per minute').findings | Where-Object { $_.id -eq 'rate' })
Check 'bcrypt alone suppresses the hash finding' ($bcryptFindings.Count -eq 0) ($bcryptFindings.Count.ToString())
Check 'rate limiting alone suppresses the rate finding' ($limitedFindings.Count -eq 0) ($limitedFindings.Count.ToString())

# --- security: single finding ----------------------------------------------

$one = Get-CoachDecision 'add a password reset endpoint'
Check 'password reset endpoint -> security' ($one.kind -eq 'security')
Check 'password reset endpoint names one finding' (@($one.findings).Count -eq 1) (@($one.findings).Count.ToString() + ' findings')
Check 'password reset endpoint title is singular' ($one.title -eq '1 thing before you accept this') $one.title

# --- precedence -------------------------------------------------------------

Check 'destructive wins over security' ((Kind 'delete the password table') -eq 'destructive')

Write-Output ''
Write-Output ('checks: ' + $checks + '  failed: ' + $fails)
if ($fails -gt 0) { exit 1 }
Write-Output 'rules: PASS'
