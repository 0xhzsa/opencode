// project.ts — project context detection for Code Coach.
// Scans the current directory for common project files and builds a compressed
// summary (stack, conventions, key modules) that the coach can use to give
// specific, non-generic advice.

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface ProjectContext {
  stack: string[];
  conventions: string[];
  files: string[];
  summary: string;
}

export function detectProject(dir: string = process.cwd()): ProjectContext {
  const stack: string[] = [];
  const conventions: string[] = [];
  const files: string[] = [];

  // package.json
  const pkgPath = join(dir, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      if (pkg.dependencies) {
        const deps = Object.keys(pkg.dependencies);
        if (deps.includes("react")) stack.push("React");
        if (deps.includes("express")) stack.push("Express");
        if (deps.includes("next")) stack.push("Next.js");
        if (deps.includes("vue")) stack.push("Vue");
        if (deps.includes("svelte")) stack.push("Svelte");
        if (deps.includes("fastify")) stack.push("Fastify");
        if (deps.includes("prisma")) stack.push("Prisma");
        if (deps.includes("mongoose")) stack.push("Mongoose");
        if (deps.includes("zod")) conventions.push("zod validation");
        if (deps.includes("yup")) conventions.push("yup validation");
        if (deps.includes("jest") || deps.includes("vitest")) conventions.push("unit tests");
      }
      if (pkg.scripts) {
        if (pkg.scripts.test) conventions.push(`test: ${pkg.scripts.test}`);
        if (pkg.scripts.build) conventions.push(`build: ${pkg.scripts.build}`);
      }
      files.push("package.json");
    } catch {
      // ignore
    }
  }

  // tsconfig.json
  if (existsSync(join(dir, "tsconfig.json"))) {
    stack.push("TypeScript");
    files.push("tsconfig.json");
  }

  // Python
  if (existsSync(join(dir, "requirements.txt")) || existsSync(join(dir, "pyproject.toml"))) {
    stack.push("Python");
    files.push("requirements.txt / pyproject.toml");
  }

  // Go
  if (existsSync(join(dir, "go.mod"))) {
    stack.push("Go");
    files.push("go.mod");
  }

  // Rust
  if (existsSync(join(dir, "Cargo.toml"))) {
    stack.push("Rust");
    files.push("Cargo.toml");
  }

  // Top-level source files (just names, not contents)
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    const srcFiles = entries
      .filter((e) => e.isFile() && /\.(ts|tsx|js|jsx|py|go|rs|java|cs)$/.test(e.name))
      .map((e) => e.name)
      .slice(0, 20);
    files.push(...srcFiles);
  } catch {
    // ignore
  }

  const summary = [
    stack.length ? `Stack: ${stack.join(", ")}` : "Stack: unknown",
    conventions.length ? `Conventions: ${conventions.join(", ")}` : "Conventions: none detected",
    files.length ? `Key files: ${files.join(", ")}` : "Key files: none",
  ].join("\n");

  return { stack, conventions, files, summary };
}
