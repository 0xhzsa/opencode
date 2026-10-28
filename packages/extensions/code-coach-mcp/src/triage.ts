// triage.ts — cheap triage step. Asks a small model whether there's a real
// issue worth interrupting for. Returns { interrupt, severity, category }.

import { chat, TRIAGE_MODEL } from "./model.js";
import { preCheck } from "./precheck.js";

export type TriageResult = {
  interrupt: boolean;
  uncertain?: boolean;
  severity?: "info" | "warn" | "critical";
  category?: "security" | "scalability" | "correctness" | "maintainability" | "prompt-quality";
  reason?: string;
};

const TRIAGE_SYSTEM = `You are Code Coach's triage step. You receive a developer's prompt to an AI coding agent, the diff it produced (if any), and optional terminal output. Decide if there is a real issue worth interrupting for.

The source tells you where the observation came from. A prompt-only observation (browser, uia, clipboard) has no diff yet: judge the prompt itself, because the prompt is what shapes the code.

Categories: security, scalability, correctness, maintainability, prompt-quality.
If nothing is worth interrupting for, return {"interrupt": false}. Silence is the default.

Real issues include: SQL built from input, a password compared or stored in plaintext, a secret committed in the diff, HTML rendered from user input, a query that reads every row and filters in application code, and a request boundary with no validation. These are examples, not a checklist.

Be honest about uncertainty. Don't invent vulnerabilities. Only flag real issues. If something looks suspicious but you are not sure, set "uncertain": true and explain what would confirm it; do not escalate a guess to a critical.

Return ONLY valid JSON, no prose. Do not explain your reasoning; the first character of your reply must be {.
{"interrupt": bool, "uncertain": bool, "severity": "info"|"warn"|"critical", "category": "...", "reason": "..."}`;

export async function triage(
  prompt: string,
  diff: string,
  extra: { context?: string; source?: string } = {}
): Promise<TriageResult> {
  // Deterministic safety net: a cheap model that reasons instead of answering,
  // or one that is rate-limited, must not turn a textbook vulnerability into
  // silence. This can only escalate.
  const pre = preCheck(diff);
  if (pre) return pre;

  const user = `SOURCE: ${extra.source ?? "unknown"}

PROMPT:
${prompt}

DIFF:
${diff || "(none)"}

CONTEXT:
${extra.context || "(none)"}`;
  const raw = await chat(TRIAGE_MODEL, [
    { role: "system", content: TRIAGE_SYSTEM },
    { role: "user", content: user },
  ], { maxTokens: 400, temperature: 0.1 });

  // Extract JSON from the response (model may wrap in code fences).
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) {
    // A model that reasoned instead of answering has NOT said "nothing to
    // report". Mark it uncertain so the caller can tell the difference.
    return { interrupt: false, uncertain: true, reason: "triage model returned no JSON" };
  }
  try {
    const parsed = JSON.parse(match[0]);
    const severity = ["info", "warn", "critical"].includes(parsed.severity)
      ? (parsed.severity as TriageResult["severity"])
      : undefined;
    const category = [
      "security",
      "scalability",
      "correctness",
      "maintainability",
      "prompt-quality",
    ].includes(parsed.category)
      ? (parsed.category as TriageResult["category"])
      : undefined;
    return {
      interrupt: Boolean(parsed.interrupt),
      uncertain: Boolean(parsed.uncertain),
      severity,
      category,
      reason: parsed.reason,
    };
  } catch {
    // Truncated JSON is common when max_tokens is tight. Pull the fields we
    // need with regex so a cut-off response does not silently read as "no".
    const interrupt = /"interrupt"\s*:\s*true/.test(raw);
    const uncertain = /"uncertain"\s*:\s*true/.test(raw);
    const severity = raw.match(/"severity"\s*:\s*"(info|warn|critical)"/)?.[1] as
      | "info"
      | "warn"
      | "critical"
      | undefined;
    const category = raw.match(
      /"category"\s*:\s*"(security|scalability|correctness|maintainability|prompt-quality)"/
    )?.[1] as TriageResult["category"];
    const reason = raw.match(/"reason"\s*:\s*"((?:[^"\\]|\\.)*)"/)?.[1];
    if (!interrupt) {
      return { interrupt: false, uncertain: true, reason: "invalid JSON in triage response" };
    }
    return { interrupt, uncertain, severity, category, reason };
  }
}
