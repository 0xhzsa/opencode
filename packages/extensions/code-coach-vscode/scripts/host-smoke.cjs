/*
 * host-smoke.cjs - load the compiled extension against a stubbed `vscode` API
 * and drive real events through the real MCP server in mock mode.
 *
 * This exists because the extension cannot be launched in a real VS Code host
 * in CI. It catches the failures that unit tests miss: a broken manifest entry,
 * an activate() that throws, a command that was never registered, an observer
 * that never starts, or a card that is never rendered.
 *
 * Run it with node (not bun): it patches Module._load to supply `vscode`.
 */

const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const Module = require("node:module");

const extDir = path.resolve(__dirname, "..");
const dataDir = path.join(os.tmpdir(), "code-coach-host-smoke");
const noModel = process.argv.includes("--no-model");
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });

if (noModel) {
  // Simulate a dead model provider: the coach must fall back to the
  // deterministic engine instead of going silent.
  delete process.env.CODE_COACH_MOCK;
  delete process.env.OPENROUTER_API_KEY;
} else {
  process.env.CODE_COACH_MOCK = "1";
}
process.env.CODE_COACH_DATA_DIR = dataDir;

let clipboardText = "";
let saveCb = null;
const commands = new Map();

const webview = {
  html: "",
  onDidReceiveMessage() {
    return { dispose() {} };
  },
};
const panel = { webview, reveal() {}, dispose() {} };
const statusItem = { text: "", tooltip: "", command: "", show() {}, hide() {}, dispose() {} };

const configValues = {
  mcpServerPath: "",
  "observe.clipboard": true,
  "observe.browser": false,
  "observe.uia": false,
  cdpPort: 9222,
};

const doc = {
  text: "function find(name) {\n  return null;\n}\n",
  uri: { toString: () => "file:///tmp/app.ts", fsPath: path.join(dataDir, "app.ts") },
  getText() {
    return this.text;
  },
};

const vscode = {
  StatusBarAlignment: { Right: 2 },
  ViewColumn: { Beside: -2 },
  window: {
    createStatusBarItem: () => statusItem,
    createWebviewPanel: () => panel,
    showInputBox: async () => undefined,
    showQuickPick: async () => undefined,
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
  },
  workspace: {
    textDocuments: [doc],
    getConfiguration: () => ({ get: (key, def) => (key in configValues ? configValues[key] : def) }),
    onDidSaveTextDocument: (cb) => {
      saveCb = cb;
      return { dispose() {} };
    },
    onDidChangeConfiguration: () => ({ dispose() {} }),
    asRelativePath: () => "app.ts",
  },
  commands: {
    registerCommand: (name, cb) => {
      commands.set(name, cb);
      return { dispose() {} };
    },
  },
  env: {
    clipboard: {
      readText: async () => clipboardText,
      writeText: async () => {},
    },
  },
  Uri: {
    joinPath: (base, ...parts) => ({ fsPath: path.join(base.fsPath, ...parts) }),
  },
};

const originalLoad = Module._load;
Module._load = function (request) {
  if (request === "vscode") return vscode;
  return originalLoad.apply(this, arguments);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(label, predicate, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${label}\n--- card ---\n${webview.html.slice(0, 600)}`);
}

(async () => {
  const ext = require(path.join(extDir, "dist", "extension.js"));
  if (typeof ext.activate !== "function") throw new Error("dist/extension.js has no activate()");

  ext.activate({
    subscriptions: [],
    extensionUri: { fsPath: extDir },
    globalStorageUri: { fsPath: dataDir },
  });
  console.log("activate: ok");
  console.log("commands:", [...commands.keys()].join(", "));

  if (commands.size !== 6) throw new Error(`expected 6 commands, got ${commands.size}`);
  if (!statusItem.text.includes("Code Coach")) throw new Error("status bar not initialized");
  if (!webview.html.includes("Code Coach")) throw new Error("card was not rendered on activate");

  clipboardText = "Add a login endpoint that checks the password";
  await waitFor("clipboard prompt to reach the card", () => webview.html.includes("From clipboard"));
  if (!/password-hashing|input-validation/.test(webview.html)) {
    throw new Error("expected a password concept in the clipboard nudge");
  }
  console.log("clipboard observer -> coach: ok");

  doc.text =
    'function find(name) {\n  const q = "SELECT * FROM users WHERE name = \'" + name + "\'";\n  return db.query(q);\n}\n';
  if (!saveCb) throw new Error("save handler was never registered");
  saveCb(doc);

  await waitFor("save diff to reach the card", () => webview.html.includes("sql-injection"));
  if (!webview.html.includes("Better prompt")) throw new Error("card is missing the rewritten prompt");
  if (webview.html.includes("setTimeout")) throw new Error("card must not schedule an auto-dismiss");
  if (/OPENROUTER_API_KEY|OpenRouter \d{3}|"error"\s*:/.test(webview.html)) {
    throw new Error("card must not leak a provider error");
  }
  console.log("save diff -> coach: ok");
  console.log("persistent card (no timer): ok");
  if (noModel) console.log("deterministic fallback: ok");

  console.log("PASS");
  process.exit(0);
})().catch((err) => {
  console.error("FAIL:", err.message);
  process.exit(1);
});
