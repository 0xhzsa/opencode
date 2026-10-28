#!/usr/bin/env node
// scripts/demo.mjs — run the MCP server and show three coach responses.
//
// By default it uses the deterministic mock model so it costs nothing and
// works offline. Set CODE_COACH_MOCK=0 and OPENROUTER_API_KEY to see live
// model output instead.
//
//   node scripts/demo.mjs
//   CODE_COACH_MOCK=0 node scripts/demo.mjs

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SERVER = join(import.meta.dirname, "..", "dist", "index.js");
const dir = mkdtempSync(join(tmpdir(), "code-coach-demo-"));

const proc = spawn("node", [SERVER], {
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    CODE_COACH_DATA_DIR: dir,
    CODE_COACH_MOCK: process.env.CODE_COACH_MOCK ?? "1",
  },
});

let buffer = "";
let nextId = 0;
const pending = new Map();

proc.stdout.on("data", (data) => {
  buffer += data.toString();
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    try {
      const msg = JSON.parse(t);
      if (typeof msg.id === "number" && pending.has(msg.id)) {
        const cb = pending.get(msg.id);
        pending.delete(msg.id);
        cb(msg);
      }
    } catch {
      // ignore
    }
  }
});

function request(method, params) {
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

async function callTool(name, args) {
  const res = await request("tools/call", { name, arguments: args });
  if (res.error) throw new Error(res.error.message);
  return JSON.parse(res.result.content[0].text);
}

await request("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "demo", version: "1.0" },
});
proc.stdin.write(
  JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n"
);

const examples = [
  {
    title: "Example 1: plaintext password comparison",
    prompt: "Add a login endpoint that checks the user's password against the database",
    diff: "app.post('/login', (req, res) => { if (req.body.password === user.password) res.send('ok'); })",
  },
  {
    title: "Example 2: SQL built from request input",
    prompt: "Add a search endpoint that finds users by name",
    diff: "app.get('/search', (req, res) => { const q = `SELECT * FROM users WHERE name = '${req.query.name}'`; db.query(q); })",
  },
  {
    title: "Example 3: benign refactor (should be silent)",
    prompt: "Refactor the parser to use a switch statement",
    diff: "function parse(input) { switch (input.type) { case 'a': return 1; default: return 0; } }",
  },
];

for (const ex of examples) {
  console.log("\n" + "=".repeat(72));
  console.log(ex.title);
  console.log("=".repeat(72));
  console.log("prompt:", ex.prompt);
  console.log("diff:  ", ex.diff);
  console.log("-".repeat(72));
  const r = await callTool("coach", { prompt: ex.prompt, diff: ex.diff, source: "demo" });
  console.log(JSON.stringify(r, null, 2));
}

console.log("\n" + "=".repeat(72));
console.log("learner profile after the three examples");
console.log("=".repeat(72));
console.log(JSON.stringify(await callTool("profile", {}), null, 2));

proc.kill();
rmSync(dir, { recursive: true, force: true });
