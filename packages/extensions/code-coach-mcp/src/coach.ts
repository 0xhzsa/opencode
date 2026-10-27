// coach.ts — full coach step. Produces the nudge, explanation, better_prompt,
// concept_tags, and quiz. Only called when triage says interrupt.

import { chat, COACH_MODEL } from "./model.js";
import { Profile } from "./profile.js";

export type CoachResponse = {
  interrupt: true;
  severity: "info" | "warn" | "critical";
  nudge: string;
  explanation: string;
  better_prompt: string;
  concept_tags: string[];
  quiz: string | null;
};

const COACH_SYSTEM = `You are Code Coach, a senior engineer sitting beside a developer who is using an AI coding agent. You observe; you never write the solution.

RULES:
- Tone: the senior dev who never makes you feel dumb. No lecturing.
- Max 60 words for the nudge. Longer only in explanation.
- Teach the first principle underneath the bug, not just the patch.
- Suggest a better prompt they could have written.
- Be honest about uncertainty. Don't invent vulnerabilities.
- Never repeat a lesson the profile says they've mastered.

OUTPUT (JSON only, no prose):
{
  "interrupt": true,
  "severity": "info" | "warn" | "critical",
  "nudge": "...",
  "explanation": "...",
  "better_prompt": "...",
  "concept_tags": ["..."],
  "quiz": "..." | null
}`;

export async function coach(
  prompt: string,
  diff: string,
  profile: Profile,
  triageReason?: string
): Promise<CoachResponse> {
  const snap = profile.snapshot();
  const depth = snap.mastered.length > 0 ? "advanced" : snap.counts && Object.keys(snap.counts).length > 0 ? "intermediate" : "beginner";

  const user = `DEPTH: ${depth}
MASTERED (do not re-teach): ${snap.mastered.join(", ") || "(none)"}
CONCEPT COUNTS: ${JSON.stringify(snap.counts)}
TRIAGE REASON: ${triageReason ?? "(none)"}

PROMPT:
${prompt}

DIFF:
${diff || "(none)"}`;

  const raw = await chat(COACH_MODEL, [
    { role: "system", content: COACH_SYSTEM },
    { role: "user", content: user },
  ], { maxTokens: 1024, temperature: 0.3 });

  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("No JSON in coach response");
  const parsed = JSON.parse(match[0]);

  const tags: string[] = Array.isArray(parsed.concept_tags) ? parsed.concept_tags : [];
  // Record the interaction in the profile.
  profile.record(parsed.nudge ?? "", tags);

  return {
    interrupt: true,
    severity: parsed.severity ?? "warn",
    nudge: parsed.nudge ?? "",
    explanation: parsed.explanation ?? "",
    better_prompt: parsed.better_prompt ?? "",
    concept_tags: tags,
    quiz: parsed.quiz ?? null,
  };
}
