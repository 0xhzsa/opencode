import { describe, expect, test } from "bun:test";
import { looksLikeLocation, looksLikePrompt } from "../src/promptCapture";

describe("looksLikePrompt", () => {
  test("accepts a natural-language prompt", () => {
    expect(looksLikePrompt("Add a login endpoint that checks the user's password against the database")).toBe(true);
  });

  test("accepts a multi-line prompt", () => {
    expect(
      looksLikePrompt("Refactor the auth middleware.\nMake sure tokens expire after 15 minutes.\nAdd a test for refresh.")
    ).toBe(true);
  });

  test("rejects code", () => {
    expect(looksLikePrompt("function parse(input) { return input.trim(); }")).toBe(false);
  });

  test("rejects an import block", () => {
    expect(looksLikePrompt("import { useState } from 'react';\nimport { z } from 'zod';")).toBe(false);
  });

  test("rejects empty and tiny strings", () => {
    expect(looksLikePrompt("")).toBe(false);
    expect(looksLikePrompt("hi")).toBe(false);
  });

  test("rejects a huge paste", () => {
    expect(looksLikePrompt("word ".repeat(2000))).toBe(false);
  });

  test("rejects a URL, a bare domain, and a file path", () => {
    expect(looksLikePrompt("https://github.com/anomalyco/opencode")).toBe(false);
    expect(looksLikePrompt("chrome://extensions")).toBe(false);
    expect(looksLikePrompt("github.com/foo/bar")).toBe(false);
    expect(looksLikePrompt("C:\\Users\\stagh\\notes.txt")).toBe(false);
    expect(looksLikePrompt("/home/stagh/notes.md")).toBe(false);
  });

  test("keeps a prompt that merely mentions a URL", () => {
    expect(looksLikePrompt("Read https://example.com/docs and add the retry logic it describes")).toBe(true);
  });
});

describe("looksLikeLocation", () => {
  test("recognizes address-bar text", () => {
    expect(looksLikeLocation("https://claude.ai/chat/abc")).toBe(true);
    expect(looksLikeLocation("localhost:3000")).toBe(true);
    expect(looksLikeLocation("127.0.0.1:9222/json")).toBe(true);
  });

  test("does not treat prose as a location", () => {
    expect(looksLikeLocation("Add rate limiting to the login endpoint")).toBe(false);
  });
});
