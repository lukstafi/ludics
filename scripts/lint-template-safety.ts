#!/usr/bin/env bun
/**
 * lint-template-safety.ts
 *
 * CI lint: detect `{{VAR}}` patterns inside shell contexts of orchestration
 * templates where VAR could resolve to an empty string, silently producing a
 * broken shell command (e.g., `--repo ""`, `https://github.com/.git`).
 *
 * Exit code:
 *   0 — no violations
 *   1 — one or more templates contain unsafe variable usage in shell contexts
 *
 * Safe forms:
 *   - Variables in the always-populated set (see ALWAYS_POPULATED below).
 *   - Variables used inside a matching `{{#IF VAR}}...{{/IF}}` guard.
 *   - Variables declared in the per-file allowlist.
 */

import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { ALWAYS_POPULATED_KEYS } from "../src/orchestration/skills.ts";

/** Re-exported for back-compat; canonical source is `ALWAYS_POPULATED_KEYS` in
 *  `src/orchestration/skills.ts`, co-located with `buildSkillContext`'s
 *  `result` literal so a maintainer adding a new always-populated assignment
 *  touches one file. CI-drift-pair: see `scripts/lint-template-safety.test.ts`
 *  ALWAYS_POPULATED_KEYS drift test. */
export const ALWAYS_POPULATED: ReadonlySet<string> = ALWAYS_POPULATED_KEYS;

/** Per-file allowlist for variables that the lint would otherwise flag but are
 *  guaranteed non-empty by the template's resolution context. Add an entry
 *  only with a comment explaining why the variable is safe for that template. */
export const TEMPLATE_ALLOWLIST: Readonly<Record<string, ReadonlySet<string>>> = {
  // No upstream-specific templates are currently checked in. When templates
  // like forward-pr.md or upstream-final-merge.md are reintroduced and are
  // only resolved when `hasUpstream` is true, add their names here with
  // PROJECT_REPO / UPSTREAM_REPO as allowlisted variables.
};

/** Command/keyword tokens that start a shell command. */
export const SHELL_COMMANDS = [
  "git", "gh", "printf", "cat", "rm", "mkdir", "cp", "mv", "cd", "ls", "ln",
  "touch", "test", "chmod", "chown", "find", "awk", "sed", "grep", "egrep", "fgrep",
  "npm", "bun", "node", "python", "python3", "echo", "date", "eval", "source",
  "export", "unset", "read", "exit", "xargs", "jq", "yq", "curl", "wget", "sudo", "kill",
  "pkill", "bash", "sh", "zsh", "make", "docker", "ssh", "scp", "rsync", "tar",
  "gzip", "gunzip", "zip", "unzip", "diff", "patch", "pwd", "tee", "sort", "uniq",
  "head", "tail", "wc", "tr", "cut", "true", "false", ":",
] as const;

/** Shell control-flow / compound-command keywords that start shell syntax. */
export const SHELL_KEYWORDS = [
  "if", "for", "while", "case", "until", "do", "done", "then", "else", "elif",
  "fi", "esac", "select", "function", "time",
] as const;

const SHELL_COMMAND_ALT = [...SHELL_COMMANDS, ...SHELL_KEYWORDS].join("|");

/** A span's leading content matches a known shell start token. */
const SHELL_COMMAND_PREFIX = new RegExp(
  `^(?:${SHELL_COMMAND_ALT}|:|\\[|\\[\\[|\\{|\\(|\\$\\()\\b`,
);

/** A shell-style leading env-var assignment: `NAME=value ` (one or more).
 *  Retained for the per-segment fallback consumer in
 *  `scripts/lint-template-safety.test.ts`'s `splitOnShellChain` segment loop,
 *  where post-`&&`/`;` segments rarely contain `$(...)` values with embedded
 *  whitespace. The load-bearing `looksLikeShell` path now goes through
 *  `stripLeadingEnvAssignments`, which correctly handles `$(...)` /
 *  double-quoted / single-quoted values containing whitespace (the regex's
 *  `\S*` alternative halts mid-`$(...)` on values like
 *  `PR_URL=$(cat "..." 2>/dev/null)`). */
