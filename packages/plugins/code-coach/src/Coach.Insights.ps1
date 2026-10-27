# Coach.Insights.ps1 - one static page, written locally, opened in the browser.
# Every number comes from trace.jsonl and learner.json. No draft text exists there.

function ConvertTo-HtmlText([string]$Text) {
  if ($null -eq $Text) { return '' }
  return ($Text -replace '&', '&amp;' -replace '<', '&lt;' -replace '>', '&gt;' -replace '"', '&quot;')
}

function Get-CountMap($Rows, [string]$EventName, [string]$KeyName = 'gap') {
  $map = @{}
  foreach ($r in $Rows) {
    if ($r.ev -ne $EventName) { continue }
    $k = $null
    if ($r.PSObject.Properties.Name -contains $KeyName) { $k = [string]$r.$KeyName }
    if (-not $k) { continue }
    if (-not $map.ContainsKey($k)) { $map[$k] = 0 }
    $map[$k] = $map[$k] + 1
  }
  return $map
}

function New-InsightsPage {
  param(
    [string]$TraceFile,
    $State,
    [string]$OutPath
  )
  if (-not $TraceFile) { $TraceFile = $script:TracePath }
  if (-not $OutPath) { $OutPath = Join-Path $script:CoachData 'insights.html' }
  if (-not $State) { $State = Get-LearnerState }

  $rows = @(Read-TraceFile $TraceFile)
  $realDrafts = @($rows | Where-Object { $_.ev -eq 'send_observed' -and $_.dh } | ForEach-Object { $_.dh } | Sort-Object -Unique).Count
  $shown = Get-CountMap $rows 'card_shown'
  $accepted = Get-CountMap $rows 'accepted'
  $copied = Get-CountMap $rows 'copied'
  $dismissed = Get-CountMap $rows 'dismissed'
  $unchanged = Get-CountMap $rows 'sent_unchanged'
  $afterSend = @($rows | Where-Object { $_.ev -eq 'card_after_send' }).Count
  $cardsShown = @($rows | Where-Object { $_.ev -eq 'card_shown' }).Count
  $surfOk = @($rows | Where-Object { $_.ev -eq 'surface_accepted' }).Count
  $surfNo = @($rows | Where-Object { $_.ev -eq 'surface_rejected' }).Count
  $gateReq = @($rows | Where-Object { $_.ev -eq 'gate_req' }).Count
  $gateHold = @($rows | Where-Object { $_.ev -eq 'gate_hold' }).Count
  $gatePass = @($rows | Where-Object { $_.ev -eq 'gate_pass' }).Count
  $gateTimeout = @($rows | Where-Object { $_.ev -eq 'gate_timeout' }).Count
  $gateAutosend = @($rows | Where-Object { $_.ev -eq 'gate_autosend' }).Count
  $gateUnfaithful = @($rows | Where-Object { $_.ev -eq 'gate_unfaithful' }).Count
  $codeRepeat = @($rows | Where-Object { $_.ev -eq 'code_repeat' }).Count
  $smartShown = @($rows | Where-Object { $_.ev -eq 'card_shown' -and $_.smart }).Count
  $smartAccepted = @($rows | Where-Object { $_.ev -eq 'smart_prompt_accepted' }).Count
  $smartCopied = @($rows | Where-Object { $_.ev -eq 'smart_prompt_copied' }).Count
  $smartDismissed = @($rows | Where-Object { $_.ev -eq 'smart_prompt_dismissed' }).Count
  $guardrailAccepted = @($rows | Where-Object { $_.ev -eq 'guardrail_accepted' }).Count
  $codeShown = @($rows | Where-Object { $_.ev -eq 'card_shown' -and $_.kind -eq 'code' }).Count
  $codeCopied = @($rows | Where-Object { $_.ev -eq 'code_suggestion_copied' }).Count
  $codeDismissed = @($rows | Where-Object { $_.ev -eq 'code_suggestion_dismissed' }).Count
  $principleApplied = Get-CountMap $rows 'principle_applied' 'principle'
  $principleRetained = Get-CountMap $rows 'principle_retained' 'principle'
  $appliedTotal = @($rows | Where-Object { $_.ev -eq 'principle_applied' }).Count
  $retainedTotal = @($rows | Where-Object { $_.ev -eq 'principle_retained' }).Count
  $due = @(Get-DueReviews $State 8)

  $gapIds = @('outcome', 'target', 'observed-vs-expected', 'evidence', 'constraint', 'scope', 'check', 'checkpoint', 'ref-check', 'stuck')
  $sb = New-Object System.Text.StringBuilder
  [void]$sb.AppendLine('<!doctype html><html lang="en"><meta charset="utf-8"><title>Code Coach insights</title>')
  [void]$sb.AppendLine('<style>')
  [void]$sb.AppendLine(':root{--bg:#16181c;--card:#1e2126;--line:#2e333b;--text:#eef1f5;--dim:#a7aeb8;--accent:#4c9aff;--good:#4cc38a;--bad:#e5726d}')
  [void]$sb.AppendLine('*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 "Segoe UI",system-ui,sans-serif;padding:32px}')
  [void]$sb.AppendLine('h1{font-size:20px;margin:0 0 4px}h2{font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:var(--dim);margin:32px 0 10px}')
  [void]$sb.AppendLine('.big{font-size:44px;font-weight:600;line-height:1;margin:8px 0}.sub{color:var(--dim);font-size:12px}')
  [void]$sb.AppendLine('.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}')
  [void]$sb.AppendLine('.stat{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px}')
  [void]$sb.AppendLine('.stat b{display:block;font-size:22px;font-weight:600}')
  [void]$sb.AppendLine('table{border-collapse:collapse;width:100%;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden}')
  [void]$sb.AppendLine('th,td{text-align:left;padding:9px 12px;border-bottom:1px solid var(--line);font-variant-numeric:tabular-nums}')
  [void]$sb.AppendLine('th{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--dim);font-weight:600}')
  [void]$sb.AppendLine('tr:last-child td{border-bottom:0}')
  [void]$sb.AppendLine('.bar{height:6px;background:#2a2f37;border-radius:3px;overflow:hidden;min-width:80px}.bar i{display:block;height:100%;background:var(--accent)}')
  [void]$sb.AppendLine('.quiet{color:var(--dim)}.ok{color:var(--good)}.warn{color:var(--bad)}')
  [void]$sb.AppendLine('footer{margin-top:36px;color:var(--dim);font-size:12px}')
  [void]$sb.AppendLine('</style>')
  [void]$sb.AppendLine('<h1>Code Coach insights</h1>')
  [void]$sb.AppendLine(('<div class="sub">generated {0} · data: {1}</div>' -f (ConvertTo-HtmlText ([DateTime]::Now.ToString('yyyy-MM-dd HH:mm'))), (ConvertTo-HtmlText $script:CoachData)))
  [void]$sb.AppendLine('<div class="big">' + $realDrafts + '</div>')
  [void]$sb.AppendLine('<div class="sub">real drafts behind every number on this page · distinct hashes · nothing here is a constructed sample</div>')

  [void]$sb.AppendLine('<h2>Volume</h2><div class="grid">')
  [void]$sb.AppendLine(('<div class="stat"><b>{0}</b><span class="sub">cards shown</span></div>' -f $cardsShown))
  [void]$sb.AppendLine(('<div class="stat"><b>{0}</b><span class="sub">accepted</span></div>' -f (@($rows | Where-Object { $_.ev -eq 'accepted' }).Count)))
  [void]$sb.AppendLine(('<div class="stat"><b>{0}</b><span class="sub">copied</span></div>' -f (@($rows | Where-Object { $_.ev -eq 'copied' }).Count)))
  [void]$sb.AppendLine(('<div class="stat"><b>{0}</b><span class="sub">dismissed</span></div>' -f (@($rows | Where-Object { $_.ev -eq 'dismissed' }).Count)))
  [void]$sb.AppendLine(('<div class="stat"><b>{0}</b><span class="sub">sent unchanged</span></div>' -f (@($rows | Where-Object { $_.ev -eq 'sent_unchanged' }).Count)))
  [void]$sb.AppendLine('</div>')

  [void]$sb.AppendLine('<h2>Lateness</h2><div class="grid">')
  [void]$sb.AppendLine(('<div class="stat"><b>{0}</b><span class="sub">cards after send</span></div>' -f $afterSend))
  [void]$sb.AppendLine(('<div class="stat"><b>{0}</b><span class="sub">cards before send</span></div>' -f [math]::Max(0, $cardsShown - $afterSend)))
  [void]$sb.AppendLine(('<div class="stat"><b>{0}</b><span class="sub">gate requests</span></div>' -f $gateReq))
  [void]$sb.AppendLine(('<div class="stat"><b>{0}</b><span class="sub">holds</span></div>' -f $gateHold))
  [void]$sb.AppendLine(('<div class="stat"><b>{0}</b><span class="sub">timeouts (send went through)</span></div>' -f $gateTimeout))
  [void]$sb.AppendLine('</div>')

  [void]$sb.AppendLine('<h2>Delivery</h2><div class="grid">')
  [void]$sb.AppendLine(('<div class="stat"><b>{0}</b><span class="sub">autosent with no card or wait</span></div>' -f $gateAutosend))
  [void]$sb.AppendLine(('<div class="stat"><b>{0}</b><span class="sub">sent unchanged (failed the fidelity check)</span></div>' -f $gateUnfaithful))
  [void]$sb.AppendLine(('<div class="stat"><b>{0}</b><span class="sub">code repeats suppressed</span></div>' -f $codeRepeat))
  [void]$sb.AppendLine('</div>')

  [void]$sb.AppendLine('<h2>Surfaces</h2><div class="grid">')
  [void]$sb.AppendLine(('<div class="stat"><b>{0}</b><span class="sub">prompt surfaces accepted</span></div>' -f $surfOk))
  [void]$sb.AppendLine(('<div class="stat"><b>{0}</b><span class="sub">foreground windows rejected</span></div>' -f $surfNo))
  [void]$sb.AppendLine('</div>')

  [void]$sb.AppendLine('<h2>Prompt quality</h2><div class="grid">')
  [void]$sb.AppendLine(('<div class="stat"><b>{0}</b><span class="sub">context-rich prompts shown</span></div>' -f $smartShown))
  [void]$sb.AppendLine(('<div class="stat"><b>{0}</b><span class="sub">context attached</span></div>' -f $smartAccepted))
  [void]$sb.AppendLine(('<div class="stat"><b>{0}</b><span class="sub">compiled prompt copied</span></div>' -f $smartCopied))
  [void]$sb.AppendLine(('<div class="stat"><b>{0}</b><span class="sub">draft sent without the context</span></div>' -f $smartDismissed))
  [void]$sb.AppendLine(('<div class="stat"><b>{0}</b><span class="sub">guardrail fallback accepted</span></div>' -f $guardrailAccepted))
  [void]$sb.AppendLine('</div>')

  [void]$sb.AppendLine('<h2>Code suggestions</h2><div class="grid">')
  [void]$sb.AppendLine(('<div class="stat"><b>{0}</b><span class="sub">code findings shown</span></div>' -f $codeShown))
  [void]$sb.AppendLine(('<div class="stat"><b>{0}</b><span class="sub">follow-up copied</span></div>' -f $codeCopied))
  [void]$sb.AppendLine(('<div class="stat"><b>{0}</b><span class="sub">follow-up dismissed</span></div>' -f $codeDismissed))
  [void]$sb.AppendLine(('<div class="stat"><b>{0}</b><span class="sub">principles applied unprompted</span></div>' -f $appliedTotal))
  [void]$sb.AppendLine(('<div class="stat"><b>{0}</b><span class="sub">principles retained in session</span></div>' -f $retainedTotal))
  [void]$sb.AppendLine('</div>')

  [void]$sb.AppendLine('<h2>Principles</h2>')
  [void]$sb.AppendLine('<table><tr><th>principle</th><th>mastery</th><th>applied</th><th>retained</th><th>shown</th><th>accepted</th><th>review</th></tr>')
  $principleIds = @()
  if ($State.principles) { $principleIds = @($State.principles.Keys | Sort-Object) }
  if ($principleIds.Count -eq 0) {
    [void]$sb.AppendLine('<tr><td colspan="7" class="quiet">No principle has been seen yet.</td></tr>')
  } else {
    foreach ($principleId in $principleIds) {
      $p = $State.principles[$principleId]
      $name = [string]$principleId
      if (Get-Command Get-Principle -ErrorAction SilentlyContinue) {
        $def = Get-Principle ([string]$principleId)
        if ($def) { $name = [string]$def.name }
      }
      $m = [double]$p.mastery
      $dueText = '-'
      if ($p.dueAt) {
        try {
          $when = [DateTimeOffset]::Parse([string]$p.dueAt)
          if ($when -le [DateTimeOffset]::UtcNow) { $dueText = 'due' }
          else { $dueText = $when.ToLocalTime().ToString('MMM d') }
        } catch { $dueText = '-' }
      }
      [void]$sb.AppendLine(('<tr><td>{0}</td><td><div class="bar"><i style="width:{1}%"></i></div></td><td>{2}</td><td>{3}</td><td>{4}</td><td>{5}</td><td>{6}</td></tr>' -f `
        (ConvertTo-HtmlText $name), [int]($m * 100), [int]$p.applied, [int]$p.retained, [int]$p.shown, [int]$p.accepted, (ConvertTo-HtmlText $dueText)))
    }
  }
  [void]$sb.AppendLine('</table>')

  if ($due.Count -gt 0) {
    [void]$sb.AppendLine('<h2>Due review</h2>')
    [void]$sb.AppendLine('<table><tr><th>principle</th><th>question</th><th>mastery</th></tr>')
    foreach ($r in @($due | Select-Object -First 5)) {
      $q = [string]$r.question
      if (-not $q) { $q = [string]$r.statement }
      [void]$sb.AppendLine(('<tr><td>{0}</td><td>{1}</td><td>{2}%</td></tr>' -f `
        (ConvertTo-HtmlText ([string]$r.name)), (ConvertTo-HtmlText $q), [int]([double]$r.mastery * 100)))
    }
    [void]$sb.AppendLine('</table>')
  } else {
    [void]$sb.AppendLine('<h2>Due review</h2><p class="quiet">No principle is due. Reviews are spaced by mastery and acceptance.</p>')
  }

  [void]$sb.AppendLine('<h2>Gaps</h2>')
  [void]$sb.AppendLine('<table><tr><th>gap</th><th>shown</th><th>accepted</th><th>copied</th><th>dismissed</th><th>sent unchanged</th><th>mastery</th><th>state</th></tr>')
  foreach ($g in $gapIds) {
    $m = 0.0
    if ($State.mastery.ContainsKey($g)) { $m = [double]$State.mastery[$g] }
    $quiet = Test-GapQuiet $State $g
    $stateText = if ($quiet) { 'quiet' } else { 'watching' }
    $cls = if ($quiet) { 'quiet' } else { '' }
    [void]$sb.AppendLine(('<tr class="{0}"><td>{1}</td><td>{2}</td><td>{3}</td><td>{4}</td><td>{5}</td><td>{6}</td><td><div class="bar"><i style="width:{7}%"></i></div></td><td>{8}</td></tr>' -f `
      $cls, (ConvertTo-HtmlText $g), $shown[$g], $accepted[$g], $copied[$g], $dismissed[$g], $unchanged[$g], [int]($m * 100), $stateText))
  }
  [void]$sb.AppendLine('</table>')

  [void]$sb.AppendLine('<footer>Draft text is never written to disk. This page is built from hashes, lengths, gap ids, timings and outcomes only. Delete it any time with the file.</footer>')
  [void]$sb.AppendLine('</html>')

  $dir = Split-Path -Parent $OutPath
  if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  [IO.File]::WriteAllText($OutPath, $sb.ToString(), (New-Object Text.UTF8Encoding($true)))

  return @{
    path = $OutPath
    realDrafts = $realDrafts
    cardsShown = $cardsShown
    afterSend = $afterSend
    gateAutosend = $gateAutosend
    gateUnfaithful = $gateUnfaithful
    codeRepeat = $codeRepeat
    smartShown = $smartShown
    smartAccepted = $smartAccepted
    smartCopied = $smartCopied
    guardrailAccepted = $guardrailAccepted
    codeShown = $codeShown
    codeCopied = $codeCopied
    principleApplied = $appliedTotal
    principleRetained = $retainedTotal
    dueReviews = $due.Count
  }
}
