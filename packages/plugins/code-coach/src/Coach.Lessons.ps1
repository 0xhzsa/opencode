# Coach.Lessons.ps1 - three forms per gap: a principle, the mechanism, and a worked example.
# Rotation is the learning: the same gap seen again shows the form you have not seen.
# Worked examples are labelled \"example\" and are constructed, except the outcome one,
# which is a real draft from this machine.

$script:LessonForms = @{
  'outcome' = @(
    'A request is done when you can tell afterward whether it was met.'
    'A change verb plus a word like "better" names no state to check, so the model substitutes its own idea of done and stops at the first patch that looks plausible.'
    'Real draft: "the detection still doesnt work half the time ... make it reliable". Reliable compared to what? "Stop only when the card appears before the send and you can show the failing case passing" gives the same work a finish line you can check.'
  )
  'target' = @(
    'The model cannot see your screen; naming the place turns a search into a look.'
    'With no file, route or screen named, the model has to locate the code by keyword, and the first match is often a neighbour of the real one.'
    'Example: "the export is broken, fix it" becomes "the CSV export in report.js drops rows with quotes, fix that". Same ask, one fewer search.'
  )
  'observed-vs-expected' = @(
    'A bug report is two facts: what happens now, and what should happen.'
    'With only one side of the bug stated, the model cannot tell whether the code or the expectation is wrong, so it edits the first thing that looks wrong.'
    'Example: "save does not work" becomes "save writes the row but the list still shows the old value until refresh; it should update in place". The second sentence is the half that usually goes missing.'
  )
  'evidence' = @(
    'Exact error text cuts the search to a few lines.'
    'No error text means the model matches the symptom to its most common cause, not yours, and the first fix is a guess with a confident tone.'
    'Example: "the build fails after my change" becomes "the build fails with TS2345 at app.ts:41, argument of type string is not assignable to number". Two lines of output save a round trip.'
  )
  'constraint' = @(
    'What you would reject in review is cheaper to say first.'
    'Touching an interface with no stated limits leaves the model free to change callers, names and data shapes, and every one of those is a review comment later.'
    'Example: "add a nickname to the user schema" becomes "add a nullable nickname column, keep the existing rows valid, no changes to the API response shape".'
  )
  'scope' = @(
    'Unscoped asks produce unscoped diffs.'
    'A wide verb with no boundary lets the model improve neighbours you never asked about, and the diff grows past what you can check in one sitting.'
    'Example: "refactor the import code" becomes "extract the CSV parsing in import.js into a function, leave the rest of the file alone".'
  )
  'check' = @(
    'Give it a check and it can verify its own work before you see it.'
    'With no command or expected output named, the model stops when the code looks right to it, which is the same judgement that produced the bug.'
    'Example: "make the retry back off" becomes "make the retry back off, then run tests\Run-Queue.ps1 and paste the result". The check is the difference between a claim and a test.'
  )
  'checkpoint' = @(
    'Commit before an agent run so undo is one command.'
    'A broad ask on a dirty tree turns one bad edit into a diff you cannot separate from your own work, and the revert takes longer than the change.'
    'Example: 30 changed files and "improve the whole app" - commit first, or the first thing you will do is try to remember which changes were yours.'
  )
  'ref-check' = @(
    'The model fills a missing name with a guess.'
    'A name that does not resolve becomes a plausible invention that looks right in the diff, and the compiler catches it only if you are lucky enough to compile.'
    'Example: "call parseConfig in app.js" - if parseConfig does not exist in the project, the model will write one that almost matches the call site.'
  )
  'stuck' = @(
    'When the same ask fails twice, the model picture of the problem is wrong; change what it knows.'
    'Similar retries resend the same context, so the model makes the same assumption again, and the third attempt looks like the first two.'
    'Example: "make the card show faster" twice, unchanged. The third attempt should start with "here is what the log says and what I already ruled out", not the same sentence again.'
  )
}

function Get-LessonForm([string]$GapId, [int]$Index = 0) {
  $forms = $script:LessonForms[$GapId]
  if (-not $forms -or $forms.Count -eq 0) { return $null }
  $i = $Index % $forms.Count
  if ($i -lt 0) { $i += $forms.Count }
  return $forms[$i]
}

function Get-LessonCount([string]$GapId) {
  $forms = $script:LessonForms[$GapId]
  if (-not $forms) { return 0 }
  return $forms.Count
}

function Get-LessonGapIds { return @($script:LessonForms.Keys) }