export const ENV_ASSIGNMENT_PREFIX = /^(?:[A-Z_][A-Z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/;

/** Strip leading env-var assignments from a shell-line candidate, including
 *  assignments whose values are `$(...)`, `"..."`, or `'...'` and may contain
 *  whitespace. Returns `null` when the entire line is one or more pure
 *  assignments with no command after (e.g. `FOO=bar`, `FOO="bar baz"`,
 *  `FOO=$(date)`) — the caller should treat this as "not a shell command".
 *  Returns the remainder starting at the first command token otherwise.
 *
 *  Used by `looksLikeShell` to close the gap where the simpler
 *  `ENV_ASSIGNMENT_PREFIX` regex's `\S*` alternative halts at the first
 *  whitespace inside a `$(...)` value, causing patterns like
 *  `PR_URL=$(cat "..." 2>/dev/null) gh pr view` to be misclassified as prose.
 *  The meta-test in `scripts/lint-template-safety.test.ts` consumes this
 *  same helper so the runtime lint and the meta-test agree on env-prefix
 *  semantics. */
export function stripLeadingEnvAssignments(line: string): string | null {
  let i = 0;
  while (true) {
    while (i < line.length && /\s/.test(line[i]!)) i++;
    const m = line.slice(i).match(/^[A-Z_][A-Z0-9_]*=/);
    if (!m) {
      return i >= line.length ? null : line.slice(i);
    }
    i += m[0].length;
    if (i >= line.length) return null; // pure `NAME=` with no value
    const ch = line[i]!;
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      while (i < line.length && line[i] !== quote) {
        if (line[i] === "\\" && i + 1 < line.length) i += 2;
        else i++;
      }
      if (i < line.length) i++; // skip closing quote
    } else if (ch === "$" && line[i + 1] === "(") {
      i += 2;
      let depth = 1;
      // Track quoted regions so quoted `(` / `)` inside the substitution body
      // don't skew the depth counter (e.g. `$(printf '(')` is a single
      // balanced substitution despite the quoted `(`).
      let quote: '"' | "'" | null = null;
      while (i < line.length && depth > 0) {
        const c = line[i]!;
        if (quote) {
          if (c === "\\" && i + 1 < line.length) { i += 2; continue; }
          if (c === quote) quote = null;
          i++;
          continue;
        }
        if (c === '"' || c === "'") { quote = c; i++; continue; }
        if (c === "(") depth++;
        else if (c === ")") depth--;
        if (depth === 0) break;
        i++;
      }
      if (i < line.length) i++; // skip closing )
    } else {
      // Bare value: consume until whitespace.
      while (i < line.length && !/\s/.test(line[i]!)) i++;
    }
    if (i >= line.length) return null; // pure assignment, no command after
    // Whitespace follows: there may be more assignments or a command. Loop.
  }
}

/** A pipe / logical chain / command separator followed by a command token —
 *  strong evidence that the span is shell and not prose. */
const SHELL_CHAIN = new RegExp(
  `(?:\\s\\||&&|\\|\\||;\\s|\\s>\\s|\\s>>\\s|\\s<\\s)\\s*(?:${SHELL_COMMAND_ALT})\\b`,
);

/** Decide whether an inline backtick span is a shell command. Accepts:
 *   - direct command prefix (`gh pr view ...`)
 *   - shell keyword prefix (`if gh ...; then ...; fi`, `for f in ...; do ...`)
 *   - leading env-var assignments (`FOO=bar gh ...`)
 *   - command substitution / parameter expansion (`$(...)`, `${...}`)
 *   - pipe / chain / redirection into a recognized command token
 *  Keeps prose-style backticks (file paths, identifiers, quoted values) out. */
export function looksLikeShell(body: string): boolean {
  const stripped = stripLeadingEnvAssignments(body.replace(/^\s+/, ""));
  if (stripped === null) return false;
  if (SHELL_COMMAND_PREFIX.test(stripped)) return true;
  if (/\$\(|\$\{/.test(body)) return true;
  if (SHELL_CHAIN.test(body)) return true;
  return false;
}

export interface Violation {
  readonly file: string;
  readonly line: number;
  readonly variable: string;
  readonly context: "fenced" | "inline";
  readonly snippet: string;
}

interface ShellSpan {
  /** 0-indexed start line of the shell context (inclusive). */
  readonly startLine: number;
  /** 0-indexed end line of the shell context (inclusive). */
  readonly endLine: number;
  /** 0-indexed start column within startLine (inclusive). */
  readonly startCol: number;
  /** 0-indexed end column within endLine (exclusive). */
  readonly endCol: number;
  readonly kind: "fenced" | "inline";
}

/** Single-pass row-bucketed classification of every line in `lines`. Each
 *  index maps to exactly one of three disjoint kinds:
 *    - `prose`        — outside any fenced block.
 *    - `fence-marker` — the opening or closing ``` line of a block (shell or
 *                       otherwise; `blockKind` reflects the language tag).
 *    - `fence-body`   — a line strictly between an opening and closing fence
 *                       marker; `blockKind` reflects the language tag and
 *                       `indent` records the opening fence's leading whitespace.
 *
 *  The partition guarantee — `classifyLines(lines).length === lines.length`
 *  with each element well-formed — replaces the previous two-pass scan
 *  (`findFencedShellBlocks` + `findFencedLines` consulted ad-hoc by
 *  `findInlineShellSpans`) where overlapping responsibility allowed a future
 *  scanner to forget the skip-set and re-flag inline-shell-shaped backticks
 *  inside ```ts fences. Downstream scanners now derive their slice from this
 *  one source of truth. */
export type LineClass =
  | { kind: "prose" }
  | { kind: "fence-marker"; blockKind: "shell" | "other" }
  | { kind: "fence-body"; blockKind: "shell" | "other"; indent: string };

const FENCE_OPEN_RE = /^(\s*)```([A-Za-z0-9_-]*)\s*$/;
const SHELL_LANG_RE = /^(?:sh|bash|shell)$/;

export function classifyLines(lines: string[]): LineClass[] {
  const out: LineClass[] = [];
  let openIndent: string | null = null;
  let openBlockKind: "shell" | "other" | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (openIndent == null) {
      const m = line.match(FENCE_OPEN_RE);
      if (m) {
        const indent = m[1]!;
        const lang = m[2]!;
        const blockKind: "shell" | "other" = SHELL_LANG_RE.test(lang) ? "shell" : "other";
        openIndent = indent;
        openBlockKind = blockKind;
        out.push({ kind: "fence-marker", blockKind });
        continue;
      }
      out.push({ kind: "prose" });
      continue;
    }
    // Closing fence: ``` on its own line, matching indentation (or less).
    // Mirrors the original two-pass scanners' close pattern so derived
    // exports keep their existing behavior.
    const exactIndentClose = new RegExp(`^${openIndent}\`\`\`\\s*$`);
    if (exactIndentClose.test(line) || /^\s*```\s*$/.test(line)) {
      out.push({ kind: "fence-marker", blockKind: openBlockKind! });
      openIndent = null;
      openBlockKind = null;
      continue;
    }
    out.push({ kind: "fence-body", blockKind: openBlockKind!, indent: openIndent });
  }
  return out;
}

/** Find fenced shell code blocks. Recognizes leading whitespace on the fence
 *  markers so indented code blocks inside numbered lists are detected too.
 *  Returns spans covering the block body (excluding the fence lines).
 *
 *  Derived from `classifyLines`: collapses consecutive `fence-body` rows with
 *  `blockKind === "shell"` into one span. An unterminated shell fence at EOF
 *  is not emitted (matches the original two-pass behavior). */
export function findFencedShellBlocks(lines: string[]): ShellSpan[] {
  const classes = classifyLines(lines);
  const spans: ShellSpan[] = [];
  let runStart = -1;
  for (let i = 0; i < classes.length; i++) {
    const c = classes[i]!;
    const isShellBody = c.kind === "fence-body" && c.blockKind === "shell";
    if (isShellBody) {
      if (runStart < 0) runStart = i;
      continue;
    }
    if (runStart >= 0) {
      // Run ended at the closing fence-marker (or first non-shell-body row).
      // Only emit when the prior class is fence-marker — i.e., the fence was
      // properly closed. EOF without closing leaves runStart open and is
      // intentionally dropped to mirror the original behavior.
      if (c.kind === "fence-marker") {
        spans.push({
          startLine: runStart,
          endLine: i - 1,
          startCol: 0,
          endCol: lines[i - 1]!.length,
          kind: "fenced",
        });
      }
      runStart = -1;
    }
  }
  return spans;
}

/** Build a set of 0-indexed line numbers that live inside ANY fenced code
 *  block (shell or otherwise), including the fence marker lines themselves.
 *  Inline-backtick scanning must skip these — a backtick span inside a
 *  ```ts example is not an inline shell command, and a span inside a
 *  ```sh block is already covered by the fenced-block scan, so re-counting
 *  it as inline would double-report the same violation.
 *
 *  Derived from `classifyLines`: every non-`prose` row contributes its index. */
export function findFencedLines(lines: string[]): Set<number> {
  const classes = classifyLines(lines);
  const fenced = new Set<number>();
  for (let i = 0; i < classes.length; i++) {
    if (classes[i]!.kind !== "prose") fenced.add(i);
  }
  return fenced;
}

/** Find inline backtick spans that look like shell commands (start with a
 *  recognized command token). Skips any line that is inside a fenced code
 *  block — shell-language blocks are handled by `findFencedShellBlocks`
 *  (no double-reporting), and non-shell blocks (e.g., ```ts) must not be
 *  inline-scanned at all.
 *
 *  Skip set is derived from `classifyLines(lines)`: any non-`prose` row is
 *  skipped. This is the single source of truth for the partition; the
 *  function takes no opt-in skip override — a previous `fencedLines?:
 *  Set<number>` parameter was removed because it allowed callers to hand
 *  in a stale set that disagreed with the partition. */
export function findInlineShellSpans(lines: string[]): ShellSpan[] {
  const classes = classifyLines(lines);
  const skip = (i: number) => classes[i]!.kind !== "prose";
  const spans: ShellSpan[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (skip(i)) continue;
    const line = lines[i]!;
    // Scan for single-backtick spans. We accept only spans enclosed in `…`
    // that do NOT contain a backtick inside (i.e., a minimal match).
    const re = /`([^`\n]+)`/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) != null) {
      const body = m[1]!;
      if (!looksLikeShell(body)) continue;
      const startCol = m.index + 1; // skip opening backtick
      const endCol = startCol + body.length;
      spans.push({
        startLine: i,
        endLine: i,
        startCol,
        endCol,
        kind: "inline",
      });
    }
  }
  return spans;
}

interface IfRange {
  /** Absolute character offset of the body (first char after `}}` of the open tag). */
  readonly bodyStart: number;
  /** Absolute character offset of the body end (first char of `{{/IF}}`). */
  readonly bodyEnd: number;
  readonly variable: string;
}

/** Parse `{{#IF VAR}}...{{/IF}}` blocks. Handles nesting by tracking a stack.
 *  Returned ranges use absolute character offsets into the source text. */
export function parseIfRanges(text: string): IfRange[] {
  const ranges: IfRange[] = [];
  const stack: { variable: string; bodyStart: number }[] = [];
  const tagRe = /\{\{#IF\s+([A-Z0-9_]+)\}\}|\{\{\/IF\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(text)) != null) {
    if (m[0]!.startsWith("{{#IF")) {
      stack.push({ variable: m[1]!, bodyStart: m.index + m[0]!.length });
    } else {
      const top = stack.pop();
      if (top) {
        ranges.push({ variable: top.variable, bodyStart: top.bodyStart, bodyEnd: m.index });
      }
    }
  }
  return ranges;
}

/** Convert a (line, col) location (0-indexed) to an absolute char offset. */
function toOffset(lines: string[], line: number, col: number): number {
  let offset = 0;
  for (let i = 0; i < line; i++) offset += lines[i]!.length + 1; // +1 for '\n'
  return offset + col;
}

/** A {{VAR}} use at `offset` is guarded if there's an enclosing IF-range with
 *  the same variable. */
function isGuarded(offset: number, variable: string, ranges: readonly IfRange[]): boolean {
  for (const r of ranges) {
    if (r.variable === variable && offset >= r.bodyStart && offset < r.bodyEnd) {
      return true;
    }
  }
  return false;
}

export function lintTemplate(
  file: string,
  text: string,
  allowlist: ReadonlySet<string> | undefined,
): Violation[] {
  const lines = text.split(/\r?\n/);
  const fencedSpans = findFencedShellBlocks(lines);
  // No need to pre-compute findFencedLines: findInlineShellSpans now derives
  // its skip set from classifyLines internally.
  const inlineSpans = findInlineShellSpans(lines);
  const ifRanges = parseIfRanges(text);
  const violations: Violation[] = [];
  const varRe = /\{\{([A-Z0-9_]+)\}\}/g;

  const checkSpan = (span: ShellSpan) => {
    for (let i = span.startLine; i <= span.endLine; i++) {
      const line = lines[i]!;
      const colStart = i === span.startLine ? span.startCol : 0;
      const colEnd = i === span.endLine ? span.endCol : line.length;
      const chunk = line.slice(colStart, colEnd);
      let m: RegExpExecArray | null;
      varRe.lastIndex = 0;
      while ((m = varRe.exec(chunk)) != null) {
        const variable = m[1]!;
        if (ALWAYS_POPULATED.has(variable)) continue;
        if (allowlist && allowlist.has(variable)) continue;
        const absOffset = toOffset(lines, i, colStart + m.index);
        if (isGuarded(absOffset, variable, ifRanges)) continue;
        violations.push({
          file,
          line: i + 1,
          variable,
          context: span.kind,
          snippet: line.trim(),
        });
      }
    }
  };

  for (const span of fencedSpans) checkSpan(span);
  for (const span of inlineSpans) checkSpan(span);
  return violations;
}

export function listTemplates(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .sort();
}

export function runLint(templateDir: string): Violation[] {
  const all: Violation[] = [];
  for (const name of listTemplates(templateDir)) {
    const text = readFileSync(join(templateDir, name), "utf-8");
    const allowlist = TEMPLATE_ALLOWLIST[name];
    all.push(...lintTemplate(name, text, allowlist));
  }
  return all;
}

if (import.meta.main) {
  const root = join(import.meta.dir, "..");
  // Optional first positional arg overrides the template directory, which
  // lets tests exercise the real CLI exit-code paths against a temp directory.
  const argDir = process.argv[2];
  const templateDir = argDir ? argDir : join(root, "skills", "orchestration");
  const violations = runLint(templateDir);
  if (violations.length === 0) {
    console.log("✅  All orchestration templates use variables safely in shell contexts.");
    process.exit(0);
  }
  console.error(
    `\n❌  ${violations.length} unsafe template variable use${violations.length === 1 ? "" : "s"} in shell contexts:`,
  );
  for (const v of violations) {
    console.error(
      `     ${v.file}:${v.line}  {{${v.variable}}}  (${v.context})  ${v.snippet}`,
    );
  }
  console.error(
    "\n     Fix options:\n" +
    "       1. Wrap with {{#IF VAR}}...{{/IF}} so the variable only appears when non-empty.\n" +
    "       2. Rework the command to tolerate an empty value (e.g., pre-compute a flag).\n" +
    "       3. If the variable is guaranteed non-empty by the template's resolution\n" +
    "          context, add it to TEMPLATE_ALLOWLIST in scripts/lint-template-safety.ts\n" +
    "          with a comment explaining why.\n",
  );
  process.exit(1);
}
