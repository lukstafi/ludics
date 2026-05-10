#!/usr/bin/env bun
/**
 * lint-skill-shell.ts (task-9329e350)
 *
 * Skill markdown bodies under `skills/` (and template files under
 * `templates/harness/`, `templates/mag/memory/`) are read by humans and LLMs,
 * not executed by a shell, so a typo in a shell-variable reference (e.g.
 * `$EVENTS_BASELINE_LINE` when the actual derivation step output is
 * `$EVENTS_LINES`) has zero runtime signal. The PR #493 retrospective on
 * task-a670cdbf flagged this as a class of silently-rotting references that
 * careful reviewer reading is a weak catch-net for. This lint catches the
 * whole class mechanically by resolving every shell-context `$VAR` /
 * `${VAR}` reference against either an in-file assignment or a hardcoded
 * `HARNESS_INHERITED` set.
 *
 * In-scope files are shared with `lint:skill-cli-refs` (imported, not a
 * parallel literal). Shell-context discrimination is shared with
 * `lint:template-safety` (imported, not a parallel classifier). Per-file
 * assignment scope: every shell span in a single skill markdown contributes
 * to one assignment pool, so `EVENTS_LINES=$(…)` in one fence resolves a
 * `$EVENTS_LINES` reference in a later fence of the same file.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { IN_SCOPE_GLOBS, collectInScopeFiles } from "./lint-skill-cli-refs.ts";
// AC: the lint imports the classifier surface from lint-template-safety
// (no parallel classifier). `findFencedShellBlocks` + `findInlineShellSpans`
// are the load-bearing collectors; `classifyLines` + `looksLikeShell` are
// imported for downstream consumers / tests that want the same partition
// guarantee, and re-exported so a parallel literal would conflict at the
// module surface.
import {
  classifyLines,
  findFencedShellBlocks,
  findInlineShellSpans,
  looksLikeShell,
} from "./lint-template-safety.ts";

const root = join(import.meta.dir, "..");

// ---------------------------------------------------------------------------
// HARNESS_INHERITED — names assumed defined by the harness invocation surface
// ---------------------------------------------------------------------------

/**
 * Hardcoded allowlist of variable names the harness sets in the environment
 * before a skill runs (or that are special to the slash-command invocation
 * surface). v1 has no sidecar file or inline escape hatch; adding a name
 * requires touching this set.
 *
 * Sources:
 *   - skills/orchestrator-conventions.md § Environment
 *   - skills/worker-conventions.md § Environment / Argument Parsing
 *
 * Shell special parameters ($0–$9, $@, $*, $#, $?, $!, $$, $_, $-) are
 * handled by skipping non-`[A-Za-z_]` first characters in the reference
 * scanner rather than by allowlist entries.
 */
export const HARNESS_INHERITED: ReadonlySet<string> = new Set([
  // Harness-set environment (skills/orchestrator-conventions.md:103-104,
  // skills/worker-conventions.md:253-257). LUDICS_REQUEST_ID is the
  // contractual name for the request-id value read from
  // `$LUDICS_STATE_PATH/mag/current-request-id`.
  "LUDICS_STATE_PATH",
  "LUDICS_RESULTS_DIR",
  "LUDICS_REQUEST_ID",
  // Slash-command positional surface (skills/worker-conventions.md:7-10).
  "ARGUMENTS",
  // Standard env / shell built-ins. Skill examples cite `$HOME`,
  // `$PATH`, etc. as ambient; flagging them would be noise.
  "HOME",
  "PATH",
  "USER",
  "SHELL",
  "PWD",
  "OLDPWD",
  "TMPDIR",
  "EDITOR",
  "LANG",
  "LC_ALL",
  "IFS",
]);

// Re-export for tests / downstream consumers; canonical sources live in the
// imported modules.
export {
  IN_SCOPE_GLOBS,
  collectInScopeFiles,
  classifyLines,
  findFencedShellBlocks,
  findInlineShellSpans,
  looksLikeShell,
};

// ---------------------------------------------------------------------------
// Shell-line aggregation (AC: shell-context discrimination matches
// lint-template-safety)
// ---------------------------------------------------------------------------

export interface ShellLine {
  /** 1-indexed line number in the source file. */
  readonly line: number;
  /** The shell-context text (a fenced-block body line, or the body of an
   *  inline-backtick span that `looksLikeShell` accepted). */
  readonly text: string;
}

/** Collect every shell-context line from a markdown source. Fenced ```sh /
 *  ```bash / ```shell blocks contribute their body lines verbatim; inline
 *  backtick spans contribute the body the inline scanner accepted (already
 *  filtered through `looksLikeShell` by `findInlineShellSpans`). Order is
 *  fenced first, then inline; per-file scope makes order irrelevant for
 *  resolution. */
