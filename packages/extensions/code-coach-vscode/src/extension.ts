import * as vscode from "vscode";
import { type Finding, decide } from "./triage";
import { Profile } from "./profile";
import { rewritePrompt } from "./rewriter";
import { McpClient } from "./mcpClient";
import { computeDiff } from "./diff";
import { looksLikePrompt } from "./promptCapture";

/**
 * Code Coach extension entry point.
 *
 * Watches three signals:
 *   1. Saved diffs  - on save, computes a real line diff vs. the last baseline
 *                     and sends { prompt, diff } to the coach.
 *   2. Clipboard    - the developer's prompt from Cursor/Copilot/Claude chat is
 *                     copied to the clipboard; we keep the last prose-looking
 *                     text and pair it with the next diff.
 *   3. Terminal     - error output is captured and sent as context.
 *
 * The card is persistent: it stays until Ignore or Snooze. Silence is the
 * default. The AI coach (MCP server) is used when available; the deterministic
 * regex engine is the offline fallback.
 */

const DEBOUNCE_MS = 900;
const MAX_RESULTS = 2;
const SNOOZE_MS = 5 * 60 * 1000;
const PROMPT_TTL_MS = 10 * 60 * 1000;

interface CoachResult {
  interrupt: boolean;
  uncertain?: boolean;
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
  const profile = new Profile(profileFile(context));
  const mcp = new McpClient(resolveMcpPath(context));
  let mcpReady = false;
  let mcpStarting: Promise<boolean> | null = null;

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.text = "$(eye) Code Coach";
  status.tooltip = "Code Coach is watching. Save a file or run 'Code Coach: Coach this prompt'.";
  status.command = "code-coach.coachPrompt";
  status.show();
  context.subscriptions.push(status);

