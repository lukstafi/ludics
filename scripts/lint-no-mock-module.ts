#!/usr/bin/env bun
/**
 * lint-no-mock-module.ts
 *
 * CI lint: `mock.module(…)` is banned in `*.test.ts` files under `src/` and
 * `templates/`. The bun:test mock.module helper has known correctness issues
 * in this repo's adapter/test-isolation patterns; tests must use spies, in-file
 * exports, or test-utils helpers instead.
 *
 * Replaces the previous `package.json` grep one-liner with a real TS module so
 * the lint can be unit-tested against tmp fixtures (the negative-branch
 * exit-code falsifier the grep one-liner could not provide).
 *
 * Exit code:
 *   0 — no `*.test.ts` file under src/ or templates/ contains `mock.module(`
 *   1 — one or more offending files found (paths printed to stderr)
 */

import { readdirSync, readFileSync, statSync, existsSync } from "fs";
import { join, relative, sep } from "path";

const MOCK_MODULE_PATTERN = /\bmock\.module\(/;

/** Recursively walk `dir` and return every `*.test.ts` file (absolute paths). */
export function listTestFiles(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    let entries: string[] = [];
    try {
      entries = readdirSync(cur);
    } catch {
      continue;
    }
    for (const entry of entries) {
      // Match the previous `grep -r` semantics: do NOT skip dot-directories.
      // GNU grep recurses into hidden dirs by default, so an offending
      // `*.test.ts` under `src/.something/` was caught before. Skipping dots
      // would silently weaken the policy (codex P2 on PR #468).
      const full = join(cur, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) stack.push(full);
      else if (st.isFile() && entry.endsWith(".test.ts")) out.push(full);
    }
  }
  return out.sort();
}

export interface RunLintResult {
  exitCode: number;
  /** Repo-relative paths (forward slashes) of offending test files. */
  offenders: string[];
}

/**
 * Scan `<root>/src/` and `<root>/templates/` for any `*.test.ts` whose source
 * contains `mock.module(`. Returns the offending repo-relative paths and an
 * exitCode of 1 if any are found.
 */
export function runLint(root: string): RunLintResult {
  const offenders: string[] = [];
  for (const sub of ["src", "templates"]) {
    const subDir = join(root, sub);
    for (const abs of listTestFiles(subDir)) {
      let source: string;
      try {
        source = readFileSync(abs, "utf-8");
      } catch {
        continue;
      }
      if (MOCK_MODULE_PATTERN.test(source)) {
        offenders.push(relative(root, abs).split(sep).join("/"));
      }
    }
  }
  offenders.sort();
  return { exitCode: offenders.length > 0 ? 1 : 0, offenders };
}

if (import.meta.main) {
  // Optional first positional arg overrides the root directory, which lets
  // tests exercise the real CLI exit-code paths against a tmp fixture.
  const argRoot = process.argv[2];
  const root = argRoot ? argRoot : join(import.meta.dir, "..");
  const { exitCode, offenders } = runLint(root);

  if (exitCode === 0) {
    console.log("✅  No mock.module(...) usage in *.test.ts files.");
    process.exit(0);
  }

  console.error(
    `\n❌  ${offenders.length} *.test.ts file${offenders.length === 1 ? "" : "s"} use mock.module(...):`,
  );
  for (const f of offenders) {
    console.error(`     - ${f}`);
  }
  console.error(
    "\n     Replace mock.module(...) with spies, in-file exports, or a test-utils helper.\n",
  );
  process.exit(1);
}
