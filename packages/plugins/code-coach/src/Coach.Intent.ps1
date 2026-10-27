# Coach.Intent.ps1 - the context-aware prompt compiler.
#
# The compiler reads the request, the compact context digest from the plugin,
# and the repo state, then builds a compiled prompt that keeps the original
# words first and adds only facts that are grounded in one of those sources.
# Missing facts become a targeted question, never an invention.
#
# Two rules are load-bearing:
#   1. The original draft is the first block, verbatim. The compiled block is additive.
#   2. Every file, number, command, and quoted error in the compiled prompt must
#      appear in the draft or the context digest. Test-SmartPromptFaithful enforces it.

$script:FileTokenRe = '(?i)(?<![\w])(?:[A-Za-z]:)?[\\/]?[\w.\-\\/]+\.(ps1|psm1|psd1|js|mjs|cjs|ts|tsx|jsx|py|cs|go|rs|rb|java|kt|swift|json|ya?ml|toml|md|css|html|sql|sh|bash|bat|cmd|c|h|cpp|hpp)\b'
$script:TestCommandRe = '(?im)^[^\r\n]*(?:npm|pnpm|yarn|pytest|python\s+-m\s+pytest|go\s+test|cargo\s+test|dotnet\s+test|node\s+--test|uv\s+run|make\s+test|Run-[A-Za-z0-9_-]+\.ps1)[^\r\n]*$'
$script:ErrorLineRe = '(?i)(error|exception|traceback|failed|failure|fatal|panic|TS\d{4}|at\s+\w+\(|line\s+\d+)'
$script:ClauseSplitRe = '(?i),\s+(?=(?:and\s+)?(?:fix|make|improve|refactor|rewrite|update|change|clean|handle|support|add|move|rename|remove)\b)'
$script:RepoContextCache = @{}

function Get-Sentences([string]$Text) {
  $out = New-Object System.Collections.ArrayList
  if ([string]::IsNullOrWhiteSpace($Text)) { return @() }
  foreach ($chunk in [regex]::Split($Text, '(?<=[.!?])\s+|\r?\n')) {
    foreach ($s in [regex]::Split([string]$chunk, $script:ClauseSplitRe)) {
      $t = ([string]$s).Trim()
      if ($t.Length -lt 8 -or $t.Length -gt 260) { continue }
      if (-not ($out -contains $t)) { [void]$out.Add($t) }
    }
  }
  return @($out)
}

function Get-SentenceHits($Sentences, [string]$Pattern) {
  $out = New-Object System.Collections.ArrayList
  foreach ($s in @($Sentences)) {
    if ([string]$s -match $Pattern) {
      if (-not ($out -contains [string]$s)) { [void]$out.Add([string]$s) }
      if ($out.Count -ge 4) { break }
    }
  }
  return @($out)
}

function Get-UniqueList($Items, [int]$Max = 6) {
  $out = New-Object System.Collections.ArrayList
  $seen = @{}
  foreach ($i in @($Items)) {
    $t = ([string]$i).Trim()
    if (-not $t) { continue }
    $k = $t.ToLowerInvariant()
    if ($seen.ContainsKey($k)) { continue }
    $seen[$k] = $true
    [void]$out.Add($t)
    if ($out.Count -ge $Max) { break }
  }
  return @($out)
}

# Join names the way a person reads them: "a", "a and b", "a, b and c".
function Join-NaturalList($Items) {
  $list = @(@($Items) | ForEach-Object { ([string]$_).Trim() } | Where-Object { $_ })
  if ($list.Count -eq 0) { return '' }
  if ($list.Count -eq 1) { return $list[0] }
  if ($list.Count -eq 2) { return ($list[0] + ' and ' + $list[1]) }
  return (($list[0..($list.Count - 2)] -join ', ') + ' and ' + $list[$list.Count - 1])
}

