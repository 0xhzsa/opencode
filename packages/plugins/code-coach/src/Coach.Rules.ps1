# Coach.Rules.ps1 - the deterministic decisions behind every card.
#
# Pure string matching. No model call, no network, no session access. Kept in
# its own file so tests/Rules.ps1 can assert every branch without a desktop.
#
# Two kinds of card:
#   destructive - a delete/rewrite ask with no recovery point
#   security    - a credential ask that will produce plaintext password
#                 handling, missing rate limiting, or both
#
# Silence is the default and the overwhelmingly common answer.

$script:ReGuard = '(?i)\b(backup|backed up|commit\w*\s+(?:first|before|the current)|dry[- ]?run|snapshot|confirm|only|specific|this file|one file)\b'
$script:ReFile = '(?i)\b[\w./\\-]+\.(ps1|psm1|psd1|js|mjs|cjs|ts|tsx|jsx|py|cs|go|rs|rb|java|kt|swift|json|ya?ml|toml|md|css|html|sql|sh|bash|bat|cmd|c|h|cpp|hpp)\b'
$script:ReHard = '(?i)\b(rm\s+-rf|git\s+clean|force[- ]?push|drop\s+table|truncate\s+table)\b'
$script:ReVerb = '(?i)\b(delete|deletes|deleting|reset|resets|resetting|drop|drops|dropping|truncate|truncates|truncating|overwrite|overwrites|overwriting|wipe|wipes|wiping|purge|purges|purging|destroy|destroys|destroying|remove|removes|removing|clear|clears|clearing)\b'
$script:ReObject = '(?i)\b(files?|folders?|directories?|dirs?|data|database|db|tables?|rows?|records?|logs?|history|branch(es)?|commits?|repo(sitory)?|worktree|build|output|cache|config|credentials?|secrets?|disk|drive|migrations?)\b'

$script:ReCredential = '(?i)\b(password|passwd|passphrase|passwords|credential|credentials|login|log in|signin|sign in|sign-in)\b'
$script:ReBuild = '(?i)\b(add|adds|adding|create|creates|creating|build|builds|building|implement|implements|implementing|make|makes|making|write|writes|writing|set up|setup|wire|wires|wiring)\b'
$script:ReAuthSurface = '(?i)\b(endpoint|route|form|page|handler|service|flow|api|controller|view|screen|middleware|portal|backend)\b'
$script:ReCompare = '(?i)\b(compare|compares|comparing|check|checks|checking|verify|verifies|verifying|validate|validates|validating|against the database|against the db|against db|store|stores|storing|save|saves|saving|plaintext|plain[- ]text|==|===|equals)\b'
$script:ReHashed = '(?i)\b(bcrypt|argon2\w*|scrypt|pbkdf2|hash|hashed|hashes|hashing|salt|salted|salting|constant[- ]?time|timing[- ]?safe)\b'
$script:ReRateLimit = '(?i)\b(rate[- ]?limit\w*|ratelimit\w*|throttl\w*|backoff|lockout|lock[- ]?out|attempts? per|max(imum)? attempts|captcha|fail2ban|brute[- ]?force protection)\b'

$script:Guardrail = 'Before you delete or rewrite anything, commit the current state, take a backup, and run the change against one target first; confirm the result before widening it.'

$script:FindingPassword = @{
  id    = 'password'
  label = 'Passwords would be compared in plaintext'
  body  = 'Nothing here says the password is hashed, so the obvious implementation compares the stored value with == . Passwords must be one-way: store hash(password) with a per-user salt, and compare in constant time.'
  why   = 'A hash is a one-way function. You store hash(password), and at login you hash what the user typed and compare. Even you cannot recover the original. Two users who pick the same password would produce the same hash, which is why a per-user salt is the next concept.'
}

