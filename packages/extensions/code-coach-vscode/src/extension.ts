import * as vscode from "vscode";
import { type Finding, decide } from "./triage";
import { Profile } from "./profile";
import { rewritePrompt } from "./rewriter";

/**
 * Code Coach extension entry point.
 *
 * The coach is a silent side-panel that watches edits and nudges. It never
 * blocks the editor, never changes what you typed, and never sends anything.
 *
 * Breaks the input into a debounced save queue, scores each saved change with
 * the triage engine (passing the learner profile's mastered concepts), and
 * shows the card when there is something worth saying. Silence is the default.
 *
 * Webview buttons (Explain/Fix/Ignore) are wired via onDidReceiveMessage.
 */

const DEBOUNCE_MS = 900;
const MAX_RESULTS = 2;
const MAX_REVISIONS = 5;

class Ring {
  items: string[] = [];
  push(text: string) {
    this.items.push(text);
    if (this.items.length > MAX_REVISIONS) this.items.shift();
  }
}

export function activate(context: vscode.ExtensionContext) {
  const ring = new Ring();

  // Profile lives in global storage so it persists across sessions.
  const profileDir = context.globalStorageUri.fsPath;
  const profile = new Profile(profileDir + "/profile.jsonl");

  const panel = vscode.window.createWebviewPanel(
    "codeCoach.card",
    "Code Coach",
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true }
  );

  let lastFindings: Finding[] = [];
  let lastOriginalText = "";
  let timer: NodeJS.Timeout | undefined;

  // Wire the webview buttons. This is what makes the card interactive.
  panel.webview.onDidReceiveMessage(async (msg: { command: string }) => {
    switch (msg.command) {
      case "explain": {
        const snap = profile.snapshot();
        const depth = depthFor(snap.counts, lastFindings.flatMap((f) => f.tags));
        const explainHtml = lastFindings
          .map((f) => {
            const deep =
              depth >= 2
                ? `<p class="deep"><strong>Failure mode:</strong> ${escapeHtml(f.why)}</p>`
                : depth === 1
                ? `<p class="deep"><strong>Principle + tradeoff:</strong> ${escapeHtml(f.why)} ${escapeHtml(f.fix)}</p>`
                : `<p class="deep"><strong>Analogy first:</strong> ${escapeHtml(f.why)}</p><p><strong>Fix:</strong> ${escapeHtml(f.fix)}</p>`;
            return `<div class="finding"><h2>${escapeHtml(f.title)}</h2>${deep}</div>`;
          })
          .join("");
        panel.webview.html = renderCard(lastFindings, explainHtml, true);
        break;
      }
      case "fix": {
        const rewritten = rewritePrompt(lastOriginalText, lastFindings);
        await vscode.env.clipboard.writeText(rewritten);
        vscode.window.showInformationMessage("Code Coach: rewritten prompt copied to clipboard.");
        for (const f of lastFindings) {
          profile.record(f.id, f.tags);
        }
        break;
      }
      case "ignore": {
        panel.dispose();
        break;
      }
      case "back": {
        panel.webview.html = renderCard(lastFindings);
        break;
      }
    }
  });

  function show(nudges: Finding[]) {
    if (!nudges.length) {
      panel.webview.html = renderCard([]);
      return;
    }
    lastFindings = nudges;
    panel.webview.html = renderCard(nudges);
  }

  const onSave = (text: string) => {
    ring.push(text);
    lastOriginalText = text;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const texts = ring.items;
      const findings: Finding[] = [];
      const snap = profile.snapshot();
      const knownTags = snap.mastered;
      for (const text of texts) {
        const result = decide(text, text, knownTags);
        if (result.kind === "nudge") {
          for (const f of result.findings) {
            if (!findings.some((x) => x.id === f.id)) {
              findings.push(f);
            }
          }
        }
      }
      for (const f of findings) {
        profile.record(f.id, f.tags);
      }
      show(findings.slice(0, MAX_RESULTS));
    }, DEBOUNCE_MS);
  };

  const disposable = vscode.workspace.onDidSaveTextDocument((doc) => {
    onSave(doc.getText());
  });

  context.subscriptions.push(disposable);

  panel.webview.html = renderCard([]);
}

