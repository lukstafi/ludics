#!/usr/bin/env bun
/**
 * lint-skill-cli-refs.ts (gh-ludics-439)
 *
 * Skill markdown bodies under `skills/` (and template files under
 * `templates/harness/`, `templates/mag/memory/`) are executable specs — Mag
 * (and humans following the skill) literally run the `ludics ...` commands
 * cited in code formatting. The frontmatter `queue-action: …` is auto-
 * registered by the harness, but the prose body is plain text and was
 * historically validated only by reviewer eyeballs at PR time. Round-2 of
 * task-7ae99643 caught two dangling references in a single new skill —
 * `ludics mag verify-container-completion <id>` (no dispatcher case existed)
 * and `ludics tasks list --json` (no `--json` flag).
 *
 * This lint scans the in-scope markdown set for backtick- or
 * code-fence-scoped `ludics <verb> <sub>` references and verifies each one
 * resolves against:
 *   - the live USAGE top-level surface (`extractUsageCommands` from
 *     `lint-cli-readme.ts`)
 *   - the relevant sub-dispatcher's recognized cases (`extractCasesForSite`
 *     from `lint-cli-subcommands.ts` — the gh-ludics-438 helper)
 *
 * Detection rule (Q2): only references that appear inside an inline
 * backtick span (`` `ludics x y` ``) or a fenced code block
 * (```` ``` ````) are flagged. Prose mentions like "the ludics harness
 * directory" outside any code formatting are intentionally not flagged.
 *
 * Skill-name false-positive guard (AC #6): the anchor `(?<![/\w-])ludics\s+`
 * requires a literal space after `ludics`, so hyphen-suffixed skill names
 * like `` `ludics-elaborate` `` or `` `/ludics-draft-proposal` `` are
 * naturally excluded. The negative lookbehind also rejects path segments
 * like `~/repos/ludics worktree` or `cwd:~/ludics scripts/...` (where the
 * char before `ludics` is `/`, a word-char, or `-`) — those mention the
 * project root, not a CLI invocation.
 *
 * Dynamic-prefix special-case (AC #5): `ludics slot N <sub>` is recognized
 * as `slot` + slot-id + sub. The slot-id matches `\d+`, the literal
 * placeholder `N`, the angle-bracket placeholder `<N>`, or shell-variable
 * forms `$N` / `${N}` / `$TASK_ID`. The dispatcher cases for `slot` are
 * extracted from `runSlot` in `src/slots/index.ts` directly — gh-ludics-438's
 * DISPATCHERS array does not yet cover slot. TODO: upstream a
 * `runSlot` site descriptor into 438's helper once the slot dispatcher is
 * stable enough.
 *
 * SILENT-DRIFT WARNING (gh-ludics-406): the markdown extractors below are
 * regex over source. A DRY refactor that consolidates skill prose behind a
 * partials/include mechanism would let this lint pass vacuously. The
 * floor-count meta-test in `scripts/lint-skill-cli-refs.test.ts` guards
 * against that.
 */

import { readFileSync } from "fs";
import { Glob } from "bun";
import { join } from "path";
import { extractUsageCommands } from "./lint-cli-readme.ts";
import {
  ALIASES,
  DISPATCHERS,
  extractCasesForSite,
  extractCasesFromFn,
  extractNamedBody,
} from "./lint-cli-subcommands.ts";

const root = join(import.meta.dir, "..");

// ---------------------------------------------------------------------------
// In-scope file globs (AC #2)
// ---------------------------------------------------------------------------

export const IN_SCOPE_GLOBS: ReadonlyArray<string> = [
  "skills/*.md",
  "skills/orchestration/*.md",
  "templates/harness/CLAUDE.md",
  "templates/mag/memory/*.md",
];

// ---------------------------------------------------------------------------
// Code-context extraction (AC #3)
// ---------------------------------------------------------------------------

export interface CodeSpan {
  file: string;
  line: number;
  text: string;
}

