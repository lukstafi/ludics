#!/usr/bin/env bun
/**
 * lint-test-spawn-coverage.ts (task-f534e799)
 *
 * Mechanizes the trip-wire grep from `feedback_cli_exit_code_needs_spawn.md`
 * (originally captured from gh-ludics-439; second occurrence flagged in the
 * PR #518 / task-9329e350 retrospective): a test named
 * `test("exits 0|1|N|non-zero …")` (or `it(…)`) inside a `describe(…)` block
 * is asserting on a CLI surface contract — exit code, stderr/stdout shape,
 * remediation prompt. A correct test for that contract must spawn the actual
 * CLI binary; an in-process resolver assertion (`runLint(...)`,
 * `lintCorpus(...)`, etc.) is the gh-ludics-439 / PR #518 anti-pattern.
 *
 * In-scope file set: `scripts/*.test.ts` only (Q1 boundary). `src/**`,
 * `templates/**`, etc. are out of scope. Trigger recognizer fires only on
 * `exits 0|1|N|non-zero` (Q2 tightening) — `exits after …` / `exits early
 * …`-style runner-lifecycle tests (which assert on an in-process function's
 * return, not a CLI exit code) do not match.
 *
 * Spawn allowlist (Q3): `Bun.spawnSync(`, `Bun.spawn(`, `Bun.$`,
 * `execFileSync(`, `execSync(`, `spawnSync(`, `spawn(`. The Node-style
 * standalone forms accept an imported `spawnSync` / `spawn` from
 * `child_process`.
 *
 * Scope rule (Q4-extended): a trigger fires only if its nearest enclosing
 * `describe(…)` body, its ancestor describe bodies, and the file body
 * (collectively) contain no spawn-allowlist match. Sibling describes
 * outside the ancestor chain do not count toward coverage.
 *
 * Escape hatch (Q5): a `// lint:allow-no-spawn` line comment immediately
 * above a trigger row (intervening blank lines allowed; no other code)
 * suppresses that one trigger. The pragma scope is the immediately-
 * following `test(`/`it(` call only.
 */

import { readFileSync } from "fs";
import { Glob } from "bun";
import { join } from "path";

const root = join(import.meta.dir, "..");

// ---------------------------------------------------------------------------
// In-scope file set
// ---------------------------------------------------------------------------

export const IN_SCOPE_GLOBS: ReadonlyArray<string> = ["scripts/*.test.ts"];

export function collectInScopeFiles(rootDir: string): string[] {
  const out: string[] = [];
  for (const pattern of IN_SCOPE_GLOBS) {
    const glob = new Glob(pattern);
    for (const match of glob.scanSync({ cwd: rootDir, onlyFiles: true })) {
      out.push(match);
    }
  }
  return out.sort();
}

// ---------------------------------------------------------------------------
// Recognizers
// ---------------------------------------------------------------------------

// Trigger: `test("exits 0|1|N|non-zero …")` or `it(...)`. Captures the full
// quoted name body (group 1) for the violation snippet. Uses an inner
// non-greedy `[^"]*` so the regex anchors on a single quoted string.
const TRIGGER_RE =
  /(?:test|it)\s*\(\s*"(exits\s+(?:0|1|\d+|non-zero)\b[^"]*)"/g;

