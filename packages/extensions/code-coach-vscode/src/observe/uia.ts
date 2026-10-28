/*
 * uia.ts - Windows UI Automation adapter.
 *
 * Reads the focused text field through Windows UI Automation (the same
 * accessibility API screen readers use). It never hooks the keyboard. The
 * PowerShell helper emits an event when a field is cleared (submit) or loses
 * focus, and this adapter keeps only prose-looking prompts from known chat
 * apps.
 *
 * Best effort by design: Electron apps expose different control trees, so a
 * chat composer that is not an Edit control simply produces no events. The
 * clipboard and explicit commands remain the fallback.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { looksLikePrompt } from "../promptCapture";

export interface UiaPrompt {
  text: string;
  app: string;
  title: string;
  event: "submitted" | "blurred" | "typed";
}

const CHAT_APPS = [
  "cursor",
  "claude",
  "chatgpt",
  "windsurf",
  "code",
  "vscode",
  "chrome",
  "msedge",
  "firefox",
  "brave",
  "arc",
];

export function isChatApp(app: string): boolean {
  const a = app.trim().toLowerCase();
  if (!a) return false;
  return CHAT_APPS.some((known) => a === known || a.includes(known));
}

export function parseUiaLine(line: string): UiaPrompt | null {
  const raw = line.trim();
  if (!raw.startsWith("{")) return null;

  let o: Record<string, unknown>;
  try {
    o = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }

  // Only Edit controls. A Document control is the whole page or editor
  // buffer; reading that would dump far more than a prompt.
  if (o.control !== "ControlType.Edit") return null;
  if (typeof o.text !== "string" || typeof o.app !== "string") return null;

  const text = o.text.trim();
  if (text.length < 8 || text.length > 2000) return null;

  const event = o.event === "blurred" || o.event === "typed" ? o.event : "submitted";
  return {
    text,
    app: o.app,
    title: typeof o.title === "string" ? o.title : "",
    event,
  };
}

export interface UiaObserverOptions {
  scriptPath: string;
  onPrompt: (prompt: UiaPrompt) => void;
  onStatus?: (running: boolean, error?: string) => void;
}

export class UiaObserver {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private lastError = "";

  constructor(private opts: UiaObserverOptions) {}

  start(): boolean {
    if (process.platform !== "win32") return false;
    if (this.proc) return true;

    this.proc = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        this.opts.scriptPath,
      ],
      { windowsHide: true }
    ) as ChildProcessWithoutNullStreams;

    this.proc.stdout.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() ?? "";
      for (const line of lines) {
        const parsed = parseUiaLine(line);
        if (!parsed) continue;
        if (!isChatApp(parsed.app)) continue;
        if (!looksLikePrompt(parsed.text)) continue;
        this.opts.onPrompt(parsed);
      }
    });

    this.proc.stderr.on("data", (chunk: Buffer) => {
      this.lastError = chunk.toString("utf8").slice(0, 300);
    });

    this.proc.on("exit", () => {
      this.proc = null;
      this.opts.onStatus?.(false, this.lastError || undefined);
    });

    this.opts.onStatus?.(true);
    return true;
  }

  stop(): void {
    if (!this.proc) return;
    this.proc.kill();
    this.proc = null;
  }
}
