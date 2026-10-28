import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Deterministic mock mode: no network, no credits.
process.env.CODE_COACH_MOCK = "1";

const { triage } = await import("../src/triage");
const { coach } = await import("../src/coach");
const { Profile } = await import("../src/profile");

function tempProfile() {
  const dir = mkdtempSync(join(tmpdir(), "code-coach-smoke-"));
  return {
    profile: new Profile(Profile.pathOf(dir)),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function creditError(e: unknown): boolean {
  const s = e instanceof Error ? e.message : String(e);
  return s.includes("402") || s.includes("429") || s.includes("in_flight_budget");
}

describe("pipeline (mock model)", () => {
  test("triage is silent on a benign prompt", async () => {
    const t = await triage(
      "summarize the current state of the parser",
      "function parse(input) { return input.trim(); }"
    );
    expect(t.interrupt).toBe(false);
  });

  test("triage interrupts on a password prompt", async () => {
    const t = await triage(
      "Add a login endpoint that checks the user's password against the database",
      "app.post('/login', (req, res) => { if (req.body.password === user.password) res.send('ok'); })"
    );
    expect(t.interrupt).toBe(true);
    expect(t.severity).toBe("critical");
  });

  test("coach returns the full schema", async () => {
    const { profile, cleanup } = tempProfile();
    try {
      const c = await coach(
        "Add a login endpoint that checks the user's password against the database",
        "app.post('/login', (req, res) => { if (req.body.password === user.password) res.send('ok'); })",
        profile,
        "plaintext password"
      );
      expect(c.interrupt).toBe(true);
      expect(c.nudge.length).toBeGreaterThan(0);
      expect(c.explanation.length).toBeGreaterThan(0);
      expect(c.better_prompt.length).toBeGreaterThan(0);
      expect(c.concept_tags.length).toBeGreaterThan(0);
      expect(c.quiz).not.toBeNull();
      expect(profile.snapshot().counts["password-hashing"]).toBe(1);
    } finally {
      cleanup();
    }
  });
});

describe("profile", () => {
  test("accumulates counts and masters at 3", () => {
    const { profile, cleanup } = tempProfile();
    try {
      profile.record("password", ["password-hashing"]);
      profile.record("password", ["password-hashing"]);
      expect(profile.snapshot().mastered).not.toContain("password-hashing");
      profile.record("password", ["password-hashing"]);
      expect(profile.snapshot().mastered).toContain("password-hashing");
      expect(profile.snapshot().counts["password-hashing"]).toBe(3);
    } finally {
      cleanup();
    }
  });

  test("reset clears counts", () => {
    const { profile, cleanup } = tempProfile();
    try {
      profile.record("x", ["sql-injection"]);
      expect(profile.snapshot().counts["sql-injection"]).toBe(1);
      profile.reset();
      expect(profile.snapshot().counts["sql-injection"]).toBeUndefined();
    } finally {
      cleanup();
    }
  });
});

describe("live model (optional)", () => {
  test(
    "live triage + coach on a password prompt",
    async () => {
      if (process.env.CODE_COACH_SKIP_LIVE === "1") {
        console.warn("skipping live test: CODE_COACH_SKIP_LIVE=1");
        return;
      }
      delete process.env.CODE_COACH_MOCK;
      const { profile, cleanup } = tempProfile();
      try {
        const prompt = "Add a login endpoint that checks the user's password against the database";
        const diff =
          "app.post('/login', (req, res) => { if (req.body.password === user.password) res.send('ok'); })";
        let t;
        try {
          t = await triage(prompt, diff);
        } catch (e) {
          if (creditError(e)) {
            console.warn("skipping live test: OpenRouter credits/rate limit");
            return;
          }
          throw e;
        }
        expect(t.interrupt).toBe(true);
        let c;
        try {
          c = await coach(prompt, diff, profile, t.reason);
        } catch (e) {
          if (creditError(e)) {
            console.warn("skipping live coach: OpenRouter credits/rate limit");
            return;
          }
          throw e;
        }
        expect(c.nudge.length).toBeGreaterThan(0);
        expect(c.concept_tags.length).toBeGreaterThan(0);
      } finally {
        process.env.CODE_COACH_MOCK = "1";
        cleanup();
      }
    },
    120000
  );
});
