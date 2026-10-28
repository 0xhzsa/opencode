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

const dataDir = process.env.CODE_COACH_DATA_DIR?.trim() || join(homedir(), ".code-coach");
const profile = new Profile(Profile.pathOf(dataDir));

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
          context: {
            type: "string",
            description: "Extra context such as terminal or test output (optional)",
          },
          source: {
            type: "string",
            description:
              "Where the observation came from: save, terminal, clipboard, browser:host, uia:app, command",
          },
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
    {
      name: "reset-profile",
      description: "Clear the learner profile. The coach starts from scratch.",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = (req.params.arguments ?? {}) as {
    prompt?: string;
    diff?: string;
    context?: string;
    source?: string;
  };

  if (req.params.name === "coach") {
    const prompt = String(args.prompt ?? "");
    const diff = String(args.diff ?? "");
    const context = String(args.context ?? "");
    const source = String(args.source ?? "unknown");

    let t;
    try {
      t = await triage(prompt, diff, { context, source });
    } catch (e) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              interrupt: false,
              error: e instanceof Error ? e.message : String(e),
            }),
          },
        ],
      };
    }

    if (!t.interrupt) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ interrupt: false, uncertain: t.uncertain ?? false, reason: t.reason }),
          },
        ],
      };
    }

    let result;
    try {
      result = await coach(prompt, diff, profile, t.reason, detectProject(), { context, source });
    } catch (e) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              interrupt: false,
              error: e instanceof Error ? e.message : String(e),
            }),
          },
        ],
      };
    }
    const snap = profile.snapshot();
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ...result,
            source,
            profile: { counts: snap.counts, mastered: snap.mastered },
          }),
        },
      ],
    };
  }

  if (req.params.name === "profile") {
    return {
      content: [{ type: "text", text: JSON.stringify(profile.snapshot()) }],
    };
  }

  if (req.params.name === "project") {
    return {
      content: [{ type: "text", text: JSON.stringify(detectProject()) }],
    };
  }

  if (req.params.name === "reset-profile") {
    profile.reset();
    return {
      content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
    };
  }

  throw new Error(`Unknown tool: ${req.params.name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
