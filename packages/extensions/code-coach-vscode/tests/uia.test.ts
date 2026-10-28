import { describe, expect, test } from "bun:test";
import { isChatApp, parseUiaLine } from "../src/observe/uia";

describe("parseUiaLine", () => {
  test("accepts a submitted Edit control", () => {
    const parsed = parseUiaLine(
      JSON.stringify({
        event: "submitted",
        app: "Cursor",
        title: "Chat",
        control: "ControlType.Edit",
        text: "Add a login endpoint that checks the password",
      })
    );
    expect(parsed?.text).toContain("login endpoint");
    expect(parsed?.app).toBe("Cursor");
    expect(parsed?.event).toBe("submitted");
  });

  test("never accepts a Document control", () => {
    const parsed = parseUiaLine(
      JSON.stringify({
        event: "blurred",
        app: "Chrome",
        control: "ControlType.Document",
        text: "the entire page contents would be here",
      })
    );
    expect(parsed).toBeNull();
  });

  test("rejects garbage, short text, and huge text", () => {
    expect(parseUiaLine("not json")).toBeNull();
    expect(parseUiaLine(JSON.stringify({ app: "Cursor", control: "ControlType.Edit", text: "hi" }))).toBeNull();
    expect(
      parseUiaLine(
        JSON.stringify({ app: "Cursor", control: "ControlType.Edit", text: "x".repeat(3000) })
      )
    ).toBeNull();
  });

  test("normalizes an unknown event to submitted", () => {
    const parsed = parseUiaLine(
      JSON.stringify({
        event: "something-else",
        app: "Claude",
        control: "ControlType.Edit",
        text: "refactor the auth middleware",
      })
    );
    expect(parsed?.event).toBe("submitted");
  });
});

describe("isChatApp", () => {
  test("accepts the apps the adapter targets", () => {
    expect(isChatApp("Cursor")).toBe(true);
    expect(isChatApp("claude")).toBe(true);
    expect(isChatApp("chrome")).toBe(true);
    expect(isChatApp("msedge")).toBe(true);
  });

  test("rejects unrelated processes", () => {
    expect(isChatApp("explorer")).toBe(false);
    expect(isChatApp("notepad")).toBe(false);
    expect(isChatApp("")).toBe(false);
  });
});