  const panel = vscode.window.createWebviewPanel(
    "codeCoach.card",
    "Code Coach",
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true }
  );

  const baseline = new Map<string, string>();
  const lastPrompt = { text: "", ts: 0 };
  let lastResult: CoachResult | null = null;
  let lastPromptUsed = "";
  let snoozedUntil = 0;
  let timer: NodeJS.Timeout | undefined;

  // Seed the baseline so the first save has something to diff against.
  for (const doc of vscode.workspace.textDocuments) {
    baseline.set(doc.uri.toString(), doc.getText());
  }

  function ensureMcp(): Promise<boolean> {
    if (mcpReady) return Promise.resolve(true);
    if (!mcpStarting) {
      mcpStarting = mcp
        .start()
        .then(() => {
          mcpReady = true;
          return true;
        })
        .catch(() => {
          mcpReady = false;
          return false;
        });
    }
    return mcpStarting;
  }

  async function runCoach(prompt: string, diff: string, source: string): Promise<void> {
    if (Date.now() < snoozedUntil) return;
    if (!diff.trim() && !prompt.trim()) return;

    lastPromptUsed = prompt;
    status.text = "$(sync~spin) Code Coach";
    status.tooltip = "Thinking about your last change...";

    let result: CoachResult | null = null;
    if (await ensureMcp()) {
      try {
        result = (await mcp.callTool("coach", { prompt, diff, source })) as CoachResult;
      } catch {
        result = null;
      }
    }

    if (!result) result = offlineCoach(prompt, diff, profile);

    if (result?.interrupt) {
      lastResult = result;
      panel.webview.html = renderCard(result);
      status.text = "$(eye) Code Coach — 1 nudge";
      status.tooltip = result.nudge ?? "";
      panel.reveal(vscode.ViewColumn.Beside, true);
    } else {
      lastResult = null;
      panel.webview.html = renderCard(null, result?.reason);
      status.text = "$(eye) Code Coach";
      status.tooltip = "Silence is the default.";
    }
  }

  function schedule(prompt: string, diff: string, source: string): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void runCoach(prompt, diff, source);
    }, DEBOUNCE_MS);
  }

  // --- signal 1: saved diffs ------------------------------------------------
  const saveSub = vscode.workspace.onDidSaveTextDocument((doc) => {
    const key = doc.uri.toString();
    const before = baseline.get(key);
    const after = doc.getText();
    baseline.set(key, after);
    if (before === undefined) return;
    const diff = computeDiff(before, after);
    if (!diff.trim()) return;

    const freshPrompt =
      lastPrompt.text && Date.now() - lastPrompt.ts < PROMPT_TTL_MS ? lastPrompt.text : "";
    const prompt = freshPrompt || `Edit to ${vscode.workspace.asRelativePath(doc.uri)}`;
    schedule(prompt, diff, "save");
  });
  context.subscriptions.push(saveSub);

  // --- signal 2: clipboard prompt capture -----------------------------------
  const clipTimer = setInterval(async () => {
    try {
      const text = await vscode.env.clipboard.readText();
      if (text && text !== lastPrompt.text && looksLikePrompt(text)) {
        lastPrompt.text = text;
        lastPrompt.ts = Date.now();
      }
    } catch {
      // clipboard can be unavailable; ignore
    }
  }, 2000);
  context.subscriptions.push({ dispose: () => clearInterval(clipTimer) });

  // --- signal 3: terminal errors --------------------------------------------
  try {
    const anyWindow = vscode.window as unknown as {
      onDidWriteTerminalData?: (cb: (e: { data: string }) => void) => vscode.Disposable;
    };
    const termSub = anyWindow.onDidWriteTerminalData?.((e) => {
      const text = String(e?.data ?? "");
      if (/error|fail|cannot find|exception|traceback/i.test(text)) {
        const prompt = lastPrompt.text || "Terminal error";
        schedule(prompt, "TERMINAL:\n" + text.slice(0, 2000), "terminal");
      }
    });
    if (termSub) context.subscriptions.push(termSub);
  } catch {
    // terminal data API is proposed in some VS Code versions
  }

  // --- commands -------------------------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand("code-coach.coachPrompt", async () => {
      const prompt = await vscode.window.showInputBox({
        prompt: "What did you ask the coding agent?",
        placeHolder: "e.g. Add a login endpoint that checks the password",
        value: lastPrompt.text,
      });
      if (!prompt) return;
      lastPrompt.text = prompt;
      lastPrompt.ts = Date.now();
      const doc = vscode.window.activeTextEditor?.document;
      const diff = doc ? computeDiff(baseline.get(doc.uri.toString()) ?? "", doc.getText()) : "";
      await runCoach(prompt, diff || doc?.getText() || "", "command");
    }),

    vscode.commands.registerCommand("code-coach.coachClipboard", async () => {
      const prompt = await vscode.env.clipboard.readText();
      if (!prompt.trim()) {
        vscode.window.showWarningMessage("Code Coach: clipboard is empty.");
        return;
      }
      lastPrompt.text = prompt;
      lastPrompt.ts = Date.now();
      const doc = vscode.window.activeTextEditor?.document;
      const diff = doc ? computeDiff(baseline.get(doc.uri.toString()) ?? "", doc.getText()) : "";
      await runCoach(prompt, diff || doc?.getText() || "", "clipboard");
    }),

    vscode.commands.registerCommand("code-coach.snooze", () => {
      snoozedUntil = Date.now() + SNOOZE_MS;
      panel.webview.html = renderCard(null, "Snoozed for 5 minutes.");
    }),

    vscode.commands.registerCommand("code-coach.showProfile", async () => {
      const snap = profile.snapshot();
      const items = Object.entries(snap.counts)
        .sort((a, b) => b[1] - a[1])
        .map(([tag, n]) => ({
          label: tag,
          description: `${n} hit${n === 1 ? "" : "s"}${snap.mastered.includes(tag) ? " — mastered" : ""}`,
        }));
      await vscode.window.showQuickPick(
        items.length ? items : [{ label: "No concepts yet", description: "Save a file to start." }],
        { title: "Code Coach — Learner Profile" }
      );
    }),

    vscode.commands.registerCommand("code-coach.clearProfile", async () => {
      const ok = await vscode.window.showWarningMessage(
        "Reset the Code Coach learner profile?",
        { modal: true },
        "Reset"
      );
      if (ok === "Reset") {
        profile.reset();
        vscode.window.showInformationMessage("Code Coach: learner profile reset.");
      }
    })
  );

  // --- webview buttons ------------------------------------------------------
  panel.webview.onDidReceiveMessage(async (msg: { command: string }) => {
    switch (msg.command) {
      case "explain":
        if (lastResult) panel.webview.html = renderExplain(lastResult);
        break;
      case "fix":
        if (lastResult?.better_prompt) {
          await vscode.env.clipboard.writeText(lastResult.better_prompt);
          vscode.window.showInformationMessage(
            "Code Coach: better prompt copied. Paste it into your coding agent."
          );
        } else {
          await vscode.env.clipboard.writeText(rewritePrompt(lastPromptUsed, []));
          vscode.window.showInformationMessage("Code Coach: rewritten prompt copied.");
        }
        break;
      case "snooze":
        snoozedUntil = Date.now() + SNOOZE_MS;
        panel.webview.html = renderCard(null, "Snoozed for 5 minutes.");
        break;
      case "ignore":
        panel.webview.html = renderCard(null);
        break;
      case "back":
        panel.webview.html = renderCard(lastResult);
        break;
    }
  });

  panel.webview.html = renderCard(null);
}