// Spawn allowlist (single anchored expression matching any of the forms).
// `Bun.spawn(` matches both sync (`Bun.spawnSync(`) and async (`Bun.spawn(`)
// shapes via the optional `Sync` capture. `\bspawn(` / `\bspawnSync(`
// accept Node-style standalone imports from `child_process`.
const SPAWN_RE =
  /Bun\.spawn(?:Sync)?\(|Bun\.\$|execFileSync\s*\(|execSync\s*\(|\bspawnSync\s*\(|\bspawn\s*\(/g;

const PRAGMA_LITERAL = "// lint:allow-no-spawn";

// ---------------------------------------------------------------------------
// describe(…) block discovery — balanced-brace walk
// ---------------------------------------------------------------------------

export interface DescribeBlock {
  /** Character offset of the opening `{` of the describe body. */
  readonly bodyStart: number;
  /** Character offset of the matching closing `}`. */
  readonly bodyEnd: number;
}

// Match the opening shape `describe("...", () => {` (or function form / async
// / single bareword arg). The match's terminal char is `{` — the body open.
const DESCRIBE_OPEN_RE =
  /\bdescribe\s*\(\s*(?:"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`|'(?:[^'\\]|\\.)*')\s*,\s*(?:async\s+)?(?:\([^)]*\)|[a-zA-Z_$][\w$]*|function\s*\*?\s*[a-zA-Z_$]?\w*\s*\([^)]*\))\s*(?:=>)?\s*\{/g;

/**
 * Walk balanced braces starting from `startIdx` (which must be a `{`),
 * skipping over string literals (single, double, backtick template),
 * template-substitution `${…}` interiors, and `//` / `/* …`/ comments.
 * Returns the index of the matching `}`, or -1 if not found.
 */
export function findMatchingBrace(source: string, startIdx: number): number {
  if (source[startIdx] !== "{") return -1;
  let depth = 0;
  let i = startIdx;
  while (i < source.length) {
    const c = source[i]!;
    const next = source[i + 1];
    if (c === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (
        i < source.length - 1 &&
        !(source[i] === "*" && source[i + 1] === "/")
      ) {
        i++;
      }
      i += 2;
      continue;
    }
    if (c === "'" || c === '"') {
      const q = c;
      i++;
      while (i < source.length && source[i] !== q) {
        if (source[i] === "\\") {
          i += 2;
          continue;
        }
        i++;
      }
      i++;
      continue;
    }
    if (c === "`") {
      i++;
      while (i < source.length && source[i] !== "`") {
        if (source[i] === "\\") {
          i += 2;
          continue;
        }
        if (source[i] === "$" && source[i + 1] === "{") {
          i += 2;
          let subDepth = 1;
          while (i < source.length && subDepth > 0) {
            const cc = source[i]!;
            if (cc === "{") subDepth++;
            else if (cc === "}") subDepth--;
            i++;
          }
          continue;
        }
        i++;
      }
      i++;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

export function findDescribeBlocks(source: string): DescribeBlock[] {
  const out: DescribeBlock[] = [];
  DESCRIBE_OPEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DESCRIBE_OPEN_RE.exec(source)) !== null) {
    const bodyStart = m.index + m[0].length - 1;
    const bodyEnd = findMatchingBrace(source, bodyStart);
    if (bodyEnd === -1) continue;
    out.push({ bodyStart, bodyEnd });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Trigger / spawn / pragma scanning
// ---------------------------------------------------------------------------

export interface TriggerMatch {
  /** Character offset of the start of the `test|it` keyword. */
  readonly idx: number;
  /** 1-indexed line number containing the trigger. */
  readonly line: number;
  /** The full quoted test-name literal (between the surrounding `"` chars). */
  readonly testName: string;
}

export function findTriggers(source: string): TriggerMatch[] {
  const out: TriggerMatch[] = [];
  TRIGGER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TRIGGER_RE.exec(source)) !== null) {
    out.push({
      idx: m.index,
      line: lineOf(source, m.index),
      testName: m[1]!,
    });
  }
  return out;
}

export function findSpawnIndices(source: string): number[] {
  const out: number[] = [];
  SPAWN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SPAWN_RE.exec(source)) !== null) out.push(m.index);
  return out;
}

function lineOf(source: string, idx: number): number {
  let line = 1;
  for (let i = 0; i < idx && i < source.length; i++) {
    if (source[i] === "\n") line++;
  }
  return line;
}

/**
 * Returns true if the trigger row is preceded — allowing intervening blank
 * lines but no other code — by a `// lint:allow-no-spawn` line comment.
 */
export function hasPragmaAbove(source: string, triggerIdx: number): boolean {
  const lineStart = source.lastIndexOf("\n", triggerIdx - 1) + 1;
  if (lineStart === 0) return false;
  let cursor = lineStart - 1;
  while (cursor > 0) {
    const prevLineEnd = cursor;
    const prevLineStart = source.lastIndexOf("\n", cursor - 1) + 1;
    const prevLine = source.slice(prevLineStart, prevLineEnd);
    const trimmed = prevLine.trim();
    if (trimmed === "") {
      cursor = prevLineStart - 1;
      continue;
    }
    return trimmed === PRAGMA_LITERAL;
  }
  return false;
}

/**
 * For a spawn at `spawnIdx` to count as coverage for a trigger at
 * `triggerIdx`:
 *   - every describe containing the spawn must also contain the trigger
 *     (i.e. the spawn lives in the trigger's ancestor chain — sibling
 *     and unrelated-nested describes are filtered out), AND
 *   - if the trigger is inside any describe, the spawn must also be
 *     inside at least one describe (a file-scope spawn does NOT cover a
 *     describe-internal trigger; this is the AC's "top-level test rows
 *     use file body as describe body" boundary read in reverse).
 *
 * Equivalently: containers(spawn) ⊆ containers(trigger) AND
 * (containers(trigger) empty implies containers(spawn) empty).
 */
export function spawnCoversTrigger(
  spawnIdx: number,
  triggerIdx: number,
  blocks: ReadonlyArray<DescribeBlock>,
): boolean {
  const triggerContainers: DescribeBlock[] = [];
  const spawnContainers: DescribeBlock[] = [];
  for (const b of blocks) {
    if (b.bodyStart < triggerIdx && triggerIdx < b.bodyEnd) {
      triggerContainers.push(b);
    }
    if (b.bodyStart < spawnIdx && spawnIdx < b.bodyEnd) {
      spawnContainers.push(b);
    }
  }
  for (const sb of spawnContainers) {
    if (!triggerContainers.includes(sb)) return false;
  }
  if (triggerContainers.length > 0 && spawnContainers.length === 0) {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Per-file lint
// ---------------------------------------------------------------------------

export interface Violation {
  readonly file: string;
  readonly line: number;
  readonly testName: string;
}

export function lintFile(file: string, source: string): Violation[] {
  const blocks = findDescribeBlocks(source);
  const triggers = findTriggers(source);
  const spawns = findSpawnIndices(source);
  const out: Violation[] = [];
  for (const t of triggers) {
    if (hasPragmaAbove(source, t.idx)) continue;
    const covered = spawns.some((s) => spawnCoversTrigger(s, t.idx, blocks));
    if (covered) continue;
    out.push({ file, line: t.line, testName: t.testName });
  }
  return out;
}

export function lintCorpus(
  files: ReadonlyArray<string>,
  readSource: (relPath: string) => string,
): Violation[] {
  const all: Violation[] = [];
  for (const file of files) {
    const src = readSource(file);
    all.push(...lintFile(file, src));
  }
  return all;
}

// ---------------------------------------------------------------------------
// Trigger-row count helper (for the floor-count meta-test)
// ---------------------------------------------------------------------------

export function countTriggerRows(
  files: ReadonlyArray<string>,
  readSource: (relPath: string) => string,
): { totalRows: number; filesWithRows: number } {
  let totalRows = 0;
  let filesWithRows = 0;
  for (const file of files) {
    const src = readSource(file);
    const triggers = findTriggers(src);
    if (triggers.length > 0) {
      totalRows += triggers.length;
      filesWithRows++;
    }
  }
  return { totalRows, filesWithRows };
}

// ---------------------------------------------------------------------------
// CLI entry — mirrors lint-skill-shell.ts / lint-skill-cli-refs.ts shape
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const files = collectInScopeFiles(root);
  const violations = lintCorpus(files, (rel) =>
    readFileSync(join(root, rel), "utf-8"),
  );
  const triggerCount = countTriggerRows(files, (rel) =>
    readFileSync(join(root, rel), "utf-8"),
  ).totalRows;
  if (violations.length === 0) {
    console.log(
      `✅  All ${triggerCount} exits-named tests in ${files.length} scripts/*.test.ts files spawn the CLI in their describe block.`,
    );
    process.exit(0);
  }
  const plural = violations.length === 1 ? "" : "s";
  console.error(
    `\n❌  ${violations.length} test("exits …") row${plural} do not spawn the CLI in their describe block:\n`,
  );
  for (const v of violations) {
    console.error(`     - ${v.file}:${v.line} test("${v.testName}")`);
  }
  console.error(
    `\n   Each row above names a test whose name promises CLI-level\n` +
      `   coverage (exit code, stderr/stdout shape, remediation prompt) but\n` +
      `   whose enclosing describe block does not call any of\n` +
      `   Bun.spawnSync, Bun.spawn, Bun.$, execFileSync, execSync,\n` +
      `   spawnSync, or spawn. Fix by either:\n` +
      `     (a) rewrite to spawn the CLI via Bun.spawnSync and assert on\n` +
      `         proc.exitCode / proc.stderr / proc.stdout (mirroring the\n` +
      `         tamper-and-restore harness in scripts/lint-skill-shell.test.ts), or\n` +
      `     (b) rename the test if it is genuinely asserting on an\n` +
      `         in-process function's exit-code-shaped return (e.g.\n` +
      `         "returns exit-code 0 …"), or\n` +
      `     (c) add // lint:allow-no-spawn on the line immediately above the\n` +
      `         test row if the in-process pattern is intentional and the\n` +
      `         test name's CLI promise has been re-read.\n`,
  );
  process.exit(1);
}
