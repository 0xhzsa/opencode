import * as vscode from "vscode";
import { type Finding, decide } from "./triage";
import { Profile } from "./profile";
import { rewritePrompt } from "./rewriter";
import { McpClient } from "./mcpClient";

/**
 * Code Coach extension entry point.
 *
 * Two modes:
 * 1. AI mode (default): spawns the code-coach-mcp server and uses the
 *    AI-powered coach (triage + coach models, learner profile, project context).
 * 2. Offline mode (fallback): uses the deterministic regex engine when the
 *    MCP server is unavailable.
 *
 * The card is PERSISTENT — it stays until the user clicks Ignore or Snooze.
 * No auto-dismiss. No disappearing cards.
 */

const DEBOUNCE_MS = 900;
const MAX_RESULTS = 2;
const MAX_REVISIONS = 5;
const SNOOZE_MS = 5 * 60 * 1000; // 5 minutes

class Ring {
  items: string[] = [];
  push(text: string) {
    this.items.push(text);
    if (this.items.length > MAX_REVISIONS) this.items.shift();
  }
}

interface CoachResult {
  interrupt: boolean;
  severity?: string;
  nudge?: string;
  explanation?: string;
  better_prompt?: string;
  concept_tags?: string[];
  quiz?: string | null;
  reason?: string;
  profile?: { counts: Record<string, number>; mastered: string[] };
}

export function activate(context: vscode.ExtensionContext) {
  const ring = new Ring();
  const profileDir = context.globalStorageUri.fsPath;
  const profile = new Profile(profileDir + "/profile.jsonl");

  // MCP client for AI-powered coaching
  const mcpServerPath = vscode.workspace.getConfiguration("codeCoach").get<string>("mcpServerPath")
    ?? "";
  const mcpClient = new McpClient(mcpServerPath);
  let mcpReady = false;

  // Try to start MCP server
  if (mcpServerPath) {
    mcpClient.start().then(() => { mcpReady = true; }).catch(() => { mcpReady = false; });
  }

  const panel = vscode.window.createWebviewPanel(
    "codeCoach.card",
    "Code Coach",
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true }
  );

  let lastResult: CoachResult | null = null;
  let lastOriginalText = "";
  let timer: NodeJS.Timeout | undefined;
  let snoozedUntil = 0;

  panel.webview.onDidReceiveMessage(async (msg: { command: string }) => {
    switch (msg.command) {
      case "explain": {
        if (lastResult) {
          panel.webview.html = renderExplainCard(lastResult);
        }
        break;
      }
      case "fix": {
        if (lastResult?.better_prompt) {
          await vscode.env.clipboard.writeText(lastResult.better_prompt);
          vscode.window.showInformationMessage("Code Coach: better prompt copied to clipboard.");
        } else if (lastResult) {
          const rewritten = rewritePrompt(lastOriginalText, []);
          await vscode.env.clipboard.writeText(rewritten);
          vscode.window.showInformationMessage("Code Coach: rewritten prompt copied to clipboard.");
        }
        break;
      }
      case "ignore": {
        panel.webview.html = renderCard(null);
        break;
      }
      case "snooze": {
        snoozedUntil = Date.now() + SNOOZE_MS;
        panel.webview.html = renderCard(null, "Snoozed for 5 minutes. Save a file to resume.");
        break;
      }
      case "back": {
        panel.webview.html = renderCard(lastResult);
        break;
      }
    }
  });

  function show(result: CoachResult | null) {
    if (Date.now() < snoozedUntil) return;
    lastResult = result;
    panel.webview.html = renderCard(result);
  }

  const onSave = async (text: string) => {
    if (Date.now() < snoozedUntil) return;
    ring.push(text);
    lastOriginalText = text;
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      const texts = ring.items;
      const combined = texts.join("\n---\n");

      let result: CoachResult | null = null;

      if (mcpReady) {
        // AI-powered path: call the MCP server
        try {
          result = await mcpClient.callTool("coach", { prompt: combined, diff: combined });
        } catch {
          result = null;
        }
      }

      if (!result) {
        // Fallback: deterministic regex engine
        const snap = profile.snapshot();
        const knownTags = snap.mastered;
        const findings: Finding[] = [];
        for (const t of texts) {
          const r = decide(t, t, knownTags);
          if (r.kind === "nudge") {
            for (const f of r.findings) {
              if (!findings.some((x) => x.id === f.id)) findings.push(f);
            }
          }
        }
        if (findings.length > 0) {
          const f = findings[0];
          result = {
            interrupt: true,
            severity: f.severity,
            nudge: f.why,
            explanation: f.why + " " + f.fix,
            better_prompt: rewritePrompt(text, findings),
            concept_tags: f.tags,
            quiz: null,
          };
          for (const ff of findings) profile.record(ff.id, ff.tags);
        } else {
          result = { interrupt: false };
        }
      }

      if (result?.interrupt) {
        show(result);
      } else {
        show(null);
      }
    }, DEBOUNCE_MS);
  };

  const disposable = vscode.workspace.onDidSaveTextDocument((doc) => {
    onSave(doc.getText());
  });

  context.subscriptions.push(disposable);

  // Pre-heat: show empty card
  panel.webview.html = renderCard(null);
}

