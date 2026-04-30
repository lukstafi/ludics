#!/usr/bin/env bun
/**
 * lint-no-shadow-util.ts
 *
 * Catches file-private re-implementations of helpers that already live in
 * `src/orchestration/util.ts`. Those shadows are a known drift pattern
 * (predecessor: task-fc8f0e2b / task-41b91ca3) — copy-pasted bodies that
 * silently fork from the canonical source.
 *
 * The canonical helper-name set is read **dynamically** from
 * `src/orchestration/util.ts` (every `^export function NAME` line). Adding
 * an eighth helper to util.ts automatically extends this lint's coverage.
 *
 * Rule: any file outside `src/orchestration/util.ts` whose source contains
 *   ^(export\s+)?function\s+NAME\s*\(
 * for one of those names is an offense. `*.test.ts` files are excluded —
 * test fixtures legitimately redefine helpers.
 *
 * Exit code: 1 iff any offense found.
 */

import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative, sep } from "path";

const repoRoot = join(import.meta.dir, "..");

// ---------------------------------------------------------------------------
// Issue shape
// ---------------------------------------------------------------------------

export interface ShadowIssue {
  /** Repo-relative path with forward slashes. */
  file: string;
  /** 1-based line number. */
  line: number;
  /** Canonical helper name being shadowed. */
  name: string;
}

// ---------------------------------------------------------------------------
// Canonical name extraction (pure)
// ---------------------------------------------------------------------------

/**
 * Parse the canonical helper-name set from a `util.ts` source string by
 * collecting every `^export function NAME` declaration. Re-exports
 * (`export { ... } from`) are ignored — they're not `function`
 * declarations and cannot be shadowed by a `function` definition.
 */
export function extractCanonicalNames(utilSource: string): Set<string> {
  const names = new Set<string>();
  const re = /^export\s+function\s+([A-Za-z_][\w]*)\s*\(/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(utilSource)) !== null) {
    names.add(m[1]!);
  }
  return names;
}

// ---------------------------------------------------------------------------
// Per-file scan (pure)
// ---------------------------------------------------------------------------

/**
 * Find shadow definitions in `source` against the canonical `names` set.
 * Matches `^(export\s+)?function NAME(` line-anchored — does not match
 * method assignments (`obj.NAME = function`), arrow-form (`const NAME =`),
 * commented-out lines (`// function NAME(`), or call sites (`NAME(...)`).
 */
export function findShadowsInFile(
  source: string,
  names: Set<string>,
): { line: number; name: string }[] {
  const out: { line: number; name: string }[] = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^(?:export\s+)?function\s+([A-Za-z_][\w]*)\s*\(/.exec(lines[i]!);
    if (m && names.has(m[1]!)) {
      out.push({ line: i + 1, name: m[1]! });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

/** Recursively list `*.ts` files under `dir`, returning absolute paths. */
export function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  function walk(d: string): void {
    for (const entry of readdirSync(d)) {
      if (entry.startsWith(".")) continue;
      const full = join(d, entry);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (st.isFile() && entry.endsWith(".ts")) out.push(full);
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
  /** Path to the canonical util.ts. Defaults to `<srcDir>/orchestration/util.ts`. */
  utilPath?: string;
  /** Repo root (for repo-relative paths in output). Defaults to `<srcDir>/..`. */
  repoRoot?: string;
  /** Sink for offense lines (default: process.stderr.write). */
  writeErr?: (msg: string) => void;
  /** Sink for the success summary line (default: process.stdout.write). */
  writeOut?: (msg: string) => void;
}

export interface RunCliResult {
  exitCode: number;
  offenseCount: number;
  issues: ShadowIssue[];
  canonicalNames: string[];
}

export function runCli(options: RunCliOptions = {}): RunCliResult {
  const srcDir = options.srcDir ?? join(repoRoot, "src");
  const utilPath = options.utilPath ?? join(srcDir, "orchestration", "util.ts");
  const root = options.repoRoot ?? join(srcDir, "..");
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

  const utilSource = readFileSync(utilPath, "utf-8");
  const canonical = extractCanonicalNames(utilSource);
  const utilRel = relative(root, utilPath).split(sep).join("/");

  const issues: ShadowIssue[] = [];
  for (const abs of listSourceFiles(srcDir)) {
    const rel = relative(root, abs).split(sep).join("/");
    if (rel === utilRel) continue;
    if (rel.endsWith(".test.ts")) continue;
    const source = readFileSync(abs, "utf-8");
    for (const hit of findShadowsInFile(source, canonical)) {
      issues.push({ file: rel, line: hit.line, name: hit.name });
    }
  }

  for (const iss of issues) {
    writeErr(
      `❌  ${iss.file}:${iss.line}  function ${iss.name} shadows ${utilRel}`,
    );
  }

  const sortedNames = [...canonical].sort();
  if (issues.length === 0) {
    writeOut(
      `✅  No util.ts function shadows detected (${sortedNames.length} canonical names: ${sortedNames.join(", ")}).`,
    );
    return { exitCode: 0, offenseCount: 0, issues, canonicalNames: sortedNames };
  }
  writeErr(
    `\n${issues.length} shadow${issues.length === 1 ? "" : "s"} of ${utilRel}.`,
  );
  return { exitCode: 1, offenseCount: issues.length, issues, canonicalNames: sortedNames };
}

if (import.meta.main) {
  process.exit(runCli().exitCode);
}