function Get-FileTokens([string]$Text) {
  $out = New-Object System.Collections.ArrayList
  if ([string]::IsNullOrWhiteSpace($Text)) { return @() }
  foreach ($m in [regex]::Matches($Text, $script:FileTokenRe)) {
    $t = $m.Value.Trim().TrimEnd('.', ',', ';', ':', ')', ']', '}', '"', "'")
    if ($t.Length -ge 3) { [void]$out.Add($t) }
  }
  return @(Get-UniqueList $out 8)
}

# A named function/class is a place too, even without a file extension. These
# are case-sensitive on purpose: "the export" must not look like a name.
function Get-PlaceTokens([string]$Text) {
  $out = New-Object System.Collections.ArrayList
  if ([string]::IsNullOrWhiteSpace($Text)) { return @() }
  foreach ($m in [regex]::Matches($Text, '(\b[A-Z][a-z]+-[A-Z][A-Za-z0-9]*\b|\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b|\b[a-z]+[A-Z][A-Za-z0-9]*\b)')) {
    [void]$out.Add($m.Value)
  }
  return @(Get-UniqueList $out 6)
}

function Get-TestCommands([string]$Text) {
  $out = New-Object System.Collections.ArrayList
  if ([string]::IsNullOrWhiteSpace($Text)) { return @() }
  foreach ($m in [regex]::Matches($Text, $script:TestCommandRe)) {
    $t = $m.Value.Trim().TrimStart('-', '*', '$', '>').Trim()
    if ($t.Length -ge 4) { [void]$out.Add($t) }
  }
  return @(Get-UniqueList $out 4)
}

function Get-ErrorSnippets([string]$Text) {
  $out = New-Object System.Collections.ArrayList
  if ([string]::IsNullOrWhiteSpace($Text)) { return @() }
  foreach ($line in [regex]::Split($Text, '\r?\n')) {
    $t = ([string]$line).Trim()
    if ($t.Length -lt 8) { continue }
    if ($t -match $script:ErrorLineRe) {
      if ($t.Length -gt 200) { $t = $t.Substring(0, 200) + '...' }
      [void]$out.Add($t)
    }
  }
  return @(Get-UniqueList $out 4)
}

# A test file is a check, not a target: naming tests/foo.test.js in a draft must
# not turn the file you run into a second file to edit.
function Test-TestPath([string]$Path) {
  if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
  return [bool]($Path -match '(?i)(^|[\\/])(tests?|specs?|__tests__)[\\/]|\.(test|spec)\.[^\\/]+$|(^|[\\/])test_[^\\/]+$')
}

function Get-TestFileTokens([string[]]$Items) {
  return @(Get-UniqueList (@($Items | Where-Object { Test-TestPath ([string]$_) })) 8)
}

# The finish line is the one clause that names the end state. Read the explicit
# label first; only fall back to expectation words when no label exists. The
# whole draft is never a finish line, and the label itself is never kept.
function Get-FinishLines([string]$Draft, $Sentences) {
  $out = New-Object System.Collections.ArrayList
  $d = ([string]$Draft).Trim()
  foreach ($m in [regex]::Matches($d, '(?i)finish(?:ed)?\s+line\s*[:\-]\s*([^;\r\n]+)')) {
    $t = $m.Groups[1].Value.Trim().TrimEnd('.', ',')
    if ($t.Length -ge 4) { [void]$out.Add($t) }
  }
  if ($out.Count -eq 0) {
    foreach ($s in @($Sentences)) {
      $t = ([string]$s).Trim()
      if (-not $t -or $t -eq $d -or $t.Length -gt 180) { continue }
      if ($t -match $script:ExpectedWords) { [void]$out.Add($t) }
    }
  }
  return @(Get-UniqueList $out 3)
}