// --- helpers ----------------------------------------------------------------

function profileFile(context: vscode.ExtensionContext): string {
  return Profile.pathOf(context.globalStorageUri.fsPath);
}

function resolveMcpPath(context: vscode.ExtensionContext): string {
  const configured = vscode.workspace.getConfiguration("codeCoach").get<string>("mcpServerPath");
  if (configured && configured.trim()) return configured.trim();
  // Default: sibling package in the same repo.
  return vscode.Uri.joinPath(context.extensionUri, "..", "code-coach-mcp", "dist", "index.js").fsPath;
}

function offlineCoach(prompt: string, diff: string, profile: Profile): CoachResult {
  const snap = profile.snapshot();
  const findings: Finding[] = [];
  const decision = decide(prompt, diff, snap.mastered);
  if (decision.kind === "nudge") {
    for (const f of decision.findings) {
      if (!findings.some((x) => x.id === f.id)) findings.push(f);
    }
  }
  if (!findings.length) return { interrupt: false, reason: "No issues detected. Silence is the default." };

  const top = findings[0];
  for (const f of findings) profile.record(f.id, f.tags);
  return {
    interrupt: true,
    severity: top.severity,
    nudge: top.title,
    explanation: `${top.why} ${top.fix}`,
    better_prompt: rewritePrompt(prompt, findings.slice(0, MAX_RESULTS)),
    concept_tags: top.tags,
    quiz: null,
  };
}

function renderCard(result: CoachResult | null, message?: string): string {
  if (message && !result) {
    return wrapCard(`<p class="empty">${escapeHtml(message)}</p>`, "");
  }
  if (!result || !result.interrupt) {
    return wrapCard(`<p class="empty">No issues detected. Silence is the default.</p>`, "");
  }

  const severity = result.severity ?? "info";
  const color = severity === "critical" ? "#f44747" : severity === "warn" ? "#cca700" : "#3794ff";
  const tags = (result.concept_tags ?? []).join(", ");

  const body = `
    <div class="finding">
      <h2 style="color:${color}">${escapeHtml(severity.toUpperCase())} · ${escapeHtml(result.nudge ?? "")}</h2>
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

  return wrapCard(body, `
    const vscode = acquireVsCodeApi();
    const post = (command) => vscode.postMessage({ command });
    document.getElementById("explain").addEventListener("click", () => post("explain"));
    document.getElementById("fix").addEventListener("click", () => post("fix"));
    document.getElementById("snooze").addEventListener("click", () => post("snooze"));
    document.getElementById("ignore").addEventListener("click", () => post("ignore"));
  `);
}

function renderExplain(result: CoachResult): string {
  const body = `
    <div class="finding">
      <h2>Deep dive</h2>
      <p>${escapeHtml(result.explanation ?? "")}</p>
      ${result.better_prompt ? `<p class="better"><strong>Better prompt:</strong> ${escapeHtml(result.better_prompt)}</p>` : ""}
      ${result.quiz ? `<p class="quiz"><strong>Quiz:</strong> ${escapeHtml(result.quiz)}</p>` : ""}
    </div>
    <div class="actions"><button id="back">Back</button></div>`;

  return wrapCard(body, `
    const vscode = acquireVsCodeApi();
    document.getElementById("back").addEventListener("click", () => vscode.postMessage({ command: "back" }));
  `);
}

function wrapCard(body: string, script: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<style>
  body { font-family: var(--vscode-font-family); margin: 0; padding: 12px; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); }
  .card { max-width: 640px; margin: 0 auto; padding: 16px; border: 1px solid var(--vscode-focusBorder); border-radius: 8px; background: var(--vscode-editorWidget-background); }
  h1 { margin: 0 0 8px; font-size: 16px; }
  h2 { margin: 0 0 8px; font-size: 14px; }
  p { margin: 8px 0; line-height: 1.45; }
  .empty { color: var(--vscode-descriptionForeground); font-style: italic; }
  .actions { display: flex; gap: 8px; margin-top: 16px; flex-wrap: wrap; }
  button { padding: 6px 12px; cursor: pointer; border: none; border-radius: 4px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
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
  <script>
    (() => {
      ${script}
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
