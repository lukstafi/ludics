#!/usr/bin/env bun
/**
 * lint-src-command-safety.ts
 *
 * Scans src/** for unsafe ssh/remote-command construction:
 *   - Path rule: any src/ file (outside the allowlist) whose real (non-comment,
 *     non-string-literal) source contains an ssh/scp/rsync argv-array literal —
 *     an array whose first element is "ssh", "scp", or "rsync" — is a violation.
 *   - Interpolation rule: any such argv array (in a non-allowlisted file) whose
 *     remote-script argument is a template literal containing a ${…} substitution
 *     is the higher-severity unquoted-interpolation injection shape.
 *
 * src/remote.ts is the single vetted ssh chokepoint in the codebase.  All
 * remote-exec routes through it. The path-based exemption encodes this
 * invariant: only remote.ts may construct an ssh/scp/rsync argv directly.
 * lint:src-command-safety is what enforces that invariant going forward.
 *
 * Reuses computeCodeMask from lint-test-spawn-coverage.ts so token matches
 * do not fire inside comments or string literals.
 *
 * *.test.ts files inside src/ are skipped — test fixtures may legitimately
 * contain ssh argv literals for harness or mock purposes.
 *
 * Exit code: 1 iff any issue found.
 */

import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative, sep } from "path";
import { computeCodeMask } from "./lint-test-spawn-coverage.ts";

const repoRoot = join(import.meta.dir, "..");

// ---------------------------------------------------------------------------
// Allowlist
// ---------------------------------------------------------------------------

/**
 * src/remote.ts is the sole vetted ssh chokepoint: all remote-exec in the
 * codebase routes through this file.  The path-based exemption encodes the
 * invariant that no other src/ file may construct an ssh/scp/rsync argv
 * directly.  If a genuinely vetted new site appears, add it here with a
 * comment explaining why it cannot route through remote.ts.
 */
export const SRC_COMMAND_SAFETY_ALLOWLIST = new Set(["src/remote.ts"]);

// ---------------------------------------------------------------------------
// Issue shape
// ---------------------------------------------------------------------------

/** "path" = ssh/scp/rsync argv literal in a non-allowlisted file.
 *  "interpolation" = same, AND a template-literal-with-${} remote-script
 *  element — the higher-severity unquoted-interpolation injection shape. */
export type IssueKind = "path" | "interpolation";

export interface CommandSafetyIssue {
  /** Repo-relative path with forward slashes. */
  file: string;
  /** 1-based line number of the array literal. */
  line: number;
  /** The flagged command: "ssh", "scp", or "rsync". */
  command: string;
  /** Path violation or the more-specific interpolation-shape violation. */
  kind: IssueKind;
}

// ---------------------------------------------------------------------------
// Detection helpers
// ---------------------------------------------------------------------------

/** Command names whose presence as the first argv element is a violation. */
const SSH_COMMANDS = new Set(["ssh", "scp", "rsync"]);

function lineOf(source: string, idx: number): number {
  let line = 1;
  for (let i = 0; i < idx; i++) {
    if (source[i] === "\n") line++;
  }
  return line;
}

/**
 * Given an unmasked `[` at `bracketIdx`, scan forward through unmasked bytes
 * to find the first string literal (double- or single-quoted) in the array.
 * Masked bytes (comment bodies, string interiors, template bodies) are skipped
 * so block/line comments between `[` and the first element do not suppress
 * detection (e.g. `[/* vetted? *\/ "ssh", ...]` is still caught).
 *
 * Returns the string content if the first non-whitespace, non-masked byte is
 * a quote character; returns null if any other code byte appears first (meaning
 * the first element is not a string literal — a variable, template literal, ]).
 */
function firstStringArg(
  source: string,
  bracketIdx: number,
  mask: Uint8Array,
): string | null {
  for (let i = bracketIdx + 1; i < source.length; i++) {
    if (mask[i]) continue; // masked = comment body, string body, template body — skip
    const c = source[i];
    if (c === '"' || c === "'") {
      // Opening of a string literal (unmasked quote in code).
      // Collect the masked content bytes until the closing (unmasked) quote.
      i++;
      let content = "";
      while (i < source.length) {
        if (!mask[i]) break; // unmasked = closing quote (or unexpected code byte)
        content += source[i];
        i++;
      }
      return content;
    }
    // Any unmasked non-whitespace, non-string byte before a string means the
    // first element is not a string literal — no match.
    if (!/\s/.test(c)) return null;
  }
  return null;
}

/**
 * Find the index of the `]` that closes the array opened at `startIdx`,
 * skipping any bytes the mask marks as non-code (strings, comments,
 * template bodies) so nested bracket characters inside those contexts do
 * not unbalance the counter.
 */