// Walk markdown line-by-line, tracking fence state. Inline-backtick spans
// (within prose lines) and lines inside fenced code blocks both contribute
// CodeSpans. Fenced delimiters are recognized as `^\s*` + three-or-more
// backticks (any optional language tag). Inline backticks are matched as
// the shortest span between paired single backticks on the same line.
//
// A fenced delimiter line itself is not emitted as a span, but a line whose
// content begins with three backticks inside an *already open* fence is
// treated as the closing delimiter and not emitted either.
export function extractCodeSpans(file: string, source: string): CodeSpan[] {
  const out: CodeSpan[] = [];
  const lines = source.split("\n");
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const trimmed = raw.trimStart();
    if (/^`{3,}/.test(trimmed)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      out.push({ file, line: i + 1, text: raw });
      continue;
    }
    // Inline-backtick scan. Skip triple-backtick clusters mid-line (those are
    // unbalanced fence-start fragments — markdown spec says they're literals;
    // any matched ludics ref inside is treated like prose).
    let j = 0;
    while (j < raw.length) {
      const ch = raw[j];
      if (ch !== "`") {
        j++;
        continue;
      }
      // count run length
      let runStart = j;
      while (j < raw.length && raw[j] === "`") j++;
      const runLen = j - runStart;
      if (runLen >= 3) continue; // ignore — would have been a fence
      // find matching closing run of the same length on this line
      const search = "`".repeat(runLen);
      const closeAt = raw.indexOf(search, j);
      if (closeAt === -1) {
        // unmatched — bail to next char after the opener
        continue;
      }
      out.push({ file, line: i + 1, text: raw.slice(j, closeAt) });
      j = closeAt + runLen;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reference extraction (AC #4, #5, #6, #7)
// ---------------------------------------------------------------------------

export interface CliRef {
  verb: string;
  sub: string | null;
  // For `ludics slot <id> <sub>`, holds the literal id token (e.g. "2",
  // "N", "<N>", "$N", "${N}", "$TASK_ID"). null otherwise.
  slotPlaceholder: string | null;
  file: string;
  line: number;
}

// Slot id token: digits, bareword `N`, angle-bracket placeholder `<N>` /
// `<n>`, or any shell-variable form `$NAME` / `${NAME}`.
const SLOT_ID_TOKEN = /^(?:\d+|[Nn]|<[A-Za-z_][\w-]*>|\$\{?[A-Za-z_]\w*\}?)$/;

// `(?<![/\w-])ludics\s+` is the required anchor — the explicit space
// excludes hyphen-suffixed skill names like `ludics-elaborate` (AC #6),
// and the negative lookbehind excludes path segments like
// `~/repos/ludics worktree` or `~/ludics scripts/foo.ts` (where `/`,
// a word-char, or `-` precedes `ludics`). Verb / sub tokens follow
// `[a-z][a-z0-9-]*` (hyphenated multi-word names like
// `auto-start-evaluate` accepted, AC #7).
const LUDICS_VERB_RE =
  /(?<![/\w-])ludics\s+([a-z][a-z0-9-]*)\b(?:\s+(\S+))?(?:\s+(\S+))?/g;

const VERB_OR_SUB_RE = /^[a-z][a-z0-9-]*$/;

export function extractCliRefs(spans: ReadonlyArray<CodeSpan>): CliRef[] {
  const out: CliRef[] = [];
  for (const span of spans) {
    LUDICS_VERB_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = LUDICS_VERB_RE.exec(span.text)) !== null) {
      const verb = m[1]!;
      const second = m[2] ?? null;
      const third = m[3] ?? null;
      if (verb === "slot" && second !== null && SLOT_ID_TOKEN.test(second)) {
        // `ludics slot <id> <sub>?` — sub is the third token if present and
        // matches the verb-or-sub shape.
        const sub = third !== null && VERB_OR_SUB_RE.test(third) ? third : null;
        out.push({
          verb,
          sub,
          slotPlaceholder: second,
          file: span.file,
          line: span.line,
        });
        continue;
      }
      const sub = second !== null && VERB_OR_SUB_RE.test(second) ? second : null;
      out.push({
        verb,
        sub,
        slotPlaceholder: null,
        file: span.file,
        line: span.line,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sub-dispatcher recognized-set computation (AC #4, #8)
// ---------------------------------------------------------------------------

// For a given prefix in 438's DISPATCHERS, compute the recognized sub-command
// set: raw cases ∪ alias names from ALIASES[prefix]. Aliases are added so a
// citation of either canonical or alias resolves cleanly. Internal-hidden
// commands (`on-stop`, `queue-pop`, ...) remain in the set — they are real
// dispatcher cases that work, just hidden from public help, and a skill that
// fires them is still operating against a live entry point.
function recognizedSubsFor(
  cases: Set<string>,
  prefix: string,
): Set<string> {
  const out = new Set<string>();
  for (const c of cases) {
    if (!c) continue;
    out.add(c);
  }
  for (const [canonical, alias] of ALIASES[prefix] ?? []) {
    if (canonical) out.add(canonical);
    if (alias) out.add(alias);
  }
  return out;
}

// Compute the recognized sub-command sets keyed by prefix. The `slot` prefix
// is computed inline because gh-ludics-438's DISPATCHERS does not yet cover
// the slot dispatcher (TODO: upstream).
export function buildSubCommandIndex(
  readSource: (relPath: string) => string,
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const site of DISPATCHERS) {
    if (site.prefix === "ludics") continue; // top-level handled separately
    const src = readSource(site.file);
    const open = site.shape === "registry-map" ? "[" : "{";
    const body = extractNamedBody(src, site.fnName, open);
    const cases = extractCasesForSite(body, site.shape);
    out.set(site.prefix, recognizedSubsFor(cases, site.prefix));
  }
  // slot dispatcher — inline extraction. TODO(gh-ludics-438): consolidate
  // once 438's DISPATCHERS array grows a slot site descriptor.
  const slotSrc = readSource("src/slots/index.ts");
  const slotBody = extractNamedBody(slotSrc, "runSlot", "{");
  const rawSlotCases = extractCasesFromFn(slotBody);
  const slotCases = new Set<string>();
  for (const c of rawSlotCases) {
    if (!c || !VERB_OR_SUB_RE.test(c)) continue; // drop arg-parsing flags
    slotCases.add(c);
  }
  out.set("slot", recognizedSubsFor(slotCases, "slot"));
  return out;
}

// Recognized top-level verb set — USAGE commands ∪ ludics aliases. Reuses
// `extractUsageCommands` from `lint-cli-readme.ts` (the existing
// gh-ludics-431-aware extractor) so there is exactly one parser for the
// USAGE template literal — adding a second copy here would reintroduce
// the silent-truncation drift class that 431 fixed (per AC #4 / reviewer
// item #3).
export function buildTopLevelIndex(indexSrc: string): Set<string> {
  const out = new Set<string>(extractUsageCommands(indexSrc));
  for (const [canonical, alias] of ALIASES["ludics"] ?? []) {
    if (canonical) out.add(canonical);
    if (alias) out.add(alias);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export interface ResolutionError {
  ref: CliRef;
  kind: "unknown-verb" | "unknown-sub";
  message: string;
}

// 438's DISPATCHERS prefixes (those with a known sub-dispatcher) plus slot.
// Used to decide whether a missing sub is a hard error or merely "the verb
// has no sub-dispatcher; nothing to validate" (e.g. `ludics briefing`).
function buildDispatcherPrefixSet(): Set<string> {
  const out = new Set<string>();
  for (const site of DISPATCHERS) {
    if (site.prefix === "ludics") continue;
    out.add(site.prefix);
  }
  out.add("slot");
  return out;
}

const DISPATCHER_PREFIX_SET = buildDispatcherPrefixSet();

export function resolveCliRefs(
  refs: ReadonlyArray<CliRef>,
  topLevel: Set<string>,
  subsByPrefix: Map<string, Set<string>>,
): ResolutionError[] {
  const errors: ResolutionError[] = [];
  for (const ref of refs) {
    if (!topLevel.has(ref.verb)) {
      errors.push({
        ref,
        kind: "unknown-verb",
        message: `unknown top-level command: ludics ${ref.verb} (${ref.file}:${ref.line})`,
      });
      continue;
    }
    // Resolve through the ludics-level alias map first: e.g. `orchestration`
    // → `orch`. The sub-dispatcher index is keyed by canonical prefix.
    const canonicalPrefix = canonicalLudicsAlias(ref.verb);
    if (!DISPATCHER_PREFIX_SET.has(canonicalPrefix)) continue;
    if (ref.sub === null) continue; // bare `ludics mag` etc. — top-level OK
    const subs = subsByPrefix.get(canonicalPrefix);
    if (!subs) continue; // no sub index — nothing to validate
    if (!subs.has(ref.sub)) {
      errors.push({
        ref,
        kind: "unknown-sub",
        message: `unknown sub-command: ludics ${ref.verb} ${ref.sub} (${ref.file}:${ref.line})`,
      });
    }
  }
  return errors;
}

function canonicalLudicsAlias(verb: string): string {
  for (const [canonical, alias] of ALIASES["ludics"] ?? []) {
    if (alias === verb) return canonical;
  }
  return verb;
}

// ---------------------------------------------------------------------------
// Top-level entry
// ---------------------------------------------------------------------------

export interface LintResult {
  refs: CliRef[];
  errors: ResolutionError[];
}

export function lintSkillCliRefs(
  files: ReadonlyArray<string>,
  readSource: (path: string) => string,
  indexSrc: string,
  readDispatcherSource: (relPath: string) => string,
): LintResult {
  const spans: CodeSpan[] = [];
  for (const file of files) {
    const src = readSource(file);
    spans.push(...extractCodeSpans(file, src));
  }
  const refs = extractCliRefs(spans);
  const topLevel = buildTopLevelIndex(indexSrc);
  const subsByPrefix = buildSubCommandIndex(readDispatcherSource);
  const errors = resolveCliRefs(refs, topLevel, subsByPrefix);
  return { refs, errors };
}

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

if (import.meta.main) {
  const files = collectInScopeFiles(root);
  const indexSrc = readFileSync(join(root, "src", "index.ts"), "utf-8");
  const result = lintSkillCliRefs(
    files,
    (rel) => readFileSync(join(root, rel), "utf-8"),
    indexSrc,
    (rel) => readFileSync(join(root, rel), "utf-8"),
  );

  if (result.errors.length === 0) {
    console.log(
      `✅  All ${result.refs.length} skill/template CLI refs across ${files.length} files resolve.`,
    );
    process.exit(0);
  }

  console.error(
    `\n❌  Skill body CLI refs do not resolve to live dispatchers:\n`,
  );
  for (const e of result.errors) {
    console.error(`     - ${e.message}`);
  }
  console.error(
    `\n   Each error names a backtick- or code-fence-scoped 'ludics …'\n` +
      `   reference that does not resolve to a real USAGE entry / dispatcher\n` +
      `   case. Fix by either:\n` +
      `     (a) updating the skill prose to a live command, or\n` +
      `     (b) implementing the missing dispatcher case (and USAGE entry\n` +
      `         + default-listing, which lint:cli-subcommands enforces).\n` +
      `   See scripts/lint-skill-cli-refs.ts for the regex shape.\n`,
  );
  process.exit(1);
}
