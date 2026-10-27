// triage.ts — cheap triage step. Asks a small model whether there's a real
// issue worth interrupting for. Returns { interrupt, severity, category }.

import { chat, TRIAGE_MODEL } from "./model.js";

export type TriageResult = {
  interrupt: boolean;
  severity?: "info" | "warn" | "critical";
  category?: "security" | "scalability" | "correctness" | "maintainability" | "prompt-quality";
  reason?: string;
};

const TRIAGE_SYSTEM = `You are Code Coach's triage step. You receive a developer's prompt to an AI coding agent and the diff it produced. Decide if there is a real issue worth interrupting for.

Categories: security, scalability, correctness, maintainability, prompt-quality.
If nothing is worth interrupting for, return {"interrupt": false}. Silence is the default.

Be honest about uncertainty. Don't invent vulnerabilities. Only flag real issues.

Return ONLY valid JSON, no prose:
{"interrupt": bool, "severity": "info"|"warn"|"critical", "category": "...", "reason": "..."}`;

export async function triage(prompt: string, diff: string): Promise<TriageResult> {
  const user = `PROMPT:\n${prompt}\n\nDIFF:\n${diff || "(none)"}`;
  let raw: string;
  try {
    raw = await chat(TRIAGE_MODEL, [
      { role: "system", content: TRIAGE_SYSTEM },
      { role: "user", content: user },
    ], { maxTokens: 256, temperature: 0.1 });
  } catch (e) {
    return { interrupt: false, reason: `triage error: ${e instanceof Error ? e.message : String(e)}` };
  }

  // Extract JSON from the response (model may wrap in code fences).
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return { interrupt: false, reason: "no JSON in triage response" };
  try {
    const parsed = JSON.parse(match[0]);
    return {
      interrupt: Boolean(parsed.interrupt),
      severity: parsed.severity,
      category: parsed.category,
      reason: parsed.reason,
    };
  } catch {
    return { interrupt: false, reason: "invalid JSON in triage response" };
  }
}
