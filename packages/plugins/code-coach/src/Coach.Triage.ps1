# ---------------------------------------------------------------------------
# Coach.Triage.ps1 - the cheap triage lane.
#
# The product promise is silence by default: most sends are fine and the coach
# says nothing. When a send deserves a card, the card shows at most two things
# and the three actions a developer knows: Explain why, Fix my prompt, Ignore.
#
# This module owns the model-side contract. The daemon owns when to call it
# and what the card does with the answer. Nothing here opens a UI session.
# There are two lanes to the same contract: a direct HTTP call to any
# OpenAI-compatible provider with the developer's own key, and the legacy
# standalone CLI invocation like the analyzer's (Nous free pool).
#
# Sub-file of the daemon; dot-sourced after Coach.Common.ps1.
# ---------------------------------------------------------------------------

$script:TriageSeverities = @('info', 'warn', 'critical')

function New-TriagePrompt {
  param(
    [Parameter(Mandatory = $true)][string]$Draft,
    $Ctx,
    [string[]]$RepoFacts = @(),
    $Learner,
    [string]$Repeats = ''
  )
  $ctxKey = @(
    'Files', 'Errors', 'Tests', 'Success', 'Constraints', 'Goals',
    'Attempts', 'UncommittedFiles', 'BroadAsk', 'MissingNames'
  )
  $ctxLines = New-Object System.Collections.ArrayList
  if ($Ctx) {
    foreach ($name in $ctxKey) {
      $v = Get-CtxValue $Ctx $name
      if ($null -ne $v) {
        $vs = if ($v -is [array] -or $v -is [System.Collections.IEnumerable]) { (@($v) | ForEach-Object { [string]$_ }) -join ', ' } else { [string]$v }
        if ($vs) { [void]$ctxLines.Add((@{ name = $name; value = $vs })) }
      }
    }
    $repo = Get-CtxValue $Ctx 'Repo'
    if ($repo) {
      $rd = [string](Get-CtxValue $repo 'desc')
      if ($rd) { [void]$ctxLines.Add((@{ name = 'Repo'; value = $rd })) }
    }
  }

  $tags = @()
  if ($Learner -and $Learner.tags) {
    $tags = @($Learner.tags.GetEnumerator() | ForEach-Object { "$($_.Name): $($_.Value)" } | Select-Object -First 8)
  }

  $lines = New-Object System.Collections.ArrayList
  [void]$lines.Add(@'
You are Code Coach, a senior engineer sitting beside a developer who is
using an AI coding agent. Observe and teach; you never write the solution.

YOU RECEIVE:
- The developer's latest prompt to their coding agent
- Context digest: files, errors, tests, constraints, prior attempts
- Repo facts: what the touched files are for and what they must not do
- Learner profile: concepts mastered, recurring mistakes

YOUR JOB:
1. Triage: is there a real issue worth interrupting for? Categories:
   security, scalability, correctness, maintainability, prompt quality.
   If nothing is worth interrupting for, return {"interrupt": false}.
   Silence is the default. Do not manufacture an issue to seem useful.
2. If yes, lead with the single most important thing. Usually one or two
   issues; more only when each is concrete and independently teachable.
   Never a laundry list.
3. The depth lives under the issue: state the first principle, then how
   the current shape fails in the real world (the breach, the 3 a.m.
   page, the silent wrong number), then the concrete change.
4. Bring current best practice, not old defaults: name the specific
   libraries, APIs, flags and patterns strong teams ship today (for
   example argon2id, constant-time compare, token-bucket rate limiting,
   prepared statements, the exact linter rule that catches this class).
   Cite trades as trades. If you are not sure something is still current
   best practice, say so plainly instead of guessing confidently.
5. Match depth to the learner profile: beginner gets analogy first, then
   the concept, then the fix. Intermediate gets the principle and the
   tradeoff. Advanced gets one line and the failure mode only.
6. If the profile shows a gap this prompt can close, end the explanation
   with a short question that makes them predict behavior.
7. better_prompt: the smaller, sharper prompt they should have sent, with
   the fix already stated as requirements.

RULES:
- Tone: the senior dev who never makes you feel dumb. No lecturing.
- nudge: max 60 words, the issues in plain words. The deep version lives
  only in explanation, which they read after clicking Explain why.
- If the draft handles passwords, credentials, login or secrets, the review is
  incomplete unless it names password hashing (argon2id or bcrypt, with a
  per-user salt) as a requirement. Rate limiting alone is not enough.
- Never repeat a lesson the profile says is mastered.
- If a mistake repeats 3+ times (profile counts say so), say so plainly.
- Ground every claim in the PROMPT, CONTEXT and REPO FACTS you were
  given. Be honest about uncertainty. Never invent vulnerabilities,
  APIs, or file references you were not shown.
- Prefer named, field-proven techniques over generic advice, wherever
  they originate: modern infosec practice, GitHub-shipped patterns,
  what strong teams actually run today. If you cannot name a technique,
  say you are unsure rather than manufacturing pseudo-alpha.
- Every JSON string value stays on one line: use \n inside the string
  when a break is needed. Plain text, no markdown fences.

OUTPUT (JSON only):
{"interrupt": bool,
 "severity": "info" | "warn" | "critical",
 "nudge": "max 60 words; the issues in plain words",
 "explanation": "the depth behind the nudge: the principle, the real-world failure, the current best practice named concretely, the exact change to make",
 "better_prompt": "the improved prompt, or empty if none",
 "concept_tags": ["kebab-case-tags"],
 "quiz": null | "a short predict-the-behavior question"}
'@)
  if ($Repeats) { [void]$lines.Add('') ; [void]$lines.Add('REPEATS: ' + $Repeats) }
  [void]$lines.Add('')
  [void]$lines.Add('PROMPT:')
  [void]$lines.Add($Draft)
  if ($ctxLines.Count -gt 0) {
    [void]$lines.Add('')
    [void]$lines.Add('CONTEXT DIGEST:')
    foreach ($c in $ctxLines) { [void]$lines.Add('- ' + $c.name + ': ' + $c.value) }
  }
  if (@($RepoFacts).Count -gt 0) {
    [void]$lines.Add('')
    [void]$lines.Add('REPO FACTS:')
    foreach ($f in @($RepoFacts | Select-Object -First 4)) { [void]$lines.Add('- ' + [string]$f) }
  }
  if ($tags.Count -gt 0) {
    [void]$lines.Add('')
    [void]$lines.Add('LEARNER PROFILE (concept_tags: count):')
    foreach ($t in $tags) { [void]$lines.Add('- ' + $t) }
  }
  return ($lines -join "`n")
}

# ---------------------------------------------------------------------------
# The HTTP lane. Any OpenAI-compatible /chat/completions endpoint works: the
# developer's own key, the developer's own billing. Which provider is decided
# by three config fields (triageApiBase, triageApiKeyEnv, triageModelName);
# see docs\QUICKSTART.md for per-provider examples.
#
# The key lives in an environment variable named by triageApiKeyEnv. It is
# read fresh at call time and is never logged, traced, or written anywhere;
# provider error strings are redacted before they leave this function.
# ---------------------------------------------------------------------------
function Read-OpenAiChatResponse([string]$Json) {
  if ([string]::IsNullOrWhiteSpace($Json)) { return @{ kind = 'no-body' } }
  $obj = $null
  try { $obj = $Json | ConvertFrom-Json -ErrorAction Stop } catch { return @{ kind = 'bad-json' } }
  if ($obj.error) { return @{ kind = 'error'; message = [string]$obj.error.message } }
  # One choice or many: @() makes the single-element case indexable.
  $choice = @($obj.choices)[0]
  if (-not $choice -or -not $choice.message) { return @{ kind = 'no-choices' } }
  $text = ([string]$choice.message.content).Trim()
  # Reasoning models (DeepSeek-reasoner class) can spend the whole token
  # budget thinking and leave content empty. The answer then rides in
  # reasoning_content; honoring it keeps those providers in the lane.
  if (-not $text -and $choice.message.reasoning_content) {
    $text = ([string]$choice.message.reasoning_content).Trim()
  }
  if (-not $text) { return @{ kind = 'empty-text' } }
  return @{ kind = 'ok'; text = $text }
}

function Invoke-TriageHttp {
  param(
    [Parameter(Mandatory = $true)][string]$Prompt,
    [Parameter(Mandatory = $true)][string]$ApiBase,
    [Parameter(Mandatory = $true)][string]$ApiKeyEnv,
    [Parameter(Mandatory = $true)][string]$Model,
    [int]$TimeoutMs = 20000
  )
  if (-not $Prompt -or -not $ApiBase -or -not $ApiKeyEnv -or -not $Model) { return @{ ok = $false; why = 'empty-config' } }
  # Process scope: the daemon inherits user/machine variables at spawn, so a
  # key set the documented way arrives here with no extra plumbing. A key
  # added after the daemon started needs a daemon restart to appear.
  $key = [Environment]::GetEnvironmentVariable($ApiKeyEnv, 'Process')
  if (-not $key) { return @{ ok = $false; why = 'no-key'; error = ('set ' + $ApiKeyEnv + ' and restart the daemon') } }
  # Provider errors can echo the Authorization header or the request body;
  # scrub every trace of the key before returning to whoever writes it down.
  function Sanitize([string]$Text) {
    if ([string]::IsNullOrEmpty($Text)) { return '' }
    return ([string]$Text -replace [regex]::Escape($key), '***')
  }
  $url = $ApiBase.TrimEnd('/') + '/chat/completions'
  # 2000, not 900: reasoning models spend tokens thinking before they emit
  # one character of answer. 900 turns those providers into empty content
  # and a silent lane.
  $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes((@{
    model       = $Model
    temperature = 0.2
    max_tokens  = 2000
    messages    = @(, @{ role = 'user'; content = $Prompt })
  } | ConvertTo-Json -Depth 6))
  # The spare body for strict endpoints: model and messages, nothing else.
  $minimalBytes = (New-Object Text.UTF8Encoding($false)).GetBytes((@{
    model    = $Model
    messages = @(, @{ role = 'user'; content = $Prompt })
  } | ConvertTo-Json -Depth 5))
  $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
  $minimalTried = $false
  $lastWhy = 'timeout'
  $lastErr = ''
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    $remaining = [DateTime]::UtcNow
    $remaining = ([TimeSpan]($deadline - $remaining)).TotalMilliseconds
    if ($remaining -le 0) { return @{ ok = $false; why = 'timeout'; error = (Sanitize $lastErr) } }
    $timeoutS = [Math]::Max(1, [int][Math]::Ceiling($remaining / 1000.0))
    $lastErr = ''
    try {
      $resp = Invoke-WebRequest -Uri $url -Method Post -UseBasicParsing -UserAgent 'code-coach-triage' `
        -ContentType 'application/json; charset=utf-8' `
        -Headers @{ Authorization = ('Bearer ' + $key) } -Body $bytes -TimeoutSec $timeoutS
      $parsed = Read-OpenAiChatResponse ([string]$resp.Content)
      if ($parsed.kind -eq 'ok') { return @{ ok = $true; text = $parsed.text; model = $Model } }
      if ($parsed.kind -eq 'error') { return @{ ok = $false; why = 'model-error'; error = (Sanitize ([string]$parsed.message).Substring(0, [Math]::Min(200, (([string]$parsed.message)).Length))) } }
      $lastWhy = 'no-text'
    } catch {
      $status = 0
      try { if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode } } catch { }
      if ($status -gt 0) {
        $body = ''
        try {
          $sr = New-Object IO.StreamReader($_.Exception.Response.GetResponseStream())
          $body = $sr.ReadToEnd()
        } catch { }
        if (-not $body -and $_.ErrorDetails) { $body = [string]$_.ErrorDetails.Message }
        if ($status -in @(429, 500, 502, 503, 504)) {
          # The exact failure for the trace; the upstream provider error text
          # rides in error so the log still says what went wrong upstream.
          $lastWhy = if ($status -eq 429) { 'rate-limited' } else { ('http-' + $status) }
          $m = Read-OpenAiChatResponse $body
          $lastErr = if ($m.kind -eq 'error') { [string]$m.message } else { ([string]$body).Substring(0, [Math]::Min(160, ([string]$body).Length)) }
        } else {
          # 4xx is configuration trouble (bad key, wrong model name); it can
          # never self-heal, so fail fast with the server's own words. One
          # exception below: the strict-reasoner 400 that names the parameter
          # it refuses.
          $m = Read-OpenAiChatResponse $body
          $retryText = [string]$m.message
          if ($status -eq 400 -and -not $minimalTried -and
              ($retryText -match 'temperature|max.?_?tokens|completion_tokens|not supported|unsupported')) {
            $minimalTried = $true
            $bytes = $minimalBytes
            continue
          }
          $why = if ($status -in @(401, 403)) { 'auth' } else { ('http-' + $status) }
          $errText = if ($m.kind -eq 'error') { [string]$m.message } else { [string]$body }
          return @{ ok = $false; why = $why; error = (Sanitize $errText) }
        }
      } else {
        # No HTTP response at all: connection refused, DNS, TLS, or a client
        # timeout. Cheap to fail, cheap to retry once inside the same budget.
        $lastWhy = if ($_.Exception -is [System.Net.WebException] -and $_.Exception.Status -eq [System.Net.WebExceptionStatus]::Timeout) { 'timeout' } else { 'network' }
        $lastErr = $_.Exception.Message
      }
    }
    if ($attempt -lt 3) {
      $wait = [Math]::Min(1500 * $attempt, ([int]([TimeSpan]($deadline - [DateTime]::UtcNow)).TotalMilliseconds))
      if ($wait -gt 0) { Start-Sleep -Milliseconds $wait }
    }
  }
  return @{ ok = $false; why = $lastWhy; error = (Sanitize ([string]$lastErr).Substring(0, [Math]::Min(200, ([string]$lastErr).Length))) }
}