# A limit is a clause, not the sentence that happens to contain it. Splitting on
# the separators people actually use keeps a one-line, three-part draft from
# turning its whole text into "Limits".
function Get-ConstraintLines([string]$Draft, $Sentences) {
  $out = New-Object System.Collections.ArrayList
  $d = ([string]$Draft).Trim()
  foreach ($c in [regex]::Split($d, '\s*;\s*|\r?\n')) {
    $t = ([string]$c).Trim().TrimEnd('.', ',')
    if ($t.Length -lt 4 -or $t.Length -gt 180) { continue }
    if ($t -match $script:LimitWords) { [void]$out.Add($t) }
  }
  if ($out.Count -eq 0) {
    foreach ($s in @($Sentences)) {
      $t = ([string]$s).Trim()
      if (-not $t -or $t -eq $d) { continue }
      if ($t -match $script:LimitWords) { [void]$out.Add($t) }
    }
  }
  return @(Get-UniqueList $out 4)
}

function Get-IntentSlots([string]$Draft, $Ctx) {
  $d = ([string]$Draft).Trim()
  $sentences = @(Get-Sentences $d)
  $ctxFiles = @(Get-CtxList $Ctx 'Files')
  $ctxErrors = @(Get-CtxList $Ctx 'Errors')
  $ctxTests = @(Get-CtxList $Ctx 'Tests')
  $ctxSuccess = @(Get-CtxList $Ctx 'Success')
  $ctxConstraints = @(Get-CtxList $Ctx 'Constraints')
  $ctxGoals = @(Get-CtxList $Ctx 'Goals')
  $attempts = 0
  if ($Ctx) {
    $a = Get-CtxValue $Ctx 'Attempts'
    if ($a -ne $null) { $attempts = [int]$a }
  }

  $draftFiles = @(Get-FileTokens $d)
  $draftPlaces = @(Get-PlaceTokens $d)
  $draftTestFiles = @(Get-TestFileTokens $draftFiles)
  $ctxTestFiles = @(Get-TestFileTokens $ctxFiles)

  # A test file is a check, not a target. Listing tests/foo.test.js in the draft
  # must not turn the file to run into a second file to edit.
  $targetPool = New-Object System.Collections.ArrayList
  foreach ($f in $draftFiles) { if ($draftTestFiles -notcontains $f) { [void]$targetPool.Add($f) } }
  foreach ($p in $draftPlaces) { [void]$targetPool.Add($p) }
  foreach ($f in $ctxFiles) { if ($ctxTestFiles -notcontains $f) { [void]$targetPool.Add($f) } }
  $targets = @(Get-UniqueList $targetPool 6)

  $testPool = New-Object System.Collections.ArrayList
  foreach ($t in @(Get-TestCommands $d)) { [void]$testPool.Add($t) }
  foreach ($t in $draftTestFiles) { [void]$testPool.Add($t) }
  foreach ($t in $ctxTestFiles) { [void]$testPool.Add($t) }
  foreach ($t in $ctxTests) { [void]$testPool.Add($t) }
  $tests = @(Get-UniqueList $testPool 4)

  $errors = @(Get-UniqueList (@(Get-ErrorSnippets $d) + @($ctxErrors)) 4)
  $constraints = @(Get-UniqueList (@(Get-ConstraintLines $d $sentences) + @($ctxConstraints)) 4)
  $success = @(Get-UniqueList (@(Get-FinishLines $d $sentences) + @($ctxSuccess)) 4)
  $symptoms = @(Get-SentenceHits $sentences $script:FailureWords)
  $goals = @(Get-UniqueList (@(Get-SentenceHits $sentences $script:ChangeVerbs) + @($ctxGoals)) 4)

  $missing = New-Object System.Collections.ArrayList
  if ($targets.Count -eq 0) { [void]$missing.Add('target') }
  if ($success.Count -eq 0) { [void]$missing.Add('success') }
  if ($symptoms.Count -gt 0 -and $errors.Count -eq 0) { [void]$missing.Add('evidence') }
  if ($tests.Count -eq 0) { [void]$missing.Add('check') }
  if ($constraints.Count -eq 0) { [void]$missing.Add('constraints') }

  return @{
    draft       = $d
    sentences   = $sentences
    targets     = $targets
    errors      = $errors
    tests       = $tests
    constraints = $constraints
    success     = $success
    symptoms    = $symptoms
    goals       = $goals
    attempts    = $attempts
    repo        = (Get-CtxValue $Ctx 'Repo')
    missing     = @($missing)
    targetFromContext = (@($targets | Where-Object { $draftFiles -notcontains $_ -and $draftPlaces -notcontains $_ }).Count -gt 0)
    errorFromContext  = (@($errors | Where-Object { (Get-ErrorSnippets $d) -notcontains $_ }).Count -gt 0)
    testFromContext   = (@($tests | Where-Object { (Get-TestCommands $d) -notcontains $_ -and $draftTestFiles -notcontains $_ }).Count -gt 0)
    successFromContext = (@($success | Where-Object { (Get-FinishLines $d $sentences) -notcontains $_ }).Count -gt 0)
  }
}