function renderCard(result: CoachResult | null, message?: string): string {
  if (message) {
    return wrapCard(`<p class="empty">${escapeHtml(message)}</p>`, false);
  }

  if (!result || !result.interrupt) {
    return wrapCard(`<p class="empty">No issues detected. Silence is the default.</p>`, false);
  }

  const severity = result.severity ?? "info";
  const severityColor = severity === "critical" ? "#f44747" : severity === "warn" ? "#cca700" : "#3794ff";
  const tags = (result.concept_tags ?? []).join(", ");

  const body = `
    <div class="finding">
      <h2 style="color: ${severityColor}">${escapeHtml(severity.toUpperCase())}: ${escapeHtml(result.nudge ?? "")}</h2>
      ${result.explanation ? `<p>${escapeHtml(result.explanation)}</p>` : ""}
      ${result.better_prompt ? `<p class="better"><strong>Better prompt:</strong> ${escapeHtml(result.better_prompt)}</p>` : ""}
      ${tags ? `<p class="tags"><small>Tags: ${escapeHtml(tags)}</small></p>` : ""}
      ${result.quiz ? `<p class="quiz"><strong>Quiz:</strong> ${escapeHtml(result.quiz)}</p>` : ""}
    </div>
    <div class="actions">
      <button id="explain">Explain why</button>
      <button id="fix">Fix my prompt</button>
      <button id="snooze">Snooze 5m</button>
      <button id="ignore">Ignore</button>
    </div>`;

  return wrapCard(body, true);
}

function renderExplainCard(result: CoachResult): string {
  const depth = (result.profile?.counts && Object.keys(result.profile.counts).length > 0) ? "intermediate" : "beginner";
  const body = `
    <div class="finding">
      <h2>Deep Dive</h2>
      <p>${escapeHtml(result.explanation ?? "")}</p>
      ${result.better_prompt ? `<p class="better"><strong>Better prompt:</strong> ${escapeHtml(result.better_prompt)}</p>` : ""}
      ${result.quiz ? `<p class="quiz"><strong>Quiz:</strong> ${escapeHtml(result.quiz)}</p>` : ""}
    </div>
    <div class="actions">
      <button id="back">Back</button>
    </div>`;
  return wrapCard(body, true, `
    const vscode = acquireVsCodeApi();
    document.getElementById("back")?.addEventListener("click", () => vscode.postMessage({ command: "back" }));
  `);
}

function wrapCard(body: string, hasButtons: boolean, extraScript = ""): string {
  const script = hasButtons ? `
    const vscode = acquireVsCodeApi();
    (() => {
      const post = (command) => vscode.postMessage({ command });
      document.getElementById("explain")?.addEventListener("click", () => post("explain"));
      document.getElementById("fix")?.addEventListener("click", () => post("fix"));
      document.getElementById("snooze")?.addEventListener("click", () => post("snooze"));
      document.getElementById("ignore")?.addEventListener("click", () => post("ignore"));
      ${extraScript}
    })();` : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<style>
  body { font-family: var(--vscode-font-family); margin: 0; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); padding: 12px; }
  .card { max-width: 640px; margin: 0 auto; padding: 16px; border: 1px solid var(--vscode-focusBorder); border-radius: 8px; background: var(--vscode-editorWidget-background); }
  h1 { margin: 0 0 8px; font-size: 16px; }
  h2 { margin: 0 0 8px; font-size: 14px; }
  p { margin: 8px 0; line-height: 1.45; }
  .empty { color: var(--vscode-descriptionForeground); font-style: italic; }
  .actions { display: flex; gap: 8px; margin-top: 16px; flex-wrap: wrap; }
  button { padding: 6px 12px; cursor: pointer; border: 1px solid var(--vscode-button-border, transparent); background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-radius: 4px; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  .finding { padding: 8px 0; }
  .better { margin-top: 8px; padding: 8px; background: var(--vscode-textBlockQuote-background); border-left: 3px solid var(--vscode-textBlockQuote-border); }
  .tags { color: var(--vscode-descriptionForeground); }
  .quiz { margin-top: 8px; font-style: italic; color: var(--vscode-textLink-foreground); }
</style>
</head>
<body>
  <div class="card">
    <h1>Code Coach</h1>
    ${body}
  </div>
  <script>${script}</script>
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch] ?? ch;
  });
}
