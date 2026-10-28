import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const script = join(root, "scripts", "host-smoke.cjs");
const built = join(root, "dist", "extension.js");

function run(args: string[]) {
  const proc = Bun.spawnSync(["node", script, ...args], { stdout: "pipe", stderr: "pipe" });
  return {
    output: proc.stdout.toString() + proc.stderr.toString(),
    exitCode: proc.exitCode,
  };
}

describe("extension host smoke", () => {
  test.skipIf(!existsSync(built))(
    "activates, registers commands, and coaches a clipboard prompt and a save diff",
    () => {
      const { output, exitCode } = run([]);
      expect(output).toContain("PASS");
      expect(exitCode).toBe(0);
    },
    60000
  );

  test.skipIf(!existsSync(built))(
    "falls back to the deterministic engine when the model provider is dead",
    () => {
      const { output, exitCode } = run(["--no-model"]);
      expect(output).toContain("deterministic fallback: ok");
      expect(output).toContain("PASS");
      expect(exitCode).toBe(0);
    },
    60000
  );
});
