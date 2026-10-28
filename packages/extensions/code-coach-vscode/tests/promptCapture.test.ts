import { describe, expect, test } from "bun:test";
import { looksLikePrompt } from "../src/promptCapture";

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
});
