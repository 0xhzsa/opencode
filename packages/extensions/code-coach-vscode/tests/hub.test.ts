import { describe, expect, test } from "bun:test";
import { ObserverHub, type Observation } from "../src/observe/hub";

function collect(): { hub: ObserverHub; got: Observation[] } {
  const got: Observation[] = [];
  const hub = new ObserverHub((o) => got.push(o), { dedupeMs: 1000, minChars: 8, maxChars: 100 });
  return { hub, got };
}

describe("ObserverHub", () => {
  test("emits a valid observation", () => {
    const { hub, got } = collect();
    const ok = hub.push({
      prompt: "Add a login endpoint",
      diff: "",
      source: "browser",
      app: "claude.ai",
    });
    expect(ok).toBe(true);
    expect(got.length).toBe(1);
    expect(got[0].prompt).toBe("Add a login endpoint");
    expect(got[0].source).toBe("browser");
    expect(typeof got[0].ts).toBe("number");
  });

  test("dedupes the same prompt from the same source", () => {
    const { hub, got } = collect();
    const input = { prompt: "Add a login endpoint", diff: "", source: "clipboard" };
    expect(hub.push(input)).toBe(true);
    expect(hub.push(input)).toBe(false);
    expect(got.length).toBe(1);
  });

  test("keeps the same prompt from different sources", () => {
    const { hub, got } = collect();
    const prompt = "Add a login endpoint";
    expect(hub.push({ prompt, diff: "", source: "clipboard" })).toBe(true);
    expect(hub.push({ prompt, diff: "", source: "browser", app: "claude.ai" })).toBe(true);
    expect(got.length).toBe(2);
  });

  test("drops short prompts and huge pastes", () => {
    const { hub, got } = collect();
    expect(hub.push({ prompt: "hi", diff: "", source: "clipboard" })).toBe(false);
    expect(hub.push({ prompt: "x".repeat(101), diff: "", source: "clipboard" })).toBe(false);
    expect(got.length).toBe(0);
  });

  test("trims whitespace before emitting", () => {
    const { hub, got } = collect();
    hub.push({ prompt: "   Add a login endpoint   ", diff: "", source: "clipboard" });
    expect(got[0].prompt).toBe("Add a login endpoint");
  });

  test("clear resets the dedupe memory", () => {
    const { hub, got } = collect();
    const input = { prompt: "Add a login endpoint", diff: "", source: "clipboard" };
    expect(hub.push(input)).toBe(true);
    expect(hub.push(input)).toBe(false);
    hub.clear();
    expect(hub.push(input)).toBe(true);
    expect(got.length).toBe(2);
  });
});