# ---------------------------------------------------------------------------
# The CLI lane's model loop. Primary first, then the fallbacks, all inside one
# total budget: a dead primary can never end the lane silently, because a fast
# model-error leaves almost the whole wall clock for the next candidate
# (measured live: a dead-key model answers its refusal in ~3 s). Per attempt
# the cap is budget over candidates, floored so a hanging candidate burns at
# most its share. When nothing answers, the most informative failure wins the
# trace: a real provider message beats a bare timeout.
# ---------------------------------------------------------------------------
function Invoke-TriageCliChain {
  param(
    [Parameter(Mandatory = $true)][string]$Prompt,
    [string]$Exe = '',
    [string]$Model = '',
    [string[]]$FallbackModels = @(),
    [string]$Agent = '',
    [string]$WorkDir = '',
    [int]$TimeoutMs = 20000
  )
  $models = New-Object System.Collections.ArrayList
  if ($Model) { [void]$models.Add($Model) }
  foreach ($m in @($FallbackModels)) { if ($m) { [void]$models.Add([string]$m) } }
  if ($models.Count -eq 0) { return @{ ok = $false; why = 'no-model'; error = 'no triage model configured' } }
  $started = [DateTime]::UtcNow
  $attemptCap = [Math]::Max(20000, [int][Math]::Floor($TimeoutMs / $models.Count))
  $failed = New-Object System.Collections.ArrayList
  foreach ($m in $models) {
    $left = [int]($TimeoutMs - ([DateTime]::UtcNow - $started).TotalMilliseconds)
    if ($left -lt 15000) { break }
    $r = Invoke-AnalyzerModel -Prompt $Prompt -Exe $Exe -Model $m -Agent $Agent -WorkDir $WorkDir -TimeoutMs ([Math]::Min($attemptCap, $left))
    if ($r -and $r.ok) {
      # A fluent answer with no decision JSON is a failure like any other -
      # and it used to be the worst kind: the chain "succeeded", the daemon's
      # parser shrugged, and the send ended in shapeless silence with no
      # trace. Validate here so the next candidate keeps its chance inside
      # the same budget.
      $d = Read-TriageResult -Text ([string]$r.text)
      if ($d -and $d.ContainsKey('interrupt')) { $r.model = [string]$m; return $r }
      [void]$failed.Add(@{ m = [string]$m; r = @{ ok = $false; why = 'parse-fail'; error = 'answer carried no valid decision JSON' } })
      continue
    }
    [void]$failed.Add(@{ m = [string]$m; r = $r })
  }
  $best = $null
  foreach ($whyRank in @('model-error', 'parse-fail', 'rate-limited', 'exception', 'no-text', 'no-cli', 'exit-fail', 'timeout')) {
    foreach ($f in $failed) {
      if (([string]$f.r.why) -eq $whyRank) { $best = $f; break }
    }
    if ($best) { break }
  }
  if (-not $best) { if ($failed.Count -gt 0) { $best = $failed[$failed.Count - 1] } else { $best = @{ m = [string]$Model; r = @{ ok = $false; why = 'timeout' } } } }
  $out = $best.r
  $out.model = [string]$best.m
  return $out
}

