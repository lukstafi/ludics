#!/usr/bin/env bun
/**
 * lint-test-isolation.ts
 *
 * Catches the three test-harness-isolation anti-patterns documented in
 * `docs/testing-patterns.md#harness-isolation` that motivated the
 * gh-ludics-306 retrospective. Scans `src/**\/*.test.ts` and reports:
 *
 *   Rule 1 (error)   Unconditional `delete process.env.LUDICS_HARNESS_DIR`
 *                    that destroys the `src/test-setup.ts` preload safety net
 *                    for every subsequent test file in the same Bun process.
 *   Rule 2 (error)   `process.env.X = Y ?? undefined`, which coerces the
 *                    right-hand `undefined` into the literal string
 *                    `"undefined"`.
 *   Rule 3 (warning) Test file that directly or one-level-transitively
 *                    imports `src/config.ts`, `src/events.ts`,
 *                    `src/slots/json.ts`, or `src/adapters/base.ts` without
 *                    either setting `LUDICS_HARNESS_DIR` or invoking
 *                    `withTestHarness(`.
 *
 * Exit code: 1 iff errorCount > 0. Warnings never fail.
 */

import { readdirSync, readFileSync, statSync, existsSync } from "fs";
import { join, dirname, relative, resolve, sep } from "path";

const repoRoot = join(import.meta.dir, "..");

// ---------------------------------------------------------------------------
// Target modules and rule-3 allowlist
// ---------------------------------------------------------------------------

/** Repo-relative paths (forward-slash) whose import pulls `harnessDir()`. */
export const RULE_3_TARGETS = new Set<string>([
  "src/config.ts",
  "src/events.ts",
  "src/slots/json.ts",
  "src/adapters/base.ts",
]);

/**
 * Test files known-safe despite no explicit harness setup. Repo-relative with
 * forward slashes. Keep this list short — prefer adding `withTestHarness(` or
 * an explicit `process.env.LUDICS_HARNESS_DIR = ` in the test itself.
 */
export const RULE_3_ALLOWLIST = new Set<string>([
  "src/adapters/task-launch.test.ts",
]);

/** Test files exempt from the whole lint (the helpers that implement it). */
const SCAN_EXCLUDE = new Set<string>([
  "src/test-setup.ts",
  "src/test-utils.ts",
]);

// ---------------------------------------------------------------------------
// Issue shape
// ---------------------------------------------------------------------------

export type LintRule = "rule-1" | "rule-2" | "rule-3";
export type LintSeverity = "error" | "warning";

export interface LintIssue {
  rule: LintRule;
  severity: LintSeverity;
  /** Repo-relative test-file path, forward slashes. */
  file: string;
  /** 1-based line number (rules 1 & 2). */
  line?: number;
  /** Human-readable message fragment — the rule name + file are added elsewhere. */
  message: string;
}

// ---------------------------------------------------------------------------
// Rule 1: unconditional `delete process.env.LUDICS_HARNESS_DIR`
// ---------------------------------------------------------------------------

