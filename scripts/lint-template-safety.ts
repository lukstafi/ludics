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

export const ALWAYS_POPULATED: ReadonlySet<string> = new Set([
  "PHASE",
  "ROUND",
  "MODE",
  "TASK_ID",
  "AGENT_NAME",
  "AGENT_PROVIDER",
  "AGENT_ROLE",
  "PEER_NAME",
  "PEER_PROVIDER",
  "TASK_SPEC",
  "TASK_SPEC_BRIEF",
  "PEER_REVIEW",
  "PEER_STATUS",
  "PEER_PLAN",
  "GIT_DIFF_STAT",
  "PREVIOUS_ROUND_SUMMARY",
  "MERGE_VOTES",
  "WORKTREE_PATH",
  "PEER_WORKTREE_PATH",
  "STATUS_FILE",
  "PLAN_FILE",
  "MERGED_PLAN_FILE",
  "PLAN_MERGE_ROUND",
  "REVIEW_FILE",
  "PR_FILE",
  "INTERRUPT_FILE",
  "MERGE_VOTE_FILE",
  "SUGGEST_REFACTOR_FILE",
  "WORKFLOW_FEEDBACK_FILE",
  "MERGE_REVIEW_DECISION_FILE",
  "MERGED_MARKER_FILE",
  "PEER_SYNC_DIR",
  "DONE_STATUS",
]);

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
const SHELL_COMMANDS = [
  "git", "gh", "printf", "cat", "rm", "mkdir", "cp", "mv", "cd", "ls", "ln",
  "touch", "test", "chmod", "chown", "find", "awk", "sed", "grep", "egrep", "fgrep",
  "npm", "bun", "node", "python", "python3", "echo", "date", "eval", "source",
  "export", "unset", "read", "xargs", "jq", "yq", "curl", "wget", "sudo", "kill",
  "pkill", "bash", "sh", "zsh", "make", "docker", "ssh", "scp", "rsync", "tar",
  "gzip", "gunzip", "zip", "unzip", "diff", "patch", "pwd", "tee", "sort", "uniq",
  "head", "tail", "wc", "tr", "cut", "true", "false",
] as const;

/** Shell control-flow / compound-command keywords that start shell syntax. */
const SHELL_KEYWORDS = [
  "if", "for", "while", "case", "until", "do", "done", "then", "else", "elif",
  "fi", "esac", "select", "function", "time",
] as const;

const SHELL_COMMAND_ALT = [...SHELL_COMMANDS, ...SHELL_KEYWORDS].join("|");

/** A span's leading content matches a known shell start token. */
const SHELL_COMMAND_PREFIX = new RegExp(
  `^(?:${SHELL_COMMAND_ALT}|:|\\[|\\[\\[|\\{|\\(|\\$\\()\\b`,
);

/** A shell-style leading env-var assignment: `NAME=value ` (one or more). */
const ENV_ASSIGNMENT_PREFIX = /^(?:[A-Z_][A-Z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/;

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
  const stripped = body.replace(/^\s+/, "").replace(ENV_ASSIGNMENT_PREFIX, "");
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

/** Find fenced shell code blocks. Recognizes leading whitespace on the fence
 *  markers so indented code blocks inside numbered lists are detected too.
 *  Returns spans covering the block body (excluding the fence lines). */
export function findFencedShellBlocks(lines: string[]): ShellSpan[] {
  const spans: ShellSpan[] = [];
  let openLine: number | null = null;
  let openIndent = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (openLine == null) {
      const m = line.match(/^(\s*)```(sh|bash|shell)\s*$/);
      if (m) {
        openLine = i;
        openIndent = m[1]!;
      }
      continue;
    }
    // Closing fence: ``` on its own line, matching indentation (or less).
    if (new RegExp(`^${openIndent}\`\`\`\\s*$`).test(line) || /^\s*```\s*$/.test(line)) {
      if (i > openLine + 1) {
        spans.push({
          startLine: openLine + 1,
          endLine: i - 1,
          startCol: 0,
          endCol: lines[i - 1]!.length,
          kind: "fenced",
        });
      }
      openLine = null;
    }
  }
  return spans;
}

/** Build a set of 0-indexed line numbers that live inside ANY fenced code
 *  block (shell or otherwise), including the fence marker lines themselves.
 *  Inline-backtick scanning must skip these — a backtick span inside a
 *  ```ts example is not an inline shell command, and a span inside a
 *  ```sh block is already covered by the fenced-block scan, so re-counting
 *  it as inline would double-report the same violation. */
export function findFencedLines(lines: string[]): Set<number> {
  const fenced = new Set<number>();
  let openLine: number | null = null;
  let openIndent = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (openLine == null) {
      // Any opening fence: ```sh, ```ts, ```, etc.
      const m = line.match(/^(\s*)```[A-Za-z0-9_-]*\s*$/);
      if (m) {
        openLine = i;
        openIndent = m[1]!;
        fenced.add(i); // fence marker line itself
      }
      continue;
    }
    fenced.add(i);
    if (new RegExp(`^${openIndent}\`\`\`\\s*$`).test(line) || /^\s*```\s*$/.test(line)) {
      openLine = null;
    }
  }
  return fenced;
}

/** Find inline backtick spans that look like shell commands (start with a
 *  recognized command token). Skips any line that is inside a fenced code
 *  block — shell-language blocks are handled by `findFencedShellBlocks`
 *  (no double-reporting), and non-shell blocks (e.g., ```ts) must not be
 *  inline-scanned at all. */
export function findInlineShellSpans(lines: string[], fencedLines?: Set<number>): ShellSpan[] {
  const inFence = fencedLines ?? findFencedLines(lines);
  const spans: ShellSpan[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (inFence.has(i)) continue;
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
  const fencedLines = findFencedLines(lines);
  const inlineSpans = findInlineShellSpans(lines, fencedLines);
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

function listTemplates(dir: string): string[] {
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
