/*
 * cdp.ts - watch chat prompts in a real browser via the Chrome DevTools
 * Protocol.
 *
 * Why this exists: Cursor / Claude / ChatGPT prompts inside a browser live in
 * web content the VS Code API cannot see. CDP can read the composer element
 * directly. The user opts in by launching Chrome/Edge with
 * --remote-debugging-port, which is a local debugging port, not a backdoor.
 *
 * Detection is intentionally simple: poll the composer, remember the last
 * non-empty text, and emit it when the composer clears (which is what every
 * chat UI does on send). No keystrokes, no network interception.
 */

import { MiniWebSocket } from "./ws";

export interface CdpTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
}

export interface BrowserPrompt {
  text: string;
  host: string;
  title: string;
}

const CHAT_HOSTS = [
  "claude.ai",
  "chatgpt.com",
  "chat.openai.com",
  "gemini.google.com",
  "copilot.microsoft.com",
  "grok.com",
  "perplexity.ai",
  "chat.mistral.ai",
  "chat.deepseek.com",
];

export function isChatUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    const host = u.hostname.toLowerCase();
    return CHAT_HOSTS.some((h) => host === h || host.endsWith("." + h));
  } catch {
    return false;
  }
}

export async function findChatTargets(port = 9222, host = "127.0.0.1"): Promise<CdpTarget[]> {
  const res = await fetch(`http://${host}:${port}/json/list`, {
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) throw new Error(`CDP target list failed: ${res.status}`);
  const all = (await res.json()) as CdpTarget[];
  return all.filter(
    (t) => t.type === "page" && Boolean(t.webSocketDebuggerUrl) && isChatUrl(t.url)
  );
}

/*
 * Runs inside the page. Finds the visible composer, preferring the lowest and
 * widest candidate because chat composers sit at the bottom of the viewport.
 * Returns { text, host, title } or null. The outer code caps the result size.
 */
export const COMPOSER_EXPRESSION = `(() => {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 200 || r.height < 12) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.1;
  };
  const label = (el) =>
    ((el.getAttribute("aria-label") || "") + " " + (el.getAttribute("placeholder") || "")).toLowerCase();
  const read = (el) => {
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) return el.value || "";
    return el.innerText || el.textContent || "";
  };
  const selectors = [
    'div[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"]',
    'textarea[placeholder]',
    'textarea',
    '[role="textbox"]',
    '[data-testid="chat-input"]',
    '[contenteditable="true"]'
  ];
  let best = null;
  for (const sel of selectors) {
    for (const el of document.querySelectorAll(sel)) {
      if (!visible(el) || label(el).includes("search")) continue;
      const r = el.getBoundingClientRect();
      const score = r.bottom + Math.min(r.width, 1200) / 1000;
      if (!best || score > best.score) best = { score, text: read(el).trim() };
    }
  }
  if (!best) return null;
  return { text: best.text.slice(0, 8000), host: location.hostname, title: document.title };
})()`;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

export class CdpSession {
  private ws: MiniWebSocket;
  private nextId = 0;
  private pending = new Map<number, Pending>();
  private closed = false;

  private constructor(ws: MiniWebSocket) {
    this.ws = ws;
    ws.onmessage = (text) => this.onMessage(text);
    ws.onclose = () => this.failAll(new Error("CDP socket closed"));
  }

  static async connect(url: string): Promise<CdpSession> {
    const ws = await MiniWebSocket.connect(url);
    return new CdpSession(ws);
  }

  private onMessage(text: string): void {
    let msg: { id?: number; result?: unknown; error?: { message?: string } };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof msg.id !== "number") return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message ?? "CDP error"));
    else p.resolve(msg.result);
  }

  request(method: string, params: unknown, timeoutMs = 5000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (this.closed) {
        reject(new Error("CDP session is closed"));
        return;
      }
      const id = ++this.nextId;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`CDP request timed out: ${method}`));
      }, timeoutMs);
    });
  }

  async evaluate(expression: string): Promise<unknown> {
    const res = (await this.request("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: false,
    })) as { result?: { value?: unknown }; exceptionDetails?: { text?: string } };

    if (res?.exceptionDetails) {
      throw new Error(`CDP evaluate failed: ${res.exceptionDetails.text ?? "exception"}`);
    }
    return res?.result?.value ?? null;
  }

  private failAll(err: Error): void {
    this.closed = true;
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }

  close(): void {
    this.failAll(new Error("CDP session closed by client"));
    this.ws.close();
  }
}

interface TabState {
  session: CdpSession;
  lastText: string;
  lastTs: number;
}

export interface BrowserObserverOptions {
  port: number;
  onPrompt: (prompt: BrowserPrompt) => void;
  onStatus?: (connected: number, error?: string) => void;
  pollMs?: number;
  refreshMs?: number;
}

export class BrowserObserver {
  private tabs = new Map<string, TabState>();
  private timer: NodeJS.Timeout | undefined;
  private lastRefresh = 0;
  private stopped = false;
  private lastError = "";

  constructor(private opts: BrowserObserverOptions) {}

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.opts.pollMs ?? 1000);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const [, tab] of this.tabs) tab.session.close();
    this.tabs.clear();
  }

  get connected(): number {
    return this.tabs.size;
  }

  private async refresh(): Promise<void> {
    const now = Date.now();
    if (now - this.lastRefresh < (this.opts.refreshMs ?? 5000)) return;
    this.lastRefresh = now;

    let targets: CdpTarget[];
    try {
      targets = await findChatTargets(this.opts.port);
      this.lastError = "";
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      // Browser closed or CDP not enabled: drop dead sessions.
      for (const [id, tab] of this.tabs) {
        tab.session.close();
        this.tabs.delete(id);
      }
      this.opts.onStatus?.(0, this.lastError);
      return;
    }

    const live = new Set(targets.map((t) => t.id));
    for (const [id, tab] of this.tabs) {
      if (live.has(id)) continue;
      tab.session.close();
      this.tabs.delete(id);
    }

    for (const target of targets) {
      if (this.tabs.has(target.id)) continue;
      try {
        const session = await CdpSession.connect(target.webSocketDebuggerUrl);
        this.tabs.set(target.id, { session, lastText: "", lastTs: 0 });
      } catch {
        // One unresponsive tab must not kill the others.
      }
    }

    this.opts.onStatus?.(this.tabs.size, this.lastError || undefined);
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    await this.refresh();

    for (const [, tab] of this.tabs) {
      let value: unknown;
      try {
        value = await tab.session.evaluate(COMPOSER_EXPRESSION);
      } catch {
        continue;
      }
      if (!value || typeof value !== "object") continue;
      const v = value as { text?: unknown; host?: unknown; title?: unknown };
      const text = typeof v.text === "string" ? v.text.trim() : "";
      const now = Date.now();

      if (text) {
        tab.lastText = text;
        tab.lastTs = now;
        continue;
      }

      // The composer is empty. If it held text a moment ago, that text was
      // almost certainly just submitted (every chat UI clears on send).
      if (tab.lastText && now - tab.lastTs > 200) {
        const submitted = tab.lastText;
        tab.lastText = "";
        tab.lastTs = 0;
        this.opts.onPrompt({
          text: submitted,
          host: typeof v.host === "string" ? v.host : "browser",
          title: typeof v.title === "string" ? v.title : "",
        });
      }
    }
  }
}
