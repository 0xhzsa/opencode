import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const script = join(root, "scripts", "host-smoke.cjs");
const built = join(root, "dist", "extension.js");

describe("extension host smoke", () => {
  test.skipIf(!existsSync(built))(
    "activates, registers commands, and coaches a clipboard prompt and a save diff",
    () => {
      const proc = Bun.spawnSync(["node", script], { stdout: "pipe", stderr: "pipe" });
      const output = proc.stdout.toString() + proc.stderr.toString();
      expect(output).toContain("PASS");
      expect(proc.exitCode).toBe(0);
    },
    60000
  );
});
