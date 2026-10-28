import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SERVER = join(import.meta.dir, "..", "dist", "index.js");

interface Rpc {
  jsonrpc: string;
  id?: number;
  method?: string;
  result?: any;
  error?: { message: string };
}

function makeClient(env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "code-coach-e2e-"));
  const proc = spawn("node", [SERVER], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, CODE_COACH_DATA_DIR: dir, ...env },
  });

  let buffer = "";
  let nextId = 0;
  const pending = new Map<number, (msg: Rpc) => void>();

  proc.stdout.on("data", (data: Buffer) => {
    buffer += data.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      try {
        const msg = JSON.parse(t) as Rpc;
        if (typeof msg.id === "number" && pending.has(msg.id)) {
          const cb = pending.get(msg.id)!;
          pending.delete(msg.id);
          cb(msg);
        }
      } catch {
        // ignore
      }
    }
  });

  function request(method: string, params: unknown): Promise<Rpc> {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, resolve);
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`timeout: ${method}`));
        }
      }, 60000);
    });
  }

  function notify(method: string, params: unknown) {
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  async function init() {
    await request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "e2e", version: "1.0" },
    });
    notify("notifications/initialized", {});
  }

  async function callTool(name: string, args: Record<string, unknown>) {
    const res = await request("tools/call", { name, arguments: args });
    if (res.error) throw new Error(res.error.message);
    const text = res.result?.content?.[0]?.text;
    return JSON.parse(text);
  }

  function close() {
    proc.kill();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }

  return { init, callTool, close };
}

describe("MCP end-to-end (mock model)", () => {
  test(
    "initializes, exposes tools, coaches a prompt, and updates the profile",
    async () => {
      const c = makeClient({ CODE_COACH_MOCK: "1" });
      try {
        await c.init();

        const project = await c.callTool("project", {});
        expect(typeof project.summary).toBe("string");

        const result = await c.callTool("coach", {
          prompt: "Add a login endpoint that checks the user's password against the database",
          diff: "app.post('/login', (req, res) => { if (req.body.password === user.password) res.send('ok'); })",
          source: "e2e",
        });

        expect(result.interrupt).toBe(true);
        expect(result.source).toBe("e2e");
        expect(typeof result.uncertain).toBe("boolean");
        expect(typeof result.nudge).toBe("string");
        expect(result.nudge.length).toBeGreaterThan(0);
        expect(typeof result.explanation).toBe("string");
        expect(typeof result.better_prompt).toBe("string");
        expect(Array.isArray(result.concept_tags)).toBe(true);
        expect(result.concept_tags.length).toBeGreaterThan(0);
        expect(result.profile).toBeDefined();
        expect(Object.keys(result.profile.counts).length).toBeGreaterThan(0);

        const snap = await c.callTool("profile", {});
        expect(Object.keys(snap.counts).length).toBeGreaterThan(0);
      } finally {
        c.close();
      }
    },
    60000
  );

  test(
    "stays silent on a benign prompt",
    async () => {
      const c = makeClient({ CODE_COACH_MOCK: "1" });
      try {
        await c.init();
        const result = await c.callTool("coach", {
          prompt: "Refactor the parser to use a switch statement",
          diff: "function parse(input) { switch (input.type) { case 'a': return 1; default: return 0; } }",
          source: "e2e",
        });
        expect(result.interrupt).toBe(false);
      } finally {
        c.close();
      }
    },
    60000
  );

  test(
    "reset-profile clears the learner profile",
    async () => {
      const c = makeClient({ CODE_COACH_MOCK: "1" });
      try {
        await c.init();
        await c.callTool("coach", {
          prompt: "Add a login endpoint with a password",
          diff: "if (req.body.password === user.password) res.send('ok');",
          source: "e2e",
        });
        const before = await c.callTool("profile", {});
        expect(Object.keys(before.counts).length).toBeGreaterThan(0);

        await c.callTool("reset-profile", {});
        const after = await c.callTool("profile", {});
        expect(Object.keys(after.counts).length).toBe(0);
      } finally {
        c.close();
      }
    },
    60000
  );
});

describe("MCP end-to-end (live model, optional)", () => {
  test(
    "live coach returns a real nudge",
    async () => {
      if (process.env.CODE_COACH_SKIP_LIVE === "1") {
        console.warn("skipping live test: CODE_COACH_SKIP_LIVE=1");
        return;
      }
      const c = makeClient();
      try {
        await c.init();
        const result = await c.callTool("coach", {
          prompt: "Add a login endpoint that checks the user's password against the database",
          diff: "app.post('/login', (req, res) => { if (req.body.password === user.password) res.send('ok'); })",
          source: "e2e-live",
        });
        if (result.error) {
          console.warn("skipping live test:", String(result.error).slice(0, 160));
          return;
        }
        expect(result.interrupt).toBe(true);
        expect(typeof result.nudge).toBe("string");
        expect(result.nudge.length).toBeGreaterThan(0);
      } finally {
        c.close();
      }
    },
    120000
  );
});