$script:FindingRate = @{
  id    = 'rate'
  label = 'No rate limiting on the credential path'
  body  = 'Nothing here limits attempts, so one client can try thousands of passwords a minute against the same account.'
  why   = 'A login endpoint without a limit turns a slow guess into an offline-speed one. Rate limiting per IP and per account, with a short lockout, is what reduces thousands of attempts a minute to a handful.'
}

$script:FixedPromptSuffix = 'Use bcrypt or argon2id with a per-user salt, compare in constant time, rate-limit to 5 attempts per minute per IP and per account, and return generic errors that do not reveal whether an account exists.'

function Test-Destructive([string]$Text) {
  $t = [string]$Text
  if (-not $t) { return $false }
  if ($t -match $script:ReGuard) { return $false }
  if ($t -match $script:ReHard) { return $true }
  if (-not (($t -match $script:ReVerb) -and ($t -match $script:ReObject))) { return $false }
  # Naming one file is a specific target, not a broad sweep. "delete all the
  # .ts files" still counts, because the ask is not one target.
  if (($t -match $script:ReFile) -and -not ($t -match '(?i)\b(all|everything|every)\b')) { return $false }
  return $true
}

function Test-AuthAsk([string]$Text) {
  $t = [string]$Text
  if (-not $t) { return $false }
  return (($t -match $script:ReCredential) -and ($t -match $script:ReBuild) -and ($t -match $script:ReAuthSurface))
}

function Get-SecurityFindings([string]$Text) {
  $t = [string]$Text
  $found = @()
  if (-not $t) { return $found }
  if (-not (Test-AuthAsk $t)) { return $found }
  if (-not ($t -match $script:ReHashed)) {
    if ($t -match $script:ReCompare) { $found += $script:FindingPassword }
  }
  if (-not ($t -match $script:ReRateLimit)) { $found += $script:FindingRate }
  return $found
}

# Returns a decision the daemon can render without deciding anything itself.
#   @{ kind = 'none' }
#   @{ kind = 'destructive'; title; body; buttons; guardrail }
#   @{ kind = 'security'; title; body; findings; explain; fixed; buttons }
function Get-CoachDecision([string]$Text) {
  $t = [string]$Text
  if (-not $t) { return @{ kind = 'none' } }

  if (Test-Destructive $t) {
    return @{
      kind      = 'destructive'
      title     = 'Destructive ask without a recovery point'
      body      = 'This deletes or rewrites state, and nothing in the ask makes it reversible. Copy the guardrail and paste it into the conversation.'
      guardrail = $script:Guardrail
      buttons   = @(
        @{ id = 'CoachCopyGuardrail'; label = 'Copy the guardrail'; action = 'copy' },
        @{ id = 'CoachDismiss'; label = 'Dismiss'; action = 'dismiss' }
      )
    }
  }

  $findings = @(Get-SecurityFindings $t)
  if ($findings.Count -eq 0) { return @{ kind = 'none' } }

  $lines = @()
  for ($i = 0; $i -lt $findings.Count; $i++) {
    $lines += (([string]($i + 1)) + '. ' + $findings[$i].label + '. ' + $findings[$i].body)
  }
  $why = @()
  for ($i = 0; $i -lt $findings.Count; $i++) {
    $why += (([string]($i + 1)) + '. ' + $findings[$i].why)
  }

  $what = if ($findings.Count -eq 1) { '1 thing before you accept this' } else { ('{0} things before you accept this' -f $findings.Count) }

  return @{
    kind     = 'security'
    title    = $what
    body     = ($lines -join "`n`n")
    findings = $findings
    explain  = @{
      title = 'Why this matters'
      body  = ($why -join "`n`n")
    }
    fixed    = ([string]$t).Trim().TrimEnd('.') + '. ' + $script:FixedPromptSuffix
    buttons  = @(
      @{ id = 'CoachExplain'; label = 'Explain why'; action = 'explain' },
      @{ id = 'CoachFixPrompt'; label = 'Fix my prompt'; action = 'fix' },
      @{ id = 'CoachIgnore'; label = 'Ignore'; action = 'ignore' }
    )
  }
}