function Test-PathWithin([string]$Path, [string]$Root) {
  if ([string]::IsNullOrWhiteSpace($Path) -or [string]::IsNullOrWhiteSpace($Root)) { return $false }
  try {
    $p = [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
    $r = [IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
  } catch { return $false }
  if ($p.Equals($r, [StringComparison]::OrdinalIgnoreCase)) { return $true }
  $sep = [IO.Path]::DirectorySeparatorChar
  return $p.StartsWith(($r + $sep), [StringComparison]::OrdinalIgnoreCase)
}

# Repo context is read only when the active directory is inside a root the
# developer registered. It is cached for 20 s because the gate answers in
# milliseconds and git status on a real tree is the slowest thing on this path.
function Get-RepoContext([string]$Cwd) {
  if ([string]::IsNullOrWhiteSpace($Cwd)) { return $null }
  try { $full = [IO.Path]::GetFullPath($Cwd) } catch { return $null }
  $cfg = Get-CoachConfig
  $roots = @($cfg.registeredRoots | Where-Object { $_ })
  if ($roots.Count -eq 0) { return $null }
  $inside = $false
  foreach ($r in $roots) { if (Test-PathWithin $full ([string]$r)) { $inside = $true; break } }
  if (-not $inside) { return $null }

  $key = $full.ToLowerInvariant()
  $now = [DateTime]::UtcNow
  if ($script:RepoContextCache.ContainsKey($key)) {
    $cached = $script:RepoContextCache[$key]
    if (($now - $cached.at).TotalSeconds -lt 20) { return $cached.value }
  }

  $git = Get-Command git -ErrorAction SilentlyContinue
  if (-not $git) { return $null }
  $oldLocks = $env:GIT_OPTIONAL_LOCKS
  $env:GIT_OPTIONAL_LOCKS = '0'
  try {
    $top = @(& git -C $full rev-parse --show-toplevel 2>$null)
    if ($LASTEXITCODE -ne 0 -or $top.Count -eq 0) { return $null }
    $root = ([string]$top[0]).Trim()
    if (-not $root) { return $null }
    $branch = @(& git -C $root branch --show-current 2>$null)
    $status = @(& git -C $root status --porcelain=v1 -uno 2>$null)
    $paths = New-Object System.Collections.ArrayList
    foreach ($line in $status) {
      $s = [string]$line
      if ($s.Length -lt 4) { continue }
      $p = $s.Substring(3).Trim().Trim('"')
      if ($p -match ' -> ') { $p = ($p -split ' -> ')[-1] }
      if ($p) { [void]$paths.Add($p) }
    }
    $value = @{
      name    = (Split-Path -Leaf $root)
      root    = $root
      branch  = if ($branch.Count -gt 0) { ([string]$branch[0]).Trim() } else { '' }
      changed = @($paths | Select-Object -First 8)
      dirty   = $paths.Count
      isGit   = $true
    }
    $script:RepoContextCache[$key] = @{ at = $now; value = $value }
    return $value
  } catch {
    return $null
  } finally {
    if ($oldLocks -eq $null) { Remove-Item Env:\GIT_OPTIONAL_LOCKS -ErrorAction SilentlyContinue }
    else { $env:GIT_OPTIONAL_LOCKS = $oldLocks }
  }
}

# The object of a destructive verb, taken from the draft itself. Quoting it is
# what makes the question specific: "remove all of the old models" asks about
# that phrase, not about deletion in the abstract. A compound ask keeps both
# objects: "delete the old folder and reset the database" asks about both.
function Get-DestructiveObject([string]$Draft) {
  if ([string]::IsNullOrWhiteSpace($Draft)) { return '' }
  $verb = '(?:remove|removing|delete|deleting|drop|dropping|purge|purging|erase|erasing|wipe|wiping|reset|resetting|clear|clearing|trash|destroy|destroying|uninstall|uninstalling|strip|stripping|kill|killing)'
  $seen = New-Object System.Collections.ArrayList
  $segments = [regex]::Split($Draft, '(?i)(?:,|\s+and)\s+(?=' + $verb + '\b)')
  foreach ($seg in $segments) {
    $m = [regex]::Match($seg, '(?i)\b' + $verb + '\b\s+(?<obj>[^.,;!?\r\n]{1,120})')
    if (-not $m.Success) { continue }
    $obj = [regex]::Replace($m.Groups['obj'].Value, '\s+', ' ').Trim()
    $obj = [regex]::Replace($obj, '(?i)\s+(that way|so that|so you|so i|so we|because|since|in order to|to make|please)\b.*$', '').Trim()
    $obj = $obj.Trim(' ', ',', ';', ':', '-')
    if ($obj.Length -gt 70) { $obj = $obj.Substring(0, 70).TrimEnd() }
    if ($obj -and -not ($seen -contains $obj)) { [void]$seen.Add($obj) }
    if ($seen.Count -ge 3) { break }
  }
  return ($seen -join ' and ')
}

function Get-RepoLine($Repo) {
  if (-not $Repo) { return $null }
  $name = [string](Get-CtxValue $Repo 'name')
  $branch = [string](Get-CtxValue $Repo 'branch')
  $dirty = Get-CtxValue $Repo 'dirty'
  $changed = @(Get-CtxList $Repo 'changed')
  $parts = @()
  if ($name) { $parts += $name }
  if ($branch) { $parts += ('branch ' + $branch) }
  if ($dirty -ne $null) { $parts += ([string]$dirty + ' changed file(s)') }
  if ($changed.Count -gt 0) { $parts += ('touching ' + (($changed | Select-Object -First 3) -join ', ')) }
  if ($parts.Count -eq 0) { return $null }
  return ($parts -join '; ')
}

function Build-SmartPrompt {
  param([string]$Draft, $Ctx, $Slots, [string[]]$RepoFacts = @())

  $d = ([string]$Draft).Trim()
  if (-not $Slots) { $Slots = Get-IntentSlots $d $Ctx }
  $lines = New-Object System.Collections.ArrayList
  [void]$lines.Add($d)

  # Only facts that were actually supplied earn a line. A missing fact is one
  # question below; it is never a placeholder in the context block, because a
  # placeholder is what makes a compiled prompt read like a form letter.
  $facts = New-Object System.Collections.ArrayList
  if (@($Slots.targets).Count -gt 0) {
    [void]$facts.Add('- Target: ' + (Join-NaturalList @($Slots.targets | Select-Object -First 3)))
  }
  if (@($Slots.errors).Count -gt 0) {
    [void]$facts.Add('- Evidence: ' + ((@($Slots.errors | Select-Object -First 2)) -join ' | '))
  }
  if (@($Slots.constraints).Count -gt 0) {
    [void]$facts.Add('- Limits: ' + ((@($Slots.constraints | Select-Object -First 2)) -join '; '))
  }
  if (@($Slots.tests).Count -gt 0) {
    [void]$facts.Add('- Tests: ' + (Join-NaturalList @($Slots.tests | Select-Object -First 2)))
  }
  if ([int]$Slots.attempts -ge 2) {
    [void]$facts.Add('- Prior attempts: ' + [string]$Slots.attempts + ' similar asks.')
  }
  $repoLine = Get-RepoLine $Slots.repo
  if ($repoLine) { [void]$facts.Add('- Repo: ' + $repoLine + '.') }
  if ($facts.Count -gt 0) {
    [void]$lines.Add('')
    [void]$lines.Add('Context:')
    foreach ($f in $facts) { [void]$lines.Add([string]$f) }
  }

  # The analyzer's briefs are cached, hash-checked, and only served for files
  # the draft already names. They arrive after the deterministic context so the
  # developer's own facts stay first.
  if (@($RepoFacts).Count -gt 0) {
    [void]$lines.Add('')
    [void]$lines.Add('Repo facts:')
    foreach ($f in @($RepoFacts | Select-Object -First 2)) { [void]$lines.Add([string]$f) }
  }

  $hasFinish = (@($Slots.success).Count -gt 0)
  if ($hasFinish) {
    [void]$lines.Add('')
    $finish = [string](@($Slots.success | Select-Object -First 1))[0]
    [void]$lines.Add('Finish line: ' + $finish)
  }

  $text = ($lines -join "`n").Trim()
  if ($text.Length -gt 1800) { $text = $text.Substring(0, 1800).TrimEnd() + '...' }
  return $text
}

# The compiled prompt is the developer's words plus earned context. The context
# is what the plugin attaches to the outgoing request; the developer's words are
# already the message and must not be repeated inside the attachment.
function Get-SmartAttachment {
  param([string]$Draft, [string]$Smart)
  if ([string]::IsNullOrWhiteSpace($Draft) -or [string]::IsNullOrWhiteSpace($Smart)) { return '' }
  $d = $Draft.Trim()
  $s = $Smart.Trim()
  if (-not $s.StartsWith($d, [StringComparison]::Ordinal)) { return '' }
  return $s.Substring($d.Length).Trim()
}

function Get-CtxText($Ctx) {
  if (-not $Ctx) { return '' }
  $parts = New-Object System.Collections.ArrayList
  foreach ($name in @('Files', 'Errors', 'Tests', 'Success', 'Constraints', 'Goals')) {
    foreach ($v in @(Get-CtxList $Ctx $name)) { [void]$parts.Add([string]$v) }
  }
  $repo = Get-CtxValue $Ctx 'Repo'
  if ($repo) {
    foreach ($name in @('name', 'branch', 'changed')) {
      foreach ($v in @(Get-CtxList $repo $name)) { [void]$parts.Add([string]$v) }
    }
    $d = Get-CtxValue $repo 'dirty'
    if ($d -ne $null) { [void]$parts.Add([string]$d) }
  }
  $a = Get-CtxValue $Ctx 'Attempts'
  if ($a -ne $null) { [void]$parts.Add([string]$a) }
  return ($parts -join "`n")
}

function Test-SmartPromptFaithful {
  param([string]$Draft, [string]$Smart, $Ctx, [string]$ExtraAllowed = '')
  if ([string]::IsNullOrWhiteSpace($Smart)) { return @{ ok = $false; why = 'empty' } }
  $d = ([string]$Draft).Trim()
  if (-not $Smart.StartsWith($d, [StringComparison]::Ordinal)) { return @{ ok = $false; why = 'original-not-first' } }
  $max = [math]::Min(2200, [math]::Max(900, ($d.Length * 4) + 1200))
  if ($Smart.Length -gt $max) { return @{ ok = $false; why = 'too-long' } }
  if ($Smart -match '(?i)(<task>|</task>|\bas an ai\b|^\s*requirements\s*:)') { return @{ ok = $false; why = 'label-syntax' } }

  $allowed = $d + "`n" + (Get-CtxText $Ctx)
  if ($ExtraAllowed) { $allowed = $allowed + "`n" + $ExtraAllowed }
  foreach ($f in @(Get-FileTokens $Smart)) {
    if ($allowed.IndexOf($f, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
      return @{ ok = $false; why = ('file-not-grounded:' + $f) }
    }
  }
  foreach ($n in @(Get-Numbers $Smart)) {
    if ($allowed -notmatch ('(?<!\d)' + [regex]::Escape($n) + '(?!\d)')) {
      return @{ ok = $false; why = ('number-not-grounded:' + $n) }
    }
  }
  foreach ($m in [regex]::Matches($Smart, '`[^`]+`')) {
    if ($allowed.IndexOf($m.Value, [StringComparison]::Ordinal) -lt 0) {
      return @{ ok = $false; why = 'specific-not-grounded' }
    }
  }
  return @{ ok = $true; why = 'ok' }
}

function Get-SmartApproach {
  param([string]$Draft, $Ctx, $Slots)
  if (-not $Slots) { $Slots = Get-IntentSlots $Draft $Ctx }
  $steps = New-Object System.Collections.ArrayList

  # A destructive ask changes what has to happen before any edit, so it is the
  # first step, not a footnote. The test is the same one the gap detector uses,
  # so "clean that up" about code never produces a database-snapshot lecture.
  if (Test-DestructiveAsk $Draft) {
    $thing = Get-DestructiveObject $Draft
    if ($thing) {
      [void]$steps.Add('Inventory "' + $thing + '" by exact path or name, take a recovery point, then delete only what is on that list.')
    } else {
      [void]$steps.Add('List the exact paths or names being removed, take a recovery point, then delete only what is on that list.')
    }
  }
  if ([int]$Slots.attempts -ge 2) {
    [void]$steps.Add('This is ask ' + [string]$Slots.attempts + ' on the same problem. List the two most likely causes and the evidence for each before another edit.')
  }
  if (@($Slots.targets).Count -gt 0) {
    $named = @($Slots.targets | Select-Object -First 2)
    $pronoun = if ($named.Count -gt 1) { 'their' } else { 'its' }
    $featureVerb = '(?i)\b(add|adds|adding|support|supports|supporting|implement\w*|create|creates|creating|introduce\w*|new)\b'
    if (@($Slots.symptoms).Count -gt 0) {
      [void]$steps.Add('Start from ' + (Join-NaturalList $named) + ', reproduce the failure there, and follow ' + $pronoun + ' callers before editing.')
    } elseif ($Draft -match $featureVerb) {
      [void]$steps.Add('Start from ' + (Join-NaturalList $named) + ' and extend the closest existing pattern rather than adding a parallel one.')
    } else {
      [void]$steps.Add('Start from ' + (Join-NaturalList $named) + ', follow ' + $pronoun + ' callers, and keep the change to the files that own the behavior.')
    }
  }
  $repo = $Slots.repo
  if ($repo) {
    $dirty = Get-CtxValue $repo 'dirty'
    if ($dirty -ne $null -and [int]$dirty -gt 0) {
      [void]$steps.Add('The working tree already has changes; inspect the diff and do not revert unrelated work.')
    }
  }

  # A finish line that already exists is not repeated here; a missing one is the
  # open question above, not a second instruction saying the same thing.
  $principles = @(Get-PrinciplesForText -Draft $Draft -Ctx $Ctx -Gaps $null)
  foreach ($p in $principles) {
    if ($p.id -in @('trust-boundary', 'state-and-concurrency', 'read-the-bytecode', 'measure-before-optimizing')) {
      $first = @($p.approach)[0]
      if ($first) { [void]$steps.Add([string]$first) }
    }
    if ($steps.Count -ge 6) { break }
  }

  return @(Get-UniqueList $steps 4)
}

function Get-SmartGrounding {
  param([string]$Draft, $Ctx, $Slots)
  if (-not $Slots) { $Slots = Get-IntentSlots $Draft $Ctx }
  $items = New-Object System.Collections.ArrayList
  $draftFiles = @(Get-FileTokens $Draft)
  $draftPlaces = @(Get-PlaceTokens $Draft)
  $draftTestFiles = @(Get-TestFileTokens $draftFiles)
  foreach ($t in @($Slots.targets)) {
    if ($draftFiles -notcontains $t -and $draftPlaces -notcontains $t) { [void]$items.Add('target: ' + $t + ' (earlier message)') }
  }
  foreach ($e in @($Slots.errors)) {
    if (@(Get-ErrorSnippets $Draft) -notcontains $e) { [void]$items.Add('error: ' + $e + ' (earlier message)') }
  }
  foreach ($t in @($Slots.tests)) {
    if (@(Get-TestCommands $Draft) -notcontains $t -and $draftTestFiles -notcontains $t) { [void]$items.Add('check: ' + $t + ' (earlier message)') }
  }
  foreach ($s in @($Slots.success)) {
    if (@(Get-FinishLines $Draft @(Get-Sentences $Draft)) -notcontains $s) { [void]$items.Add('success: ' + $s + ' (earlier message)') }
  }
  foreach ($c in @($Slots.constraints)) {
    if (@(Get-ConstraintLines $Draft @(Get-Sentences $Draft)) -notcontains $c) { [void]$items.Add('constraint: ' + $c + ' (earlier message)') }
  }
  $repoLine = Get-RepoLine $Slots.repo
  if ($repoLine) { [void]$items.Add('repo: ' + $repoLine + ' (git)') }
  if ([int]$Slots.attempts -ge 2) { [void]$items.Add('history: ' + [string]$Slots.attempts + ' similar asks (session)') }
  return @(Get-UniqueList $items 5)
}

# The daemon calls this instead of Get-HoldDecision. The base cost gate is
# unchanged; this adds the compiled prompt, the approach, and the grounding.
function Get-SmartDecision {
  param(
    [Parameter(Mandatory = $true)][string]$Draft,
    $Ctx,
    $Learner,
    [double]$SecondsPerReprompt = 45.0,
    [double]$BaseInterruptionSeconds = 10.0
  )

  $base = Get-HoldDecision -Draft $Draft -Ctx $Ctx -Learner $Learner `
    -SecondsPerReprompt $SecondsPerReprompt -BaseInterruptionSeconds $BaseInterruptionSeconds
  $slots = Get-IntentSlots $Draft $Ctx
  $principles = @(Get-PrinciplesForText -Draft $Draft -Ctx $Ctx -Gaps $base.gaps)
  $applied = @($principles | Where-Object { Test-PrincipleApplied $_ $Draft $Ctx } | ForEach-Object { [string]$_.id })

  $base.principles = @($principles | ForEach-Object { [string]$_.id })
  $base.applied = $applied
  $base.slots = $slots
  $base.approach = @(Get-SmartApproach -Draft $Draft -Ctx $Ctx -Slots $slots)
  $base.grounding = @(Get-SmartGrounding -Draft $Draft -Ctx $Ctx -Slots $slots)
  $base.smart = $false
  $base.compiled = $null
  $base.attachment = $null

  if (-not $base.hold) { return $base }

  $facts = @()
  if (Get-Command Get-AnalyzerFactsForDraft -ErrorAction SilentlyContinue) {
    try { $facts = @(Get-AnalyzerFactsForDraft -Draft $Draft -Ctx $Ctx) } catch { $facts = @() }
  }
  $base.analyzerFacts = @($facts)

  $compiled = Build-SmartPrompt -Draft $Draft -Ctx $Ctx -Slots $slots -RepoFacts $facts
  $faithful = Test-SmartPromptFaithful -Draft $Draft -Smart $compiled -Ctx $Ctx -ExtraAllowed ($facts -join "`n")
  $base.faithful = $faithful
  if ($faithful.ok) {
    $base.compiled = $compiled
    $base.attachment = Get-SmartAttachment -Draft $Draft -Smart $compiled
    $base.smart = $true
  } else {
    # Fall back to the one-sentence guardrail rather than show a prompt that
    # invented a fact. The sentence is still the thing the developer chose, so
    # it travels as an attachment: their words stay the message.
    $base.compiled = $null
    $base.attachment = Get-SmartAttachment -Draft $Draft -Smart $base.guardrail
  }
  return $base
}