function depthFor(counts: Record<string, number>, tags: string[]): number {
  const max = tags.reduce((m, t) => Math.max(m, counts[t] ?? 0), 0);
  if (max >= 3) return 2;
  if (max >= 2) return 1;
  return 0;
}

function renderCard(nudges: Finding[], explainHtml?: string, isExplain = false): string {
  if (isExplain && explainHtml) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<style>
  body { font-family: var(--vscode-font-family); margin: 0; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); }
  .card { max-width: 640px; margin: 24px auto; padding: 20px; border: 1px solid var(--vscode-focusBorder); border-radius: 8px; background: var(--vscode-editorWidget-background); }
  h1 { margin: 0 0 8px; font-size: 16px; }
  p { margin: 8px 0; line-height: 1.45; }
  .deep { margin-top: 12px; padding: 12px; border-left: 3px solid var(--vscode-focusBorder); background: var(--vscode-editor-inactiveSelectionBackground); }
  .actions { display: flex; gap: 8px; margin-top: 16px; }
  button { padding: 6px 12px; cursor: pointer; }
  .finding { border-top: 1px solid var(--vscode-widget-border); padding-top: 12px; margin-top: 12px; }
  .finding h2 { margin: 0 0 4px; font-size: 14px; }
</style>
</head>
<body>
  <div class="card">
    <h1>Code Coach — Explain</h1>
    ${explainHtml}
    <div class="actions">
      <button id="back">Back</button>
    </div>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    (() => {
      const post = (command) => vscode.postMessage({ command });
      document.getElementById("back")?.addEventListener("click", () => post("back"));
    })();
  </script>
</body>
</html>`;
  }

  const actions = nudges.length
    ? `<div class="actions">
        <button id="explain">Explain why</button>
        <button id="fix">Fix my prompt</button>
        <button id="ignore">Ignore</button>
      </div>`
    : `<p class="empty">No edits flagged yet. Silence is the default.</p>`;
  const list = nudges.map((f) => `
    <div class="finding">
      <h2>${escapeHtml(f.title)}</h2>
      <p>${escapeHtml(f.why)}</p>
      <p class="fix"><strong>Fix:</strong> ${escapeHtml(f.fix)}</p>
      <p class="tags"><small>${escapeHtml(f.tags.join(", "))}</small></p>
    </div>`).join("");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<style>
  body { font-family: var(--vscode-font-family); margin: 0; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); }
  .card { max-width: 640px; margin: 24px auto; padding: 20px; border: 1px solid var(--vscode-focusBorder); border-radius: 8px; background: var(--vscode-editorWidget-background); }
  h1 { margin: 0 0 8px; font-size: 16px; }
  p { margin: 8px 0; line-height: 1.45; }
  .empty { color: var(--vscode-descriptionForeground); }
  .actions { display: flex; gap: 8px; margin-top: 16px; }
  button { padding: 6px 12px; cursor: pointer; }
  .finding { border-top: 1px solid var(--vscode-widget-border); padding-top: 12px; margin-top: 12px; }
  .finding h2 { margin: 0 0 4px; font-size: 14px; }
  .fix { margin-top: 6px; }
  .tags { color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
  <div class="card">
    <h1>Code Coach</h1>
    <p>Keeping your edits safe. Silence is the default.</p>
    ${list}
    ${actions}
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    (() => {
      const post = (command) => vscode.postMessage({ command });
      document.getElementById("explain")?.addEventListener("click", () => post("explain"));
      document.getElementById("fix")?.addEventListener("click", () => post("fix"));
      document.getElementById("ignore")?.addEventListener("click", () => post("ignore"));
    })();
  </script>
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch] ?? ch;
  });
}
