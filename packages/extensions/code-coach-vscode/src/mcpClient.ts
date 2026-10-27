import * as vscode from "vscode";
import { spawn, ChildProcess } from "node:child_process";
import { join } from "node:path";

interface McpResponse {
  jsonrpc: string;
  id: number;
  result?: any;
  error?: { code: number; message: string };
}

/**
 * MCP client that spawns the code-coach-mcp server and communicates
 * via JSON-RPC over stdio. This lets the VS Code extension use the
 * AI-powered coach (triage + coach models) instead of just regex.
 */
export class McpClient {
  private proc: ChildProcess | null = null;
  private requestId = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private buffer = "";

  constructor(private serverPath: string) {}

  async start(): Promise<void> {
    if (this.proc) return;
    this.proc = spawn("node", [this.serverPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    this.proc.stdout?.on("data", (data: Buffer) => {
      this.buffer += data.toString();
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = JSON.parse(trimmed) as McpResponse;
          if (msg.id !== undefined && this.pending.has(msg.id)) {
            const p = this.pending.get(msg.id)!;
            this.pending.delete(msg.id);
            if (msg.error) p.reject(new Error(msg.error.message));
            else p.resolve(msg.result);
          }
        } catch {
          // ignore non-JSON lines (stderr, etc.)
        }
      }
    });

    this.proc.stderr?.on("data", () => {
      // ignore stderr
    });

    // Initialize handshake
    await this.sendRequest("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "code-coach-vscode", version: "0.1.0" },
    });

    // Send initialized notification
    this.sendNotification("notifications/initialized", {});
  }

  private sendRequest(method: string, params: any): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.proc?.stdin) {
        reject(new Error("MCP server not running"));
        return;
      }
      const id = ++this.requestId;
      this.pending.set(id, { resolve, reject });
      const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
      this.proc.stdin.write(msg);

      // Timeout after 30s
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error("MCP request timeout"));
        }
      }, 30000);
    });
  }

  private sendNotification(method: string, params: any): void {
    if (!this.proc?.stdin) return;
    const msg = JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
    this.proc.stdin.write(msg);
  }

  async callTool(name: string, args: Record<string, any>): Promise<any> {
    const result = await this.sendRequest("tools/call", { name, arguments: args });
    const text = result?.content?.[0]?.text;
    if (text) {
      try {
        return JSON.parse(text);
      } catch {
        return { raw: text };
      }
    }
    return result;
  }

  async stop(): Promise<void> {
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
  }
}