# Brace extractor: the model may wrap JSON in fences or prose. Same tolerance
# the analyzer parser has.
function Read-TriageResult {
  param([string]$Text)
  if ([string]::IsNullOrWhiteSpace($Text)) { return @{} }
  $start = $Text.IndexOf('{')
  $end = $Text.LastIndexOf('}')
  if ($start -lt 0 -or $end -le $start) { return @{} }
  $json = $Text.Substring($start, $end - $start + 1)
  $t = $json -replace '(?m)^(\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)' , '$1"$2"$3'
  $obj = $null
  foreach ($candidate in @($json, $t)) {
    try { $obj = $candidate | ConvertFrom-Json -ErrorAction Stop; break } catch { }
  }
  if (-not $obj) { return @{} }

  $interrupt = $obj.interrupt
  if ($obj.PSObject.Properties.Name -contains 'interrupt') {
    $interrupt = if ($interrupt -is [bool]) { $interrupt } else { ($interrupt -as [bool]) -eq $true }
  } else { $interrupt = $false }
  if (-not $interrupt) { return @{ interrupt = $false } }
  $result = @{ interrupt = $true; severity = 'warn'; nudge = ''; explanation = ''; betterPrompt = ''; quiz = ''; tags = @() }
  $sev = ([string]$obj.severity).Trim().ToLowerInvariant()
  if ($script:TriageSeverities -contains $sev) { $result.severity = $sev }
  $nudge = ([string]$obj.nudge).Trim()
  # 60 words is the promise. Long and you have lost the developer. When the
  # model overruns, keep its first 60 words rather than its apology.
  if ($nudge) {
    $words = @([regex]::Matches($nudge, '\S+'))
    if ($words.Count -gt 60) { $nudge = ((@($words) | Select-Object -First 60 | ForEach-Object { $_.Value }) -join ' ') }
    $result.nudge = $nudge
  }
  $result.explanation = ([string]$obj.explanation).Trim()
  $result.betterPrompt = ([string]$obj.better_prompt).Trim()
  $result.quiz = ([string]$obj.quiz).Trim()
  $tags = @()
  foreach ($tag in @($obj.concept_tags)) { $s = ([string]$tag).Trim().ToLowerInvariant(); if ($s) { $tags += $s } }
  # Dedupe by hand: 'Select-Object -Unique -First N' short-circuits the input
  # after N items (the First applies to reads, not the unique output), which
  # quietly discards later tags.
  $unique = @()
  $seenTag = @{}
  foreach ($t in $tags) { if (-not $seenTag.ContainsKey($t)) { $seenTag[$t] = $true; $unique += $t } }
  $result.tags = @($unique | Select-Object -First 4)
  return $result
}

