// model.ts — thin OpenRouter client. Triage uses a cheap model; coach uses a stronger one.
// Provider is configurable via env: OPENROUTER_API_KEY (required), with optional
// CODE_COACH_TRIAGE_MODEL / CODE_COACH_COACH_MODEL overrides.

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export async function chat(
  model: string,
  messages: ChatMessage[],
  opts: { maxTokens?: number; temperature?: number } = {}
): Promise<string> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY is not set");

  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://github.com/anomalyco/opencode",
      "X-Title": "Code Coach",
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: opts.maxTokens ?? 512,
      temperature: opts.temperature ?? 0.2,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenRouter ${res.status}: ${text}`);
  }
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("No content in model response");
  return content;
}

export const TRIAGE_MODEL = process.env.CODE_COACH_TRIAGE_MODEL ?? "anthropic/claude-haiku-4.5";
export const COACH_MODEL = process.env.CODE_COACH_COACH_MODEL ?? "anthropic/claude-sonnet-4.5";
