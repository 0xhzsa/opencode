/*
 * mcpClient.ts - minimal MCP client over stdio.
 *
 * Spawns the code-coach-mcp server and speaks JSON-RPC 2.0. Used by the
 * extension to get AI-powered coaching (triage + coach models, learner
 * profile, project context) instead of only the deterministic regex engine.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

interface RpcResponse {
  jsonrpc: string;
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

export class McpClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private requestId = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private buffer = "";

  constructor(private serverPath: string) {}

  async start(): Promise<void> {
    if (this.proc) return;
    if (!this.serverPath) throw new Error("MCP server path is not configured");

    this.proc = spawn("node", [this.serverPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    }) as ChildProcessWithoutNullStreams;

    this.proc.stdout.on("data", (data: Buffer) => {
      this.buffer += data.toString();
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = JSON.parse(trimmed) as RpcResponse;
          if (typeof msg.id === "number" && this.pending.has(msg.id)) {
            const p = this.pending.get(msg.id)!;
            this.pending.delete(msg.id);
            if (msg.error) p.reject(new Error(msg.error.message));
            else p.resolve(msg.result);
          }
        } catch {
          // ignore non-JSON output
        }
      }
    });

    this.proc.stderr.on("data", () => {
      // server logs go to stderr; ignore
    });

    this.proc.on("exit", () => {
      this.proc = null;
      for (const [, p] of this.pending) p.reject(new Error("MCP server exited"));
      this.pending.clear();
    });

    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "code-coach-vscode", version: "0.1.0" },
    });

    this.notify("notifications/initialized", {});
  }

  private request(method: string, params: unknown, timeoutMs = 45000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.proc?.stdin.writable) {
        reject(new Error("MCP server is not running"));
        return;
      }
      const id = ++this.requestId;
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");

      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error("MCP request timed out"));
        }
      }, timeoutMs);
    });
  }

  private notify(method: string, params: unknown): void {
    if (!this.proc?.stdin.writable) return;
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const result = (await this.request("tools/call", { name, arguments: args })) as {
      content?: { text?: string }[];
    };
    const text = result?.content?.[0]?.text;
    if (!text) return result;
    try {
      return JSON.parse(text);
    } catch {
      return { raw: text };
    }
  }

  stop(): void {
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
  }
}
