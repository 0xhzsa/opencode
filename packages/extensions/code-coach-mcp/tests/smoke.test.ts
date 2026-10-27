import { describe, expect, test } from "bun:test";
import { triage } from "../src/triage";
import { coach } from "../src/coach";
import { Profile } from "../src/profile";
import { homedir } from "node:os";
import { join } from "node:path";

describe("code-coach-mcp smoke test", () => {
  test("triage returns interrupt:false for benign prompt", async () => {
    const t = await triage("summarize the current state of the parser", "function parse(input) { return input.trim(); }");
    expect(t.interrupt).toBe(false);
  }, 30000);

  test("coach returns full schema for password prompt", async () => {
    const prompt = "Add a login endpoint that checks the user's password against the database";
    const diff = "app.post('/login', (req, res) => { if (req.body.password === user.password) res.send('ok'); })";
    const profile = new Profile(Profile.pathOf(join(homedir(), ".code-coach-test-smoke")));
    const t = await triage(prompt, diff);
    expect(t.interrupt).toBe(true);
    const c = await coach(prompt, diff, profile, t.reason);
    expect(c.interrupt).toBe(true);
    expect(typeof c.nudge).toBe("string");
    expect(c.nudge.length).toBeGreaterThan(0);
    expect(typeof c.explanation).toBe("string");
    expect(typeof c.better_prompt).toBe("string");
    expect(Array.isArray(c.concept_tags)).toBe(true);
    expect(c.concept_tags.length).toBeGreaterThan(0);
    // profile updated
    const snap = profile.snapshot();
    expect(Object.keys(snap.counts).length).toBeGreaterThan(0);
  }, 60000);
});
