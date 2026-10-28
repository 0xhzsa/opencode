// model.ts — thin OpenRouter client. Triage uses a cheap model; coach uses a
// stronger one. Provider is configurable via env: OPENROUTER_API_KEY (required),
// with optional CODE_COACH_TRIAGE_MODEL / CODE_COACH_COACH_MODEL overrides.
//
// CODE_COACH_MOCK=1 returns deterministic canned responses. It exists so the
// full stdio pipeline can be tested without spending credits or depending on a
// network. It is never the default and never pretends to be a model.

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export async function chat(
  model: string,
  messages: ChatMessage[],
  opts: { maxTokens?: number; temperature?: number } = {}
): Promise<string> {
  if (process.env.CODE_COACH_MOCK === "1") {
    return mockResponse(messages);
  }

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

function mockResponse(messages: ChatMessage[]): string {
  const system = messages.find((m) => m.role === "system")?.content ?? "";
  const user = messages.find((m) => m.role === "user")?.content ?? "";

  if (/triage/i.test(system)) {
    const risky = /\b(password|sql|select|exec|eval|innerHTML|secret|token)\b/i.test(user);
    return JSON.stringify(
      risky
        ? {
            interrupt: true,
            uncertain: false,
            severity: "critical",
            category: "security",
            reason: "Mock: a risky pattern is present.",
          }
        : { interrupt: false, uncertain: false, reason: "Mock: nothing worth interrupting for." }
    );
  }

  const sql = /\b(select|insert|update|delete)\b/i.test(user) || /\bdb\.query\b/i.test(user);
  const password = /\b(password|bcrypt|argon2|hash)\b/i.test(user);

  if (sql) {
    return JSON.stringify({
      interrupt: true,
      uncertain: false,
      severity: "critical",
      nudge: "Mock nudge: the query is built from request input, so the input becomes SQL.",
      explanation:
        "Mock explanation: a query is code. String interpolation lets the input close your SQL and start its own. Parameterized queries send SQL and values separately.",
      better_prompt:
        "Mock better prompt: use a parameterized query (db.query('... WHERE name = $1', [name])) and validate the input with zod.",
      concept_tags: ["sql-injection", "parameterized-queries"],
      quiz: "Mock quiz: what does the input `' OR '1'='1` do to the current query?",
    });
  }

  if (password) {
    return JSON.stringify({
      interrupt: true,
      uncertain: false,
      severity: "warn",
      nudge: "Mock nudge: hash passwords and validate input at the boundary.",
      explanation:
        "Mock explanation: a hash is one-way. Store hash(password) with a per-user salt and compare in constant time.",
      better_prompt:
        "Mock better prompt: hash with bcrypt, compare in constant time, rate-limit per IP, and return generic errors.",
      concept_tags: ["password-hashing", "input-validation"],
      quiz: "Mock quiz: what happens if two users pick the same password?",
    });
  }

  return JSON.stringify({
    interrupt: true,
    uncertain: false,
    severity: "warn",
    nudge: "Mock nudge: validate the input at the boundary.",
    explanation: "Mock explanation: validate the shape once, then trust it downstream.",
    better_prompt: "Mock better prompt: validate with zod at the request boundary.",
    concept_tags: ["input-validation"],
    quiz: null,
  });
}

export const TRIAGE_MODEL = process.env.CODE_COACH_TRIAGE_MODEL ?? "anthropic/claude-haiku-4.5";
export const COACH_MODEL = process.env.CODE_COACH_COACH_MODEL ?? "anthropic/claude-sonnet-4.5";