# How long a Snooze click buys, in seconds: config minutes, 120 default when
# unset or nonsense. Pure, so tests pin it without a card on screen.
function Get-TriageSnoozeSeconds($Config) {
  $mins = 0
  if ($Config) { $mins = [int](Get-CtxValue $Config 'triageSnoozeMinutes') }
  if ($mins -le 0) { $mins = 120 }
  return ($mins * 60)
}

# The triage auto-heal's candidate list: files the draft names that exist on
# disk under the send's repo root, as repo-relative paths the analyzer pack
# can force-include when briefs are missing or stale. Pure and honest on
# purpose: a file that is not there names no brief, and we never invent one.
function Get-TriageHealTargets([string]$Draft, $Ctx) {
  $root = ''
  if ($Ctx) {
    $repo = Get-CtxValue $Ctx 'Repo'
    if ($repo) { $root = [string](Get-CtxValue $repo 'root') }
  }
  if (-not $root -or -not (Test-Path -LiteralPath $root -PathType Container)) { return @() }

  $names = New-Object System.Collections.ArrayList
  if (Get-Command Get-FileTokens -ErrorAction SilentlyContinue) {
    foreach ($f in @(Get-FileTokens $Draft)) { [void]$names.Add([string]$f) }
  } else {
    foreach ($m in [regex]::Matches($Draft, '\b[\w./\\-]+\.[a-z0-9]{1,4}\b')) { [void]$names.Add($m.Value) }
  }
  if ($Ctx) {
    foreach ($name in @('Files', 'TestFiles')) {
      foreach ($f in @(Get-CtxList $Ctx $name)) { [void]$names.Add([string]$f) }
    }
  }

  $rootFull = [IO.Path]::GetFullPath($root)
  $rootPrefix = $rootFull.TrimEnd('\') + '\'
  $out = New-Object System.Collections.ArrayList
  $seen = @{}
  foreach ($n in @($names)) {
    if ($out.Count -ge 3) { break }
    if ([string]::IsNullOrWhiteSpace($n) -or $n.Length -lt 3) { continue }
    $ext = [IO.Path]::GetExtension($n)
    if (-not $ext -or $ext.Length -gt 5) { continue }
    $full = $null
    if ([IO.Path]::IsPathRooted($n)) {
      if (-not $n.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) { continue }
      $full = [IO.Path]::GetFullPath($n)
    } else {
      $full = Join-Path $rootFull $n
    }
    if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { continue }
    $rel = $full.ToLowerInvariant().Replace('/', '\')
    $rootLower = $rootFull.ToLowerInvariant().TrimEnd('\') + '\'
    if (-not $rel.StartsWith($rootLower)) { continue }
    $rel = $full.Substring($rootFull.Length).TrimStart('\')
    $k = $rel.ToLowerInvariant()
    if ($seen.ContainsKey($k)) { continue }
    $seen[$k] = $true
    [void]$out.Add($rel)
  }
  return @($out)
}

# A security-shaped ask is worth a model look even when the send names no file:
# "add a login endpoint" has no brief to lean on, but hashing and rate limiting
# are teachable from the prompt alone. The model still decides whether a card
# is warranted; this only decides whether the lane gets to ask. A bare
# "validate" or "fix" is not enough - the draft must name a security surface
# (auth, secrets, injection, transport, access control, or user data).
function Test-SecurityIntent([string]$Draft) {
  if ([string]::IsNullOrWhiteSpace($Draft)) { return $false }
  $surface = @(
    'passwords?', 'passwd', 'bcrypt', 'argon2', 'scrypt', 'hash(ing)?', 'salt',
    'log[- ]?in', 'sign[- ]?in', 'sign[- ]?up', 'auth(entication|orization)?',
    'oauth', 'oidc', 'jwt', 'saml', 'sessions?', 'tokens?', 'api[- ]?keys?',
    'credentials?', 'secrets?',
    'sql injection', 'injection', 'xss', 'csrf', 'ssrf', 'xxe', 'idor',
    'traversal', 'sanitiz\w*', 'escap\w*',
    'encrypt\w*', 'decrypt\w*', 'tls', 'ssl', 'certificates?', 'hmac', 'signatures?',
    'permissions?', 'roles?', 'rbac', 'acl', 'privileges?', 'access control',
    'authoriz\w*', 'rate[- ]?limit\w*', 'throttl\w*', 'brute[- ]?force', 'lockout',
    'pii', 'gdpr', 'redact\w*'
  ) -join '|'
  return [bool]($Draft -match ('(?i)\b(' + $surface + ')\b'))
}

# Which post-send outcomes still deserve the triage lane. The send already left
# for pass and attach alike; 'no-gap' and 'unfaithful' are both real sends with
# a readable draft, so triage watches them. Anything else (silent, mode-off,
# text-shape) has no draft worth reading or a switch that said stop.
function Test-TriageEligible([string]$Reason) {
  return ($Reason -in @('no-gap', 'unfaithful'))
}

# ---------------------------------------------------------------------------
# Off-thread triage. Same shape as the analyzer's job: the tick starts it, the
# tick collects it, and the UI thread never waits. The difference is latency:
# the triage pass is seconds, the analyzer pass is minutes.
# ---------------------------------------------------------------------------
$script:TriageJob = $null
$script:TriageNotBefore = [DateTime]::MinValue

function Start-TriageJob {
  param(
    [Parameter(Mandatory = $true)][string]$PromptText,
    [string]$Exe = '',
    [string]$Model = '',
    [string]$Agent = '',
    [string]$ApiBase = '',
    [string]$ApiKeyEnv = '',
    [string]$ApiModel = '',
    [string[]]$FallbackModels = @(),
    [int]$TimeoutMs = 20000,
    [string]$WorkDir = ''
  )
  if ($script:TriageJob) { return $false }
  if ([string]::IsNullOrWhiteSpace($PromptText)) { return $false }
  $coachRoot = ''
  if ($script:CoachHome) { $coachRoot = [string]$script:CoachHome }
  elseif ($PSScriptRoot) { $coachRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path }
  # The worker needs the model bridges only, not the whole card stack. Lane
  # pick happens here once: an ApiBase plus a model name means the developer's
  # own provider over HTTP; anything else is the legacy CLI lane.
  $worker = @'
param($PromptText, $Exe, $Model, $Agent, $FallbackModels, $TimeoutMs, $WorkDir, $CoachRoot, $ApiBase, $ApiKeyEnv, $ApiModel)
. (Join-Path $CoachRoot 'src\Coach.Common.ps1')
. (Join-Path $CoachRoot 'src\Coach.Analyzer.ps1')
. (Join-Path $CoachRoot 'src\Coach.Triage.ps1')
if ($ApiBase -and $ApiModel) {
  $r = Invoke-TriageHttp -Prompt $PromptText -ApiBase $ApiBase -ApiKeyEnv $ApiKeyEnv -Model $ApiModel -TimeoutMs $TimeoutMs
} else {
  $r = Invoke-TriageCliChain -Prompt $PromptText -Exe $Exe -Model $Model -FallbackModels $FallbackModels -Agent $Agent -WorkDir $WorkDir -TimeoutMs $TimeoutMs
}
if ($r.ok) {
  # Final gate before the daemon sees "ok": fluent prose is a named parse
  # failure, never fake silence. The chain already re-ran its unparseable
  # candidates; this guards the HTTP lane and keeps the contract in one
  # place.
  $d = Read-TriageResult -Text ([string]$r.text)
  if (-not ($d -and $d.ContainsKey('interrupt'))) {
    $r = @{ ok = $false; why = 'parse-fail'; error = 'provider returned no valid decision JSON'; model = [string]$r.model }
  }
}
@{ ok = [bool]$r.ok; why = [string]$r.why; error = [string]$r.error; text = [string]$r.text; model = [string]$r.model }
'@
  $ps = [powershell]::Create()
  [void]$ps.AddScript($worker)
  [void]$ps.AddParameter('PromptText', $PromptText)
  [void]$ps.AddParameter('Exe', $Exe)
  [void]$ps.AddParameter('Model', $Model)
  [void]$ps.AddParameter('Agent', $Agent)
  [void]$ps.AddParameter('ApiBase', $ApiBase)
  [void]$ps.AddParameter('ApiKeyEnv', $ApiKeyEnv)
  [void]$ps.AddParameter('ApiModel', $ApiModel)
  [void]$ps.AddParameter('FallbackModels', $FallbackModels)
  [void]$ps.AddParameter('TimeoutMs', $TimeoutMs)
  [void]$ps.AddParameter('WorkDir', $WorkDir)
  [void]$ps.AddParameter('CoachRoot', $coachRoot)
  try {
    $handle = $ps.BeginInvoke()
    $script:TriageJob = @{ ps = $ps; handle = $handle; started = [DateTime]::UtcNow; timeoutMs = $TimeoutMs }
    return $true
  } catch {
    try { $ps.Dispose() } catch { }
    Write-CoachLog ('triage async: ' + $_.Exception.Message)
    return $false
  }
}

# Collect. Null means "still running"; the returned shape's interrupt field is
# the answer. The prompt text is never kept on the job record: triage sees the
# draft once, at the call site, and nothing persists it.
function Complete-TriageJob {
  $job = $script:TriageJob
  if (-not $job) { return $null }
  # The child's own timeout bounds the model call; the grace only covers
  # process teardown. A job that sits past that is wedged: stop it and report
  # so the tick never collects the same half-life job forever.
  $budget = [int]$job.timeoutMs + 10000
  $age = ([DateTime]::UtcNow - $job.started).TotalMilliseconds
  if (-not $job.handle.IsCompleted) {
    if ($age -lt $budget) { return $null }
    # Async stop: same rule as the scan and analyzer collectors - a wedged
    # child must not take the shared dispatcher down with it. BeginStop from
    # the tick, collect on the next tick once the pipeline lands.
    if (-not $job.stopPending) {
      try { $job.ps.BeginStop($null, $null) } catch { }
      $job.stopPending = $true
    }
    return $null
  }
  $script:TriageJob = $null
  try {
    $out = @($job.ps.EndInvoke($job.handle))
    if ($out.Count -gt 0 -and $out[0]) { return $out[0] }
    return @{ ok = $false; why = 'empty' }
  } catch {
    Write-CoachLog ('triage async: ' + $_.Exception.Message)
    return @{ ok = $false; why = 'exception' }
  } finally {
    try { $job.ps.Dispose() } catch { }
  }
}

# ---------------------------------------------------------------------------
# Grounding. The prompt tells the model to never invent a file reference; this
# is the enforcement. Only the checkable claims are checked: every file token
# in the card must have appeared in the draft, in the repo facts, or on disk
# under the repo root, and a line citation must point at a line that exists.
# Prose about behavior stays the model's judgment - judging that would need a
# second model call, and a second opinion is not evidence.
# ---------------------------------------------------------------------------
function Test-TriageGrounded {
  param($Result, [string]$Draft = '', [string[]]$Facts = @(), [string]$Root = '')
  $text = (@([string]$Result.nudge, [string]$Result.explanation, [string]$Result.betterPrompt) -join "`n")
  $factText = (@($Facts) -join "`n")
  $fileRe = '(?i)([\w.\-\\/]+\.(?:ps1|psm1|psd1|js|mjs|cjs|ts|tsx|jsx|py|cs|go|rs|rb|java|kt|swift|json|ya?ml|toml|md|css|html|sql|sh|bash|bat|cmd|c|h|cpp|hpp))'

  $findFile = {
    param([string]$Rel)
    if (-not $Root) { return $null }
    try {
      $direct = Join-Path $Root $Rel
      if (Test-Path -LiteralPath $direct -PathType Leaf) { return $direct }
    } catch { }
    try {
      $leaf = Split-Path -Leaf $Rel
      $hit = Get-ChildItem -LiteralPath $Root -Filter $leaf -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($hit) { return $hit.FullName }
    } catch { }
    return $null
  }

  $tokens = @()
  if (Get-Command Get-FileTokens -ErrorAction SilentlyContinue) { $tokens = @(Get-FileTokens $text) }
  if ($tokens.Count -eq 0) { $tokens = @([regex]::Matches($text, $fileRe) | ForEach-Object { $_.Groups[1].Value }) }
  foreach ($tok in $tokens) {
    $t = [string]$tok
    if (-not $t) { continue }
    $leaf = Split-Path -Leaf $t
    $inDraft = $Draft -and ($Draft.IndexOf($t, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or $Draft.IndexOf($leaf, [StringComparison]::OrdinalIgnoreCase) -ge 0)
    $inFacts = $factText -and ($factText.IndexOf($t, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or $factText.IndexOf($leaf, [StringComparison]::OrdinalIgnoreCase) -ge 0)
    $onDisk = [bool](& $findFile $t)
    if (-not ($inDraft -or $inFacts -or $onDisk)) {
      return @{ ok = $false; why = 'invented-file'; detail = $t; kind = '' }
    }
  }

  # A cited line is a fact claim. With no facts, there is nothing to cite; with
  # a real file, the line must exist in it.
  foreach ($m in [regex]::Matches($text, ($fileRe + ':(\d{1,6})'))) {
    $rel = $m.Groups[1].Value
    $line = [int]$m.Groups[2].Value
    if (@($Facts).Count -eq 0) {
      return @{ ok = $false; why = 'invented-line'; detail = ($rel + ':' + $line); kind = '' }
    }
    $full = & $findFile $rel
    if ($full) {
      try {
        $n = @([IO.File]::ReadAllLines($full)).Count
        if ($line -lt 1 -or $line -gt $n) {
          return @{ ok = $false; why = 'invented-line'; detail = ($rel + ':' + $line + ' of ' + $n); kind = '' }
        }
      } catch { }
    }
  }
  if (@($Facts).Count -eq 0 -and [regex]::IsMatch($text, '(?i)\bline[s]?\s+\d+')) {
    return @{ ok = $false; why = 'invented-line'; detail = ''; kind = '' }
  }

  $kind = if (@($Facts).Count -gt 0) { 'facts' } elseif ($Draft -and @([regex]::Matches($Draft, $fileRe)).Count -gt 0) { 'draft' } else { 'prompt' }
  return @{ ok = $true; why = ''; detail = ''; kind = $kind }
}

# The decision the nudge card consumes. Nothing here persists: the fields go
# to the in-memory card model and, on a click, to the clipboard and the tag
# counters. The trace records severity and tags only, never the nudge text.
function New-TriageDecision {
  param($Result)
  if (-not $Result -or -not $Result.interrupt) { return $null }
  $shortNudge = ([string]$Result.nudge).Trim()
  if (-not $shortNudge) { return $null }
  $whyText = ([string]$Result.explanation).Trim()
  if ($whyText) {
    $lines = New-Object System.Collections.ArrayList
    [void]$lines.Add($whyText)
    $q = ([string]$Result.quiz).Trim()
    if ($q) { [void]$lines.Add('Quick check before you re-send: ' + $q) }
    $whyText = ($lines -join "`n`n")
  }
  $better = ([string]$Result.betterPrompt).Trim()
  return @{
    kind        = 'nudge'
    severity    = [string]$Result.severity
    nudge       = $shortNudge
    why         = $whyText
    betterPrompt= $better
    tags        = @($Result.tags)
    followUp    = $better
    smart       = $true
    principles  = @()
    finding     = $null
    grounding   = ''
  }
}

