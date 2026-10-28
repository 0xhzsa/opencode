import { describe, expect, test } from "bun:test";
import { computeDiff } from "../src/diff";

describe("computeDiff", () => {
  test("returns empty for identical text", () => {
    expect(computeDiff("a\nb\nc", "a\nb\nc")).toBe("");
  });

  test("shows added lines with +", () => {
    const d = computeDiff("a\nb", "a\nb\nc");
    expect(d).toContain("+c");
    expect(d).not.toContain("-a");
  });

  test("shows removed lines with -", () => {
    const d = computeDiff("a\nb\nc", "a\nc");
    expect(d).toContain("-b");
  });

  test("shows changed lines as -old +new", () => {
    const d = computeDiff("const x = 1;", "const x = 2;");
    expect(d).toContain("-const x = 1;");
    expect(d).toContain("+const x = 2;");
  });

  test("includes context lines around a change", () => {
    const before = ["line1", "line2", "line3", "line4", "line5"].join("\n");
    const after = ["line1", "line2", "CHANGED", "line4", "line5"].join("\n");
    const d = computeDiff(before, after);
    expect(d).toContain(" line2");
    expect(d).toContain(" line4");
    expect(d).toContain("-line3");
    expect(d).toContain("+CHANGED");
  });

  test("caps the output at maxLines", () => {
    const before = Array.from({ length: 500 }, (_, i) => `old ${i}`).join("\n");
    const after = Array.from({ length: 500 }, (_, i) => `new ${i}`).join("\n");
    const d = computeDiff(before, after, 50);
    expect(d.split("\n").length).toBeLessThanOrEqual(51);
    expect(d).toContain("truncated");
  });

  test("detects a SQL injection line added in a diff", () => {
    const before = "app.get('/users', (req, res) => {\n  res.json([]);\n});";
    const after =
      "app.get('/users', (req, res) => {\n  const q = `SELECT * FROM users WHERE name = '${req.query.name}'`;\n  db.query(q);\n});";
    const d = computeDiff(before, after);
    expect(d).toContain("+  const q =");
    expect(d).toContain("db.query");
  });
});
