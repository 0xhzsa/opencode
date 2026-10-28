import * as vscode from "vscode";
import { type Finding, decide } from "./triage";
import { Profile } from "./profile";
import { rewritePrompt } from "./rewriter";
import { McpClient } from "./mcpClient";
import { computeDiff } from "./diff";
import { ObserverHub, type Observation } from "./observe/hub";
import { BrowserObserver } from "./observe/cdp";
import { UiaObserver } from "./observe/uia";
import { ClipboardObserver } from "./observe/clipboard";

/**
 * Code Coach extension entry point.
 *
 * Every signal goes through one ObserverHub:
 *   1. Saved diffs   - LCS diff vs. the last baseline.
 *   2. Terminal      - error/failure lines as context.
 *   3. Clipboard     - prose copied from any chat UI.
 *   4. Browser (CDP) - the composer of a real browser chat tab, opt-in.
 *   5. Windows UIA   - the focused Edit control in desktop apps, opt-in.
 *
 * Prompt-only observations run the coach on the prompt. Diff observations
 * pair the latest prompt with the change. The card is persistent: it stays
 * until Ignore or Snooze. Silence is the default.
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
  source?: string;
  profile?: { counts: Record<string, number>; mastered: string[] };
}

export function activate(context: vscode.ExtensionContext) {
  const profile = new Profile(profileFile(context));
  const mcp = new McpClient(resolveMcpPath(context));
  let mcpReady = false;
  let mcpStarting: Promise<boolean> | null = null;

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = "code-coach.showObservers";
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
  let coachSeq = 0;

  let clipboard: ClipboardObserver | undefined;
  let browser: BrowserObserver | undefined;
  let uia: UiaObserver | undefined;

  const hub = new ObserverHub((observation) => onObservation(observation));

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

  function rememberPrompt(text: string): void {
    const t = text.trim();
    if (!t) return;
    // Never let a generated placeholder become the "last prompt".
    if (/^Edit to /.test(t) || t === "Terminal error") return;
    lastPrompt.text = t;
    lastPrompt.ts = Date.now();
  }

  function freshPrompt(): string {
    if (!lastPrompt.text) return "";
    if (Date.now() - lastPrompt.ts > PROMPT_TTL_MS) return "";
    return lastPrompt.text;
  }

  function sourceLabel(o: Observation): string {
    if (o.source === "browser") return `browser:${o.app ?? "unknown"}`;
    if (o.source === "uia") return `uia:${o.app ?? "unknown"}`;
    return o.source;
  }

  async function runCoach(
    prompt: string,
    diff: string,
    source: string,
    contextText = ""
  ): Promise<void> {
    if (Date.now() < snoozedUntil) return;
    if (!diff.trim() && !prompt.trim()) return;

    const seq = ++coachSeq;
    status.text = "$(sync~spin) Code Coach";
    status.tooltip = "Thinking about your last change...";

    let result: CoachResult | null = null;
    if (await ensureMcp()) {
      try {
        result = (await mcp.callTool("coach", {
          prompt,
          diff,
          context: contextText,
          source,
        })) as CoachResult;
      } catch {
        result = null;
      }
    }

    if (!result) result = offlineCoach(prompt, diff, profile);
    if (seq !== coachSeq) return; // a newer observation won

    lastPromptUsed = prompt;

    if (result?.interrupt) {
      lastResult = { ...result, source: result.source ?? source };
      panel.webview.html = renderCard(lastResult);
      status.text = "$(eye) Code Coach — 1 nudge";
      status.tooltip = `${result.nudge ?? ""}\nWatching: ${observerSummary()}`;
      panel.reveal(vscode.ViewColumn.Beside, true);
    } else {
      // Do not overwrite a card the developer is still reading with a
      // "nothing found" message. Silence means leave the current state alone.
      if (!lastResult) panel.webview.html = renderCard(null, result?.reason);
      setIdleStatus();
    }
  }

  function schedule(prompt: string, diff: string, source: string, contextText = ""): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void runCoach(prompt, diff, source, contextText);
    }, DEBOUNCE_MS);
  }

  function onObservation(o: Observation): void {
    if (Date.now() < snoozedUntil) return;

    if (o.diff || o.source === "terminal") {
      rememberPrompt(o.prompt);
      schedule(o.prompt, o.diff, sourceLabel(o), o.context ?? "");
      return;
    }

    // Prompt-only observation: the composer was submitted or the field lost
    // focus. Remember it so the next save pairs with it, and coach the prompt
    // itself right away.
    rememberPrompt(o.prompt);
    void runCoach(o.prompt, "", sourceLabel(o), o.context ?? "");
  }

  function observerSummary(): string {
    const parts = ["diff", "terminal"];
    if (clipboard) parts.push("clipboard");
    if (browser) parts.push(`browser(${browser.connected})`);
    if (uia) parts.push("uia");
    return parts.join(", ");
  }

  function setIdleStatus(): void {
    status.text = "$(eye) Code Coach";
    status.tooltip = `Watching: ${observerSummary()}. Click for observer status.`;
  }

  function stopObservers(): void {
    clipboard?.stop();
    clipboard = undefined;
    browser?.stop();
    browser = undefined;
    uia?.stop();
    uia = undefined;
  }

  function startObservers(): void {
    stopObservers();
    const cfg = vscode.workspace.getConfiguration("codeCoach");

    if (cfg.get<boolean>("observe.clipboard", true)) {
      clipboard = new ClipboardObserver(
        () => vscode.env.clipboard.readText(),
        (text) => {
          hub.push({ prompt: text, diff: "", source: "clipboard" });
        }
      );
      clipboard.start();
    }

    if (cfg.get<boolean>("observe.browser", false)) {
      browser = new BrowserObserver({
        port: cfg.get<number>("cdpPort", 9222),
        onPrompt: (p) => {
          hub.push({
            prompt: p.text,
            diff: "",
            source: "browser",
            app: p.host,
            title: p.title,
          });
        },
        onStatus: () => setIdleStatus(),
      });
      browser.start();
    }

    if (cfg.get<boolean>("observe.uia", false)) {
      const candidate = new UiaObserver({
        scriptPath: resolveUiaScript(context),
        onPrompt: (p) => {
          hub.push({
            prompt: p.text,
            diff: "",
            source: "uia",
            app: p.app,
            title: p.title,
          });
        },
        onStatus: () => setIdleStatus(),
      });
      if (candidate.start()) uia = candidate;
    }

    setIdleStatus();
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

    const prompt = freshPrompt() || `Edit to ${vscode.workspace.asRelativePath(doc.uri)}`;
    hub.push({ prompt, diff, source: "save" });
  });
  context.subscriptions.push(saveSub);

  // --- signal 2: terminal errors --------------------------------------------
  try {
    const anyWindow = vscode.window as unknown as {
      onDidWriteTerminalData?: (cb: (e: { data: string }) => void) => vscode.Disposable;
    };
    const termSub = anyWindow.onDidWriteTerminalData?.((e) => {
      const text = String(e?.data ?? "");
      if (!/error|fail|cannot find|exception|traceback/i.test(text)) return;
      hub.push({
        prompt: freshPrompt() || "Terminal error",
        diff: "",
        source: "terminal",
        title: "terminal",
        context: "TERMINAL:\n" + text.slice(0, 2000),
      });
    });
    if (termSub) context.subscriptions.push(termSub);
  } catch {
    // terminal data API is proposed in some VS Code versions
  }

  // --- observers ------------------------------------------------------------
  startObservers();
  context.subscriptions.push(
    { dispose: stopObservers },
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("codeCoach.observe") || e.affectsConfiguration("codeCoach.cdpPort")) {
        startObservers();
      }
    })
  );

  // --- commands -------------------------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand("code-coach.coachPrompt", async () => {
      const prompt = await vscode.window.showInputBox({
        prompt: "What did you ask the coding agent?",
        placeHolder: "e.g. Add a login endpoint that checks the password",
        value: lastPrompt.text,
      });
      if (!prompt) return;
      rememberPrompt(prompt);
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
      rememberPrompt(prompt);
      const doc = vscode.window.activeTextEditor?.document;
      const diff = doc ? computeDiff(baseline.get(doc.uri.toString()) ?? "", doc.getText()) : "";
      await runCoach(prompt, diff || doc?.getText() || "", "clipboard");
    }),

    vscode.commands.registerCommand("code-coach.showObservers", async () => {
      const cfg = vscode.workspace.getConfiguration("codeCoach");
      const port = cfg.get<number>("cdpPort", 9222);
      const items: (vscode.QuickPickItem & { id: string })[] = [
        {
          id: "save",
          label: "Save diffs",
          description: "always on",
          detail: "Line diff against the last saved baseline on every save.",
        },
        {
          id: "terminal",
          label: "Terminal errors",
          description: "when the VS Code API is available",
          detail: "Error/failure lines are sent as context.",
        },
        {
          id: "clipboard",
          label: "Clipboard",
          description: clipboard ? "on" : "off",
          detail: "Prose copied from any chat UI.",
        },
        {
          id: "browser",
          label: "Browser chat (CDP)",
          description: browser ? `on — ${browser.connected} tab(s)` : "off",
          detail: `Reads the composer of Claude/ChatGPT/Gemini tabs on 127.0.0.1:${port}. Requires launching the browser with --remote-debugging-port.`,
        },
        {
          id: "uia",
          label: "Desktop apps (Windows UIA)",
          description: uia ? "on" : "off",
          detail: "Reads the focused Edit control. Best effort; never hooks the keyboard.",
        },
      ];

      const picked = await vscode.window.showQuickPick(items, {
        title: "Code Coach — Observers",
      });
      if (picked?.id !== "browser") return;

      const command = `chrome.exe --remote-debugging-port=${port} --user-data-dir="%TEMP%\\code-coach-chrome"`;
      const action = await vscode.window.showInformationMessage(
        "Launch Chrome with the debugging port, then log in to Claude/ChatGPT once in that profile.",
        "Copy command"
      );
      if (action === "Copy command") await vscode.env.clipboard.writeText(command);
    }),

    vscode.commands.registerCommand("code-coach.snooze", () => {
      snoozedUntil = Date.now() + SNOOZE_MS;
      lastResult = null;
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
        lastResult = null;
        panel.webview.html = renderCard(null, "Snoozed for 5 minutes.");
        break;
      case "ignore":
        lastResult = null;
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
  return vscode.Uri.joinPath(context.extensionUri, "..", "code-coach-mcp", "dist", "index.js").fsPath;
}

function resolveUiaScript(context: vscode.ExtensionContext): string {
  return vscode.Uri.joinPath(context.extensionUri, "media", "uia-observer.ps1").fsPath;
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

function metaLine(result: CoachResult): string {
  const parts: string[] = [];
  if (result.source) parts.push(`From ${result.source}`);
  if (result.uncertain) parts.push("uncertain — verify before trusting");
  return parts.join(" · ");
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
  const meta = metaLine(result);

  const body = `
    <div class="finding">
      ${meta ? `<p class="meta">${escapeHtml(meta)}</p>` : ""}
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
  const meta = metaLine(result);
  const body = `
    <div class="finding">
      ${meta ? `<p class="meta">${escapeHtml(meta)}</p>` : ""}
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
  .meta { color: var(--vscode-descriptionForeground); font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
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
