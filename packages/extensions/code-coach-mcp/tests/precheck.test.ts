import { describe, expect, test } from "bun:test";
import { preCheck } from "../src/precheck";
import { triage } from "../src/triage";

const SQL_CONCAT = `const q = "SELECT * FROM users WHERE name = '" + name + "'";\nreturn db.query(q);`;
const SQL_TEMPLATE = "const q = `SELECT * FROM users WHERE name = '${name}'`;";
const PASSWORD_EQ =
  "app.post('/login', (req, res) => { if (req.body.password === user.password) res.send('ok'); })";

describe("preCheck", () => {
  test("escalates concatenated SQL", () => {
    const hit = preCheck(SQL_CONCAT);
    expect(hit?.interrupt).toBe(true);
    expect(hit?.severity).toBe("critical");
  });

  test("escalates interpolated SQL", () => {
    expect(preCheck(SQL_TEMPLATE)?.interrupt).toBe(true);
  });

  test("escalates a direct password comparison", () => {
    const hit = preCheck(PASSWORD_EQ);
    expect(hit?.interrupt).toBe(true);
    expect(hit?.category).toBe("security");
  });

  test("escalates a committed credential literal", () => {
    expect(preCheck('const key = "sk-or-v1-abcdefghijklmnopqrstuvwxyz";')?.interrupt).toBe(true);
    expect(preCheck("-----BEGIN RSA PRIVATE KEY-----")?.interrupt).toBe(true);
  });

  test("escalates eval and non-literal innerHTML", () => {
    expect(preCheck("eval(req.body.code)")?.interrupt).toBe(true);
    expect(preCheck("el.innerHTML = comment.body")?.interrupt).toBe(true);
  });

  test("stays quiet on a confirmation field", () => {
    expect(preCheck("if (password === confirmPassword) submit();")).toBeNull();
  });

  test("stays quiet on literal HTML and benign code", () => {
    expect(preCheck('el.innerHTML = "<b>hello</b>";')).toBeNull();
    expect(preCheck("const total = items.reduce((a, b) => a + b, 0);")).toBeNull();
  });

  test("stays quiet on an empty diff", () => {
    expect(preCheck("")).toBeNull();
  });
});

describe("triage safety net", () => {
  test("escalates SQL injection with no model and no key", async () => {
    const mock = process.env.CODE_COACH_MOCK;
    const key = process.env.OPENROUTER_API_KEY;
    delete process.env.CODE_COACH_MOCK;
    delete process.env.OPENROUTER_API_KEY;
    try {
      const result = await triage("Find a user by name", SQL_CONCAT);
      expect(result.interrupt).toBe(true);
      expect(result.reason).toContain("Pre-check");
    } finally {
      if (mock !== undefined) process.env.CODE_COACH_MOCK = mock;
      if (key !== undefined) process.env.OPENROUTER_API_KEY = key;
    }
  });
});
