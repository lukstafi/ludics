// Regression test for eslint.config.js honoring the `^_` prefix convention
// for `@typescript-eslint/no-unused-vars`.
//
// Invariant: the `src/**/*.ts` rule block configures
// `@typescript-eslint/no-unused-vars` with both `argsIgnorePattern: "^_"`
// and `varsIgnorePattern: "^_"`. Dropping either pattern — or the whole
// rule entry — will fail an assertion below.
//
// The test loads eslint.config.js via its actual export so it catches
// semantic removal, not just text edits. A second behavioral check lints
// a fixture written into src/ to prove the rule does what the config
// says: `_unused` passes, bare `unused` errors.

import { describe, test, expect, afterAll } from "bun:test";
import { ESLint } from "eslint";
import { writeFileSync, unlinkSync, existsSync } from "fs";
import { join } from "path";
import eslintConfig from "../eslint.config.js";

const repoRoot = join(import.meta.dirname, "..");

type RuleEntry =
  | string
  | [string, ...unknown[]]
  | undefined;

function findSrcUnusedVarsEntry(): RuleEntry {
  // The flat config is an array. Find the block whose `files` includes
  // "src/**/*.ts" and read `rules["@typescript-eslint/no-unused-vars"]`.
  const blocks = eslintConfig as Array<{
    files?: string[];
    rules?: Record<string, RuleEntry>;
  }>;
  for (const block of blocks) {
    const files = block.files;
    if (!Array.isArray(files)) continue;
    if (!files.includes("src/**/*.ts")) continue;
    const rule = block.rules?.["@typescript-eslint/no-unused-vars"];
    if (rule !== undefined) return rule;
  }
  return undefined;
}

describe("eslint.config.js: no-unused-vars ignore patterns", () => {
  test("src/**/*.ts block configures no-unused-vars with ^_ patterns", () => {
    const entry = findSrcUnusedVarsEntry();
    expect(Array.isArray(entry)).toBe(true);
    const [severity, options] = entry as [string, Record<string, unknown>];
    expect(severity).toBe("error");
    expect(options.argsIgnorePattern).toBe("^_");
    expect(options.varsIgnorePattern).toBe("^_");
  });
});

// Behavioral check — lint a real file written to src/ so tsconfig's
// `include: ["src/**/*.ts"]` covers it. Assertions prove the rule behaves
// per the config: underscore-prefixed unused identifiers pass, bare ones
// error.

const fixturePath = join(repoRoot, "src", "__fixture_unused_vars_probe.ts");

afterAll(() => {
  if (existsSync(fixturePath)) unlinkSync(fixturePath);
});

function makeLinter() {
  return new ESLint({
    cwd: repoRoot,
    overrideConfigFile: join(repoRoot, "eslint.config.js"),
  });
}

async function lintFixture(source: string) {
  writeFileSync(fixturePath, source);
  const results = await makeLinter().lintFiles([fixturePath]);
  return results
    .flatMap((r) => r.messages)
    .filter((m) => m.ruleId === "@typescript-eslint/no-unused-vars");
}

describe("no-unused-vars behavior in src/ (live ESLint run)", () => {
  test("underscore-prefixed unused param does not error", async () => {
    const messages = await lintFixture(
      `export function f(_unused: number): void { void 0; }\n`,
    );
    expect(messages).toEqual([]);
  });

  test("underscore-prefixed unused local does not error", async () => {
    const messages = await lintFixture(
      `export function f(): void { const _unused = 42; }\n`,
    );
    expect(messages).toEqual([]);
  });

  test("bare unused local still errors (rule is configured, not disabled)", async () => {
    const messages = await lintFixture(
      `export function f(): void { const unused = 42; }\n`,
    );
    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0].message).toMatch(/unused/);
  });
});