const DELETE_PATTERN = /\bdelete\s+process\.env\.LUDICS_HARNESS_DIR\b/;
const GUARD_IF = /\bif\s*\(/;
// Accept either `=== undefined` (the canonical shape from the proposal) or
// `!== undefined` (the inverse shape — `if (X !== undefined) set; else delete;`
// is equally conditional and widely used in the existing suite). The intent of
// rule 1 is catching *unconditional* deletes; both shapes guard correctly.
const GUARD_EQ = /[!=]==\s*undefined\b/;

/**
 * A `delete` is accepted when:
 *   (a) the same line also has `if (` + `=== undefined`, or
 *   (b) the previous three non-blank lines (concatenated) contain both
 *       `if (` and `=== undefined`, or
 *   (c) the whole-file source contains the literal `withTestHarness(`.
 */
export function checkRule1(source: string, file: string): LintIssue[] {
  const out: LintIssue[] = [];
  const hasHelperExemption = source.includes("withTestHarness(");
  if (hasHelperExemption) return out;

  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!DELETE_PATTERN.test(line)) continue;

    if (GUARD_IF.test(line) && GUARD_EQ.test(line)) continue; // (a)

    // (b) previous three non-blank lines.
    const lookback: string[] = [];
    for (let j = i - 1; j >= 0 && lookback.length < 3; j--) {
      const prev = lines[j]!;
      if (prev.trim().length === 0) continue;
      lookback.push(prev);
    }
    const joined = lookback.join("\n");
    if (GUARD_IF.test(joined) && GUARD_EQ.test(joined)) continue;

    out.push({
      rule: "rule-1",
      severity: "error",
      file,
      line: i + 1,
      message: "unconditional delete of process.env.LUDICS_HARNESS_DIR",
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rule 2: `process.env.X = Y ?? undefined`
// ---------------------------------------------------------------------------

const RULE_2_PATTERN =
  /process\.env\.[A-Z_][A-Z0-9_]*\s*=\s*[A-Za-z_][\w.]*\s*\?\?\s*undefined\b/;

export function checkRule2(source: string, file: string): LintIssue[] {
  const out: LintIssue[] = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (RULE_2_PATTERN.test(lines[i]!)) {
      out.push({
        rule: "rule-2",
        severity: "error",
        file,
        line: i + 1,
        message:
          "process.env assignment with `?? undefined` coerces to the string \"undefined\"",
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rule 3: transitive unsafe imports without isolation setup
// ---------------------------------------------------------------------------

/**
 * Return the raw import-path strings used as the `from "..."` target of each
 * runtime import. Skips `import type` statements (erased at compile time) and
 * plain side-effect imports without a `from` are ignored too (they don't
 * typically name the target modules).
 */
export function parseImports(source: string): string[] {
  const out: string[] = [];
  // Line-level scan is sufficient; imports always live at top of file.
  const lines = source.split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    if (!line.startsWith("import")) continue;
    if (line.startsWith("import type")) continue;
    const m = /from\s+["']([^"']+)["']/.exec(line);
    if (m) out.push(m[1]!);
  }
  return out;
}

/** True if the test source lexically contains one of the accepted setup tokens. */
export function hasIsolationSetup(source: string): boolean {
  return (
    source.includes("withTestHarness(") ||
    /process\.env\.LUDICS_HARNESS_DIR\s*=/.test(source)
  );
}

/**
 * Resolve a raw import path, as written in `importer`, to a repo-relative
 * path with forward slashes. Returns null if the import is not a relative
 * path into this repo (bare package, absolute URL, etc.) or if no candidate
 * file exists on disk.
 */
export function resolveImport(
  importer: string,
  rawPath: string,
  repoRootAbs: string,
): string | null {
  if (!rawPath.startsWith(".")) return null;
  const importerAbs = resolve(repoRootAbs, importer);
  const baseAbs = resolve(dirname(importerAbs), rawPath);
  const candidates = [baseAbs, baseAbs + ".ts", join(baseAbs, "index.ts")];
  for (const cand of candidates) {
    if (existsSync(cand) && statSync(cand).isFile()) {
      const rel = relative(repoRootAbs, cand).split(sep).join("/");
      return rel;
    }
  }
  return null;
}

export interface Rule3Input {
  /** Repo-relative path of the test file (forward slashes). */
  file: string;
  /** Source of the test file. */
  source: string;
  /** Direct import raw paths, pre-extracted. */
  directImports: string[];
  /** Map from repo-relative neighbour path → its `parseImports` output. */
  neighbourImports: Map<string, string[]>;
  /** Set of RULE_3_TARGETS for injection-friendliness. */
  targets: Set<string>;
  /** Repo-relative allowlist. */
  allowlist: Set<string>;
  /**
   * Resolver bound to the repo root. Accepts `(importer, rawPath)` and
   * returns the repo-relative resolved path or null.
   */
  resolve: (importer: string, rawPath: string) => string | null;
}

export function checkRule3(input: Rule3Input): LintIssue[] {
  if (input.allowlist.has(input.file)) return [];
  if (hasIsolationSetup(input.source)) return [];

  // Direct hit?
  const directResolved: { raw: string; resolved: string }[] = [];
  for (const raw of input.directImports) {
    const r = input.resolve(input.file, raw);
    if (r) directResolved.push({ raw, resolved: r });
  }
  for (const { raw, resolved } of directResolved) {
    if (input.targets.has(resolved)) {
      return [
        {
          rule: "rule-3",
          severity: "warning",
          file: input.file,
          message: `imports ${resolved} without LUDICS_HARNESS_DIR setup or withTestHarness() (direct import "${raw}")`,
        },
      ];
    }
  }

  // One-level transitive.
  for (const { raw, resolved } of directResolved) {
    const neighbours = input.neighbourImports.get(resolved);
    if (!neighbours) continue;
    for (const nraw of neighbours) {
      const nres = input.resolve(resolved, nraw);
      if (nres && input.targets.has(nres)) {
        return [
          {
            rule: "rule-3",
            severity: "warning",
            file: input.file,
            message: `imports ${nres} via ${resolved} ("${raw}") without LUDICS_HARNESS_DIR setup or withTestHarness()`,
          },
        ];
      }
    }
  }

  return [];
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

/** Recursively list `*.test.ts` files under `dir`, returning absolute paths. */
export function listTestFiles(dir: string): string[] {
  const out: string[] = [];
  function walk(d: string): void {
    for (const entry of readdirSync(d)) {
      if (entry.startsWith(".")) continue;
      const full = join(d, entry);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (st.isFile() && entry.endsWith(".test.ts")) out.push(full);
    }
  }
  walk(dir);
  return out.sort();
}

// ---------------------------------------------------------------------------
// runCli
// ---------------------------------------------------------------------------

export interface RunCliOptions {
  /** Source dir to scan. Defaults to `<repo-root>/src`. */
  srcDir?: string;
  /** Repo root (used to resolve repo-relative import paths). Defaults to `<srcDir>/..`. */
  repoRoot?: string;
  /** Rule-3 allowlist override (for tests). */
  allowlist?: Set<string>;
  /** Sink for warning/error lines (default: process.stderr.write). */
  writeErr?: (msg: string) => void;
  /** Sink for the success summary line (default: process.stdout.write). */
  writeOut?: (msg: string) => void;
}

export interface RunCliResult {
  exitCode: number;
  errorCount: number;
  warningCount: number;
  issues: LintIssue[];
}

export function runCli(options: RunCliOptions = {}): RunCliResult {
  const srcDir = options.srcDir ?? join(repoRoot, "src");
  const root = options.repoRoot ?? dirname(srcDir);
  const allowlist = options.allowlist ?? RULE_3_ALLOWLIST;
  const writeErr =
    options.writeErr ??
    ((msg) => {
      process.stderr.write(msg + "\n");
    });
  const writeOut =
    options.writeOut ??
    ((msg) => {
      process.stdout.write(msg + "\n");
    });

  const resolveBound = (importer: string, rawPath: string) =>
    resolveImport(importer, rawPath, root);

  const neighbourCache = new Map<string, string[]>();
  function loadNeighbourImports(relPath: string): string[] {
    const cached = neighbourCache.get(relPath);
    if (cached) return cached;
    const abs = join(root, relPath);
    let imports: string[] = [];
    try {
      imports = parseImports(readFileSync(abs, "utf-8"));
    } catch {
      imports = [];
    }
    neighbourCache.set(relPath, imports);
    return imports;
  }

  const issues: LintIssue[] = [];
  for (const abs of listTestFiles(srcDir)) {
    const rel = relative(root, abs).split(sep).join("/");
    if (SCAN_EXCLUDE.has(rel)) continue;
    const source = readFileSync(abs, "utf-8");

    issues.push(...checkRule1(source, rel));
    issues.push(...checkRule2(source, rel));

    const directImports = parseImports(source);
    // Pre-resolve neighbours we care about for rule 3 (keeps checkRule3 pure).
    const neighbourImports = new Map<string, string[]>();
    for (const raw of directImports) {
      const resolved = resolveBound(rel, raw);
      if (resolved && !RULE_3_TARGETS.has(resolved)) {
        neighbourImports.set(resolved, loadNeighbourImports(resolved));
      }
    }
    issues.push(
      ...checkRule3({
        file: rel,
        source,
        directImports,
        neighbourImports,
        targets: RULE_3_TARGETS,
        allowlist,
        resolve: resolveBound,
      }),
    );
  }

  let errorCount = 0;
  let warningCount = 0;
  for (const iss of issues) {
    const where =
      iss.line !== undefined ? `${iss.file}:${iss.line}` : iss.file;
    if (iss.severity === "error") {
      errorCount++;
      writeErr(`❌  [${where}] ${iss.rule}: ${iss.message}`);
    } else {
      warningCount++;
      writeErr(`⚠️   [${where}] ${iss.rule}: ${iss.message}`);
    }
  }

  if (errorCount === 0) {
    const suffix =
      warningCount > 0
        ? ` (${warningCount} warning${warningCount === 1 ? "" : "s"})`
        : "";
    writeOut(`✅  No test-isolation anti-patterns detected${suffix}.`);
    return { exitCode: 0, errorCount, warningCount, issues };
  }
  writeErr(
    `\n${errorCount} error${errorCount === 1 ? "" : "s"}, ${warningCount} warning${warningCount === 1 ? "" : "s"}.`,
  );
  return { exitCode: 1, errorCount, warningCount, issues };
}

if (import.meta.main) {
  process.exit(runCli().exitCode);
}
