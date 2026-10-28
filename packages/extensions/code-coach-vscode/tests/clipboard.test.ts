import { describe, expect, test } from "bun:test";
import { ClipboardObserver } from "../src/observe/clipboard";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("ClipboardObserver", () => {
  test("emits prose once and ignores repeats", async () => {
    const reads = [
      "",
      "Add a login endpoint that checks the password",
      "Add a login endpoint that checks the password",
    ];
    const got: string[] = [];
    const observer = new ClipboardObserver(
      async () => reads.shift() ?? "",
      (text) => got.push(text),
      10
    );

    observer.start();
    await sleep(120);
    observer.stop();

    expect(got).toEqual(["Add a login endpoint that checks the password"]);
  });

  test("rejects code pasted to the clipboard", async () => {
    const reads = ["function parse(input) { return input.trim(); }", ""];
    const got: string[] = [];
    const observer = new ClipboardObserver(
      async () => reads.shift() ?? "",
      (text) => got.push(text),
      10
    );

    observer.start();
    await sleep(80);
    observer.stop();

    expect(got.length).toBe(0);
  });

  test("survives a clipboard that throws", async () => {
    const got: string[] = [];
    const observer = new ClipboardObserver(
      async () => {
        throw new Error("clipboard unavailable");
      },
      (text) => got.push(text),
      10
    );

    observer.start();
    await sleep(50);
    observer.stop();

    expect(got.length).toBe(0);
  });
});