function findArrayEnd(
  source: string,
  startIdx: number,
  mask: Uint8Array,
): number {
  if (source[startIdx] !== "[") return -1;
  let depth = 0;
  for (let i = startIdx; i < source.length; i++) {
    if (mask[i]) continue; // skip masked bytes
    if (source[i] === "[") depth++;
    else if (source[i] === "]") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Return true if the array span [arrayStart, arrayEnd] contains the
 * unquoted-interpolation injection shape: an unmasked backtick (opening a
 * template literal) followed by an unmasked `${` (a substitution opener
 * inside that template).
 *
 * computeCodeMask marks template-body bytes as 1 (masked) and
 * substitution-interior bytes as 0 (code), so an unmasked `${` inside the
 * array span can only originate from a template-literal substitution — the
 * exact injection surface we are looking for.
 */
function hasTemplateInterpolation(
  source: string,
  arrayStart: number,
  arrayEnd: number,
  mask: Uint8Array,
): boolean {
  let seenBacktick = false;
  for (let i = arrayStart; i <= arrayEnd; i++) {
    if (mask[i]) continue;
    if (source[i] === "`") seenBacktick = true;
    if (
      seenBacktick &&
      source[i] === "$" &&
      i + 1 <= arrayEnd &&
      source[i + 1] === "{"
    ) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Per-file scan (pure)
// ---------------------------------------------------------------------------

/**
 * Scan `source` (identified by repo-relative `relPath`) for
 * ssh/scp/rsync argv-array violations.  Returns an empty array for
 * allowlisted paths.
 */
export function scanFile(
  source: string,
  relPath: string,
): CommandSafetyIssue[] {
  if (SRC_COMMAND_SAFETY_ALLOWLIST.has(relPath)) return [];

  const mask = computeCodeMask(source);
  const issues: CommandSafetyIssue[] = [];

  for (let i = 0; i < source.length; i++) {
    if (mask[i]) continue;
    if (source[i] !== "[") continue;

    // Found an unmasked `[`. Use firstStringArg to resolve the first real
    // (non-comment, non-whitespace) source element, handling single-quoted
    // strings and comments between `[` and the first element correctly.
    const cmd = firstStringArg(source, i, mask);
    if (!cmd || !SSH_COMMANDS.has(cmd)) continue;

    const line = lineOf(source, i);
    const arrayEnd = findArrayEnd(source, i, mask);
    const kind: IssueKind =
      arrayEnd !== -1 && hasTemplateInterpolation(source, i, arrayEnd, mask)
        ? "interpolation"
        : "path";

    issues.push({ file: relPath, line, command: cmd, kind });
  }

  return issues;
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

/** Recursively list *.ts source files under `dir`, returning absolute paths.
 *  Skips dot-entries and *.test.ts files (test fixtures may legitimately
 *  contain ssh argv literals for harness / mock purposes). */
export function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  function walk(d: string): void {
    for (const entry of readdirSync(d)) {
      if (entry.startsWith(".")) continue;
      const full = join(d, entry);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (st.isFile() && entry.endsWith(".ts") && !entry.endsWith(".test.ts"))
        out.push(full);
    }
  }
  walk(dir);
  return out.sort();
}

// ---------------------------------------------------------------------------
// runCli
// ---------------------------------------------------------------------------

export interface RunCliOptions {
  /** Source dir to scan.  Defaults to <repo-root>/src. */
  srcDir?: string;
  /** Repo root used to compute repo-relative output paths.
   *  Defaults to <srcDir>/.. (i.e. the repo root when srcDir is the real src/). */
  repoRoot?: string;
  /** Sink for offense lines (default: process.stderr.write). */
  writeErr?: (msg: string) => void;
  /** Sink for the success summary line (default: process.stdout.write). */
  writeOut?: (msg: string) => void;
}

export interface RunCliResult {
  exitCode: number;
  issues: CommandSafetyIssue[];
}

export function runCli(options: RunCliOptions = {}): RunCliResult {
  const srcDir = options.srcDir ?? join(repoRoot, "src");
  const root = options.repoRoot ?? repoRoot;
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

  const issues: CommandSafetyIssue[] = [];

  for (const abs of listSourceFiles(srcDir)) {
    const rel = relative(root, abs).split(sep).join("/");
    const source = readFileSync(abs, "utf-8");
    issues.push(...scanFile(source, rel));
  }

  for (const iss of issues) {
    const detail =
      iss.kind === "interpolation"
        ? 'template-literal `${…}` remote-script — unquoted-interpolation injection shape'
        : "ssh/scp/rsync argv literal (all remote-exec must route through src/remote.ts)";
    writeErr(`❌  ${iss.file}:${iss.line}  "${iss.command}" — ${detail}`);
  }

  if (issues.length === 0) {
    writeOut(
      `✅  No unsafe ssh/remote-command construction in src/ (allowlisted: ${[...SRC_COMMAND_SAFETY_ALLOWLIST].join(", ")}).`,
    );
    return { exitCode: 0, issues };
  }

  writeErr(
    `\n${issues.length} command-safety violation${issues.length === 1 ? "" : "s"} in src/.\n` +
      `   All ssh/scp/rsync invocations must route through src/remote.ts.\n` +
      `   If a new vetted site genuinely cannot route through that chokepoint,\n` +
      `   add it to SRC_COMMAND_SAFETY_ALLOWLIST in scripts/lint-src-command-safety.ts\n` +
      `   with a comment explaining why.`,
  );
  return { exitCode: 1, issues };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

if (import.meta.main) {
  // Optional first positional arg overrides the src directory so tests can
  // exercise the real CLI exit-code paths against a temp directory (mirrors
  // the lint-template-safety.ts convention).
  const argDir = process.argv[2];
  const srcDir = argDir ? argDir : join(repoRoot, "src");
  const root = argDir ? argDir : repoRoot;
  const result = runCli({ srcDir, repoRoot: root });
  process.exit(result.exitCode);
}
