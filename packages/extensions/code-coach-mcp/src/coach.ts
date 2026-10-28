// coach.ts — full coach step. Produces the nudge, explanation, better_prompt,
// concept_tags, and quiz. Only called when triage says interrupt.

import { chat, COACH_MODEL } from "./model.js";
import { Profile } from "./profile.js";
import { detectProject, type ProjectContext } from "./project.js";

export type CoachResponse = {
  interrupt: true;
  uncertain: boolean;
  severity: "info" | "warn" | "critical";
  nudge: string;
  explanation: string;
  better_prompt: string;
  concept_tags: string[];
  quiz: string | null;
};

const COACH_SYSTEM = `You are Code Coach, a senior engineer sitting beside a developer who is using an AI coding agent. You observe; you never write the solution.

YOU RECEIVE:
- The developer's latest prompt
- The diff the agent produced
- Project summary (stack, conventions, key files)
- Learner profile (concept counts, mastered concepts)

YOUR JOB:
1. Pick the SINGLE most important issue (max 2). Never list 10.
2. Explain at the right depth using the learner profile. Depth is per-concept:
   look up the issue's concept tags in CONCEPT COUNTS.
   - 0-1 hits: beginner — analogy first, then the concept, then the fix
   - 2 hits: intermediate — the principle and the tradeoff
   - 3+ hits: advanced — one line, the failure mode only
3. Teach the first principle underneath the bug, not just the patch.
4. Suggest a better prompt they could have written.
5. Occasionally (when the profile shows a gap) end with a short question that
   makes them predict behavior.

RULES:
- Tone: the senior dev who never makes you feel dumb. No lecturing.
- Max 60 words for the nudge. Longer only in explanation.
- Never repeat a lesson the profile says they've mastered; mention it in one
  line instead ("you've seen this three times — the failure mode is X").
- Be honest about uncertainty. If you are not sure, set "uncertain": true and
  say what would confirm it. Do not invent vulnerabilities.
- No false positives. A styling change is not a security issue.

OUTPUT (JSON only, no prose):
{
  "interrupt": true,
  "uncertain": false,
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
  triageReason?: string,
  project?: ProjectContext,
  extra: { context?: string; source?: string } = {}
): Promise<CoachResponse> {
  const snap = profile.snapshot();
  const proj = project ?? detectProject();

  const user = `SOURCE: ${extra.source ?? "unknown"}
CONCEPT COUNTS: ${JSON.stringify(snap.counts)}
MASTERED (do not re-teach): ${snap.mastered.join(", ") || "(none)"}
TRIAGE REASON: ${triageReason ?? "(none)"}
PROJECT CONTEXT:
${proj.summary}

PROMPT:
${prompt}

DIFF:
${diff || "(none)"}

CONTEXT:
${extra.context || "(none)"}`;

  const raw = await chat(
    COACH_MODEL,
    [
      { role: "system", content: COACH_SYSTEM },
      { role: "user", content: user },
    ],
    { maxTokens: 400, temperature: 0.3 }
  );

  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("No JSON in coach response");
  const parsed = safeParse(match[0]);

  const nudge = String(parsed.nudge ?? "").trim();
  if (!nudge) throw new Error("coach returned an empty nudge");

  const tags: string[] = Array.isArray(parsed.concept_tags) ? parsed.concept_tags : [];
  profile.record(nudge, tags);

  return {
    interrupt: true,
    uncertain: Boolean(parsed.uncertain),
    severity: parsed.severity ?? "warn",
    nudge,
    explanation: parsed.explanation ?? "",
    better_prompt: parsed.better_prompt ?? "",
    concept_tags: tags,
    quiz: parsed.quiz ?? null,
  };
}

// The model sometimes truncates its JSON when max_tokens is tight. Parse the
// happy path first, then repair the common truncations (missing closing brace,
// trailing comma, unterminated string) before giving up.
function safeParse(text: string): Record<string, any> {
  try {
    return JSON.parse(text);
  } catch {
    // try closing a truncated object
  }
  let t = text.trim();
  if (t.startsWith("{") && !t.endsWith("}")) {
    // close any open string
    const quotes = (t.match(/(?<!\\)"/g) ?? []).length;
    if (quotes % 2 === 1) t += '"';
    t = t.replace(/,\s*$/, "") + "}";
    try {
      return JSON.parse(t);
    } catch {
      // fall through
    }
  }
  // last resort: pull the fields we know with regex
  const grab = (key: string) => {
    const m = text.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
    return m ? m[1].replace(/\\"/g, '"').replace(/\\n/g, "\n") : undefined;
  };
  const tagsMatch = text.match(/"concept_tags"\s*:\s*\[([\s\S]*?)\]/);
  const tags = tagsMatch
    ? Array.from(tagsMatch[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)).map((m) => m[1])
    : [];
  const severity = text.match(/"severity"\s*:\s*"(info|warn|critical)"/)?.[1] as
    | "info"
    | "warn"
    | "critical"
    | undefined;
  return {
    severity: severity ?? "warn",
    nudge: grab("nudge") ?? "",
    explanation: grab("explanation") ?? "",
    better_prompt: grab("better_prompt") ?? "",
    concept_tags: tags,
    quiz: grab("quiz") ?? null,
    uncertain: /"uncertain"\s*:\s*true/.test(text),
  };
}