export function collectShellLines(source: string): ShellLine[] {
  const lines = source.split("\n");
  const out: ShellLine[] = [];
  for (const span of findFencedShellBlocks(lines)) {
    for (let i = span.startLine; i <= span.endLine; i++) {
      out.push({ line: i + 1, text: lines[i]! });
    }
  }
  for (const span of findInlineShellSpans(lines)) {
    const i = span.startLine;
    const text = lines[i]!.slice(span.startCol, span.endCol);
    out.push({ line: i + 1, text });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reference extraction (AC: $NAME and ${NAME...} forms)
// ---------------------------------------------------------------------------

export interface ShellVarRef {
  readonly name: string;
  readonly line: number;
  readonly snippet: string;
}

/** Strip the inner string of `bash -c '…'` / `sh -c "…"` invocations so the
 *  reference scanner treats them as opaque (AC: no recursive scanning). The
 *  inner-string content is replaced with spaces so that column positions of
 *  surrounding tokens (and assignment regex anchoring) are preserved.
 *
 *  Single-quoted bodies are already opaque by the scanner's quote-state
 *  logic, but double-quoted `sh -c "…"` bodies would otherwise be scanned
 *  for references; this pass makes both quote forms uniformly opaque. */
export function stripSubshellArgs(line: string): string {
  return line.replace(
    /\b(?:bash|sh)\s+-c\s+(["'])((?:\\.|(?!\1).)*)\1/g,
    (match, quote: string, body: string) =>
      match.slice(0, match.length - body.length - 1) +
      " ".repeat(body.length) +
      quote,
  );
}

/** Set of bash special-parameter follow-chars after `$`. We consume two
 *  chars and emit no reference when `$` is followed by one of these. */
const SPECIAL_FOLLOW_CHARS = new Set([
  "$",
  "?",
  "!",
  "@",
  "*",
  "#",
  "_",
  "-",
]);

const NAME_HEAD = /^[A-Za-z_]$/;
const NAME_CHAR = /^[A-Za-z0-9_]$/;

/** Extract every `$NAME` / `${NAME…}` reference from a shell line, tracking
 *  per-line quote state. Inside single-quoted strings, `$VAR` does not
 *  interpolate — references are not extracted. Inside double-quoted strings
 *  and unquoted regions, `$VAR` is extracted. `\$VAR` is treated as escaped
 *  (no reference). `$$` is treated as the PID special parameter (no
 *  reference). Command substitution `$(…)` is entered (its body is scanned
 *  in the same pass; the lint thus sees `$VAR` inside a `$(…)` body). */
export function extractRefsFromLine(rawText: string, lineNum: number): ShellVarRef[] {
  const text = stripSubshellArgs(rawText);
  const refs: ShellVarRef[] = [];
  const snippet = rawText.trim();
  let i = 0;
  let inSingle = false;
  let inDouble = false;
  while (i < text.length) {
    const ch = text[i]!;
    // Backslash escape (only meaningful outside single quotes — bash
    // treats backslash as literal inside `'…'`).
    if (ch === "\\" && !inSingle && i + 1 < text.length) {
      i += 2;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      i++;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      i++;
      continue;
    }
    if (inSingle) {
      i++;
      continue;
    }
    if (ch !== "$") {
      i++;
      continue;
    }
    // We're at `$`. Decide what follows.
    const next = text[i + 1];
    if (next === undefined) {
      i++;
      continue;
    }
    if (SPECIAL_FOLLOW_CHARS.has(next) || /\d/.test(next)) {
      // $$, $?, $!, $@, $*, $#, $_, $-, $0..$9 — special parameter, no ref.
      i += 2;
      continue;
    }
    if (next === "(") {
      // $(…) command substitution — descend into the body so refs inside
      // $(…) are scanned in the same pass.
      i += 2;
      continue;
    }
    if (next === "{") {
      // ${…} parameter expansion. Optional leading `#` (length-of) or `!`
      // (indirect-of). Then the name, then expansion-modifier sub-tokens
      // we don't separately validate.
      let j = i + 2;
      if (text[j] === "#" || text[j] === "!") j++;
      const start = j;
      while (j < text.length && NAME_CHAR.test(text[j]!)) j++;
      const name = text.slice(start, j);
      if (name && NAME_HEAD.test(name[0]!)) {
        refs.push({ name, line: lineNum, snippet });
      }
      // Skip to the matching `}` (best-effort — we don't fully parse
      // nested braces but track a depth counter so `${VAR/$X/}` etc.
      // close properly).
      let depth = 1;
      while (j < text.length && depth > 0) {
        const c = text[j]!;
        if (c === "{") depth++;
        else if (c === "}") depth--;
        j++;
        if (depth === 0) break;
      }
      i = j;
      continue;
    }
    if (NAME_HEAD.test(next)) {
      // $NAME bareword.
      let j = i + 1;
      while (j < text.length && NAME_CHAR.test(text[j]!)) j++;
      const name = text.slice(i + 1, j);
      refs.push({ name, line: lineNum, snippet });
      i = j;
      continue;
    }
    // `$` followed by something else (e.g. `$"…"` locale-string,
    // `$'…'` ANSI-C string). Skip the `$`.
    i++;
  }
  return refs;
}

export function extractRefs(shellLines: ReadonlyArray<ShellLine>): ShellVarRef[] {
  const out: ShellVarRef[] = [];
  for (const sl of shellLines) {
    out.push(...extractRefsFromLine(sl.text, sl.line));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Assignment extraction (AC: bare NAME=, for/read, local/declare/export/readonly)
// ---------------------------------------------------------------------------

/** Bare `NAME=` at line start or after a shell separator (`;`, `&`, `|`,
 *  whitespace, opening paren). Catches `local NAME=`, `export NAME=`,
 *  `declare NAME=`, `readonly NAME=` too because the keyword + space puts
 *  the assignment after a whitespace boundary. Also catches mid-line
 *  assignments after `&&` / `||` (the regex's `&` / `|` boundary chars). */
const BARE_ASSIGN_RE = /(?:^|[\s;|&(])([A-Za-z_][A-Za-z0-9_]*)=/g;

/** `for NAME in …` — NAME is bound by the loop. Also handles `for ((…))` C-
 *  style loops by scanning their bodies separately (they look like normal
 *  assignments with `(())` syntax which we ignore — the loop variable is
 *  declared via `=` which the bare regex already catches). */
const FOR_RE = /\bfor\s+([A-Za-z_][A-Za-z0-9_]*)\b\s+in\b/g;

/** `read [-flag(s)]* NAME [NAME …]` — every name token after the flags is
 *  bound by the read. We accept short flags only (`-r`, `-p "prompt"`, etc.
 *  the `-p` value-bearing case isn't separately stripped; the names
 *  collected may include the prompt token. The spurious extra names are
 *  harmless as far as the lint is concerned — they only widen the
 *  assignment pool. */
const READ_RE = /\bread\b((?:\s+-[A-Za-z]+)*)\s+((?:[A-Za-z_][A-Za-z0-9_]*\s+)*[A-Za-z_][A-Za-z0-9_]*)/g;

/** `${NAME:=value}` / `${NAME=value}` — bash parameter expansion that BOTH
 *  references and *assigns* NAME (when NAME is unset/empty). Distinct from
 *  `${NAME:-value}` / `${NAME-value}` which only substitute. The lint
 *  recognizes the assignment shape so a skill author who writes
 *  `: "${CREATED_TASKS:=}"` to "default-if-unset" gets credit for an
 *  in-file definition, matching real bash semantics. */
const PARAM_ASSIGN_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*):?=/g;

export function extractAssignmentsFromLine(text: string): string[] {
  const names: string[] = [];
  for (const m of text.matchAll(BARE_ASSIGN_RE)) names.push(m[1]!);
  for (const m of text.matchAll(FOR_RE)) names.push(m[1]!);
  for (const m of text.matchAll(READ_RE)) {
    for (const n of m[2]!.trim().split(/\s+/)) {
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(n)) names.push(n);
    }
  }
  for (const m of text.matchAll(PARAM_ASSIGN_RE)) names.push(m[1]!);
  return names;
}

export function extractAssignments(shellLines: ReadonlyArray<ShellLine>): Set<string> {
  const out = new Set<string>();
  for (const sl of shellLines) {
    for (const n of extractAssignmentsFromLine(sl.text)) out.add(n);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-file lint
// ---------------------------------------------------------------------------

export interface Violation {
  readonly file: string;
  readonly line: number;
  readonly name: string;
  readonly snippet: string;
}

export function lintFile(file: string, source: string): Violation[] {
  const shellLines = collectShellLines(source);
  const assignments = extractAssignments(shellLines);
  const refs = extractRefs(shellLines);
  const out: Violation[] = [];
  for (const ref of refs) {
    if (assignments.has(ref.name)) continue;
    if (HARNESS_INHERITED.has(ref.name)) continue;
    out.push({ file, line: ref.line, name: ref.name, snippet: ref.snippet });
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
// CLI entry — mirrors lint-skill-cli-refs.ts output shape
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const files = collectInScopeFiles(root);
  const violations = lintCorpus(
    files,
    (rel) => readFileSync(join(root, rel), "utf-8"),
  );
  if (violations.length === 0) {
    console.log(
      `✅  All shell-variable references in ${files.length} skill/template files resolve to in-file assignments or HARNESS_INHERITED.`,
    );
    process.exit(0);
  }
  console.error(
    `\n❌  ${violations.length} undefined shell-variable reference${violations.length === 1 ? "" : "s"} in skill bodies:\n`,
  );
  for (const v of violations) {
    console.error(`     - ${v.file}:${v.line} $${v.name} (${v.snippet})`);
  }
  console.error(
    `\n   Each error names a shell-context $NAME or \${NAME} that is\n` +
      `   neither defined earlier in the same file's shell content nor in\n` +
      `   the script's HARNESS_INHERITED set. Fix by either:\n` +
      `     (a) defining the variable earlier in the same file's shell\n` +
      `         (e.g. NAME=$(…) before the first reference), or\n` +
      `     (b) adding the name to HARNESS_INHERITED in\n` +
      `         scripts/lint-skill-shell.ts (with a comment naming the\n` +
      `         harness path that sets it), or\n` +
      `     (c) fixing the typo to match an existing name.\n`,
  );
  process.exit(1);
}
