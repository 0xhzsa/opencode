#!/usr/bin/env node
// index.ts — Code Coach MCP server (stdio transport).

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { triage } from "./triage.js";
import { coach } from "./coach.js";
import { Profile } from "./profile.js";
import { detectProject } from "./project.js";
import { homedir } from "node:os";
import { join } from "node:path";

const profile = new Profile(Profile.pathOf(join(homedir(), ".code-coach")));

const server = new Server(
  { name: "code-coach", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "coach",
      description:
        "Code Coach: observe a developer's prompt and the diff it produced, and return a nudge (or silence). Trains on first principles; learns from the learner profile.",
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "The developer's prompt to the coding agent" },
          diff: { type: "string", description: "The diff or code the agent produced (optional)" },
        },
        required: ["prompt"],
      },
    },
    {
      name: "profile",
      description: "Return the current learner profile (counts + mastered concepts).",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "project",
      description: "Return the detected project context (stack, conventions, key files).",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === "coach") {
    const args = (req.params.arguments ?? {}) as { prompt?: string; diff?: string };
    const prompt = String(args.prompt ?? "");
    const diff = String(args.diff ?? "");

    const t = await triage(prompt, diff);
    if (!t.interrupt) {
      return {
        content: [{ type: "text", text: JSON.stringify({ interrupt: false, reason: t.reason }) }],
      };
    }

    const result = await coach(prompt, diff, profile, t.reason, detectProject());
    const snap = profile.snapshot();
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ ...result, profile: { counts: snap.counts, mastered: snap.mastered } }),
        },
      ],
    };
  }

  if (req.params.name === "profile") {
    const snap = profile.snapshot();
    return {
      content: [{ type: "text", text: JSON.stringify(snap) }],
    };
  }

  if (req.params.name === "project") {
    const ctx = detectProject();
    return {
      content: [{ type: "text", text: JSON.stringify(ctx) }],
    };
  }

  throw new Error(`Unknown tool: ${req.params.name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
