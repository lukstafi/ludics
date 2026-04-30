#!/usr/bin/env bun
/**
 * lint-cli-subcommands.ts (gh-ludics-438)
 *
 * Catches the silent triple-edit drift that `lint:cli-readme` doesn't see:
 *   - cases / registry keys in each sub-dispatcher
 *   - sub-command lines in src/index.ts USAGE for the matching prefix
 *   - the literal listing in the dispatcher's default `(use: …)` clause
 *
 * Invariants enforced for each registered site:
 *   1. cases ⊆ usageSubs        — implemented but undocumented
 *   2. cases ⊆ listing          — implemented but missing from default error
 *   3. listing ⊆ cases          — listing entry with no implementation
 *   4. usageSubs ⊆ cases        — documented but unimplemented
 *
 * Aliases (allow-list) and internal-hidden commands are normalised before
 * comparison. The top-level ludics site has no hand-maintained listing — the
 * unknown-command message is derived from MIGRATED_COMMANDS keys via
 * formatUnknownTopLevel — so only invariants 1 and 4 apply there.
 *
 * SILENT-DRIFT WARNING (gh-ludics-406): the per-shape extractors below are
 * regex over source. A DRY refactor that collapses the literals would let
 * this lint pass vacuously. Floor-count meta-tests in
 * scripts/lint-cli-subcommands.test.ts guard against that.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { extractUsageBlock } from "./lint-cli-readme.ts";

const root = join(import.meta.dir, "..");

// ---------------------------------------------------------------------------
// Site registry
// ---------------------------------------------------------------------------

export type DispatcherShape = "switch" | "registry-map" | "registry-record" | "if-else";

export interface DispatcherSite {
  file: string;          // e.g. "src/mag.ts" — repo-relative
  prefix: string;        // appears in USAGE block + unknown-command error
  fnName: string;        // function or top-level identifier scoping the body
  shape: DispatcherShape;
  hasListing: boolean;   // false for ludics (listing is derived from keys)
}

export const DISPATCHERS: ReadonlyArray<DispatcherSite> = [
  // mag: hasListing: false because the unknown-command listing in runMag is
  // derived programmatically from magSubcommands.keys() — checking it would
  // be tautological. The cases set IS the listing by construction.
  { file: "src/mag.ts",                  prefix: "mag",       fnName: "magSubcommands",     shape: "registry-map",    hasListing: false },
  { file: "src/flow.ts",                 prefix: "flow",      fnName: "runFlow",            shape: "switch",          hasListing: true },
  { file: "src/tasks/index.ts",          prefix: "tasks",     fnName: "runTasks",           shape: "switch",          hasListing: true },
  { file: "src/triggers.ts",             prefix: "triggers",  fnName: "runTriggers",        shape: "switch",          hasListing: true },
  { file: "src/notify.ts",               prefix: "notify",    fnName: "runNotify",          shape: "switch",          hasListing: true },
  { file: "src/cluster.ts",              prefix: "cluster",   fnName: "runCluster",         shape: "switch",          hasListing: true },
  { file: "src/dashboard.ts",            prefix: "dashboard", fnName: "runDashboard",       shape: "switch",          hasListing: true },
  { file: "src/orchestration/index.ts",  prefix: "orch",      fnName: "runOrchestrationCli",shape: "switch",          hasListing: true },
  { file: "src/network.ts",              prefix: "network",   fnName: "runNetwork",         shape: "if-else",         hasListing: true },
  { file: "src/index.ts",                prefix: "ludics",    fnName: "MIGRATED_COMMANDS",  shape: "registry-record", hasListing: false },
];

// canonical → alias. The alias may legitimately be missing from USAGE/listing
// as long as the canonical name is present.
export const ALIASES: Record<string, ReadonlyArray<readonly [string, string]>> = {
  mag:      [["on-stop", "queue-pop"]],          // queue-pop deprecated
  triggers: [["pause", "disable"], ["status", ""]],
  cluster:  [["status", ""]],
  orch:     [["status", ""]],
  notify:   [["outgoing", "pai"]],
  network:  [["status", ""]],
  ludics:   [["orch", "orchestration"]],
};

// Real cases / keys excluded from the public USAGE + listing comparisons.
// These are internal entry points (hook scripts, self-relaunch) that should
// stay callable but never surface in user help.
export const INTERNAL_HIDDEN: Record<string, ReadonlyArray<string>> = {
  mag: ["on-stop", "queue-pop"],     // Stop-hook entry; queue-pop is deprecated alias of on-stop
  orch: ["run-internal", "on-stop"], // run-internal is self-relaunch; on-stop is Stop-hook entry
};

// USAGE-side allow-list: documented commands that are intentionally not
// dispatched through the registered cases (e.g. ludics `help` is handled
// inline in main() before dispatch). These are dropped from the
// "documented but no implementation" comparison only.
export const USAGE_INLINE_HANDLED: Record<string, ReadonlyArray<string>> = {
  ludics: ["help"],
};


// ---------------------------------------------------------------------------
// Pure helpers (exported for unit testing)
// ---------------------------------------------------------------------------

// Locate the body of a named function declaration / arrow / top-level const,
// returning the substring inside its outermost balanced delimiters. `open`
// selects whether to track `{}` (function/object bodies) or `[]` (Map([...])
// registry-map shape). Walks balanced delimiters with a depth counter; no AST.
// Returns "" if the name is not found.
export function extractNamedBody(
  source: string,
  name: string,
  open: "{" | "[" = "{",
): string {
  const close = open === "{" ? "}" : "]";
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$1");
  const pattern = new RegExp(
    `(?:async\\s+function|function|const|let|export\\s+(?:async\\s+function|function|const|let))\\s+${escaped}\\b`,
    "g",
  );
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(source)) !== null) {
    const startIdx = source.indexOf(open, m.index);
    if (startIdx === -1) continue;
    let depth = 0;
    for (let i = startIdx; i < source.length; i++) {
      const ch = source[i];
      if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) {
          return source.slice(startIdx + 1, i);
        }
      }
    }
  }
  return "";
}

// Pick the body-delimiter pair for a given dispatcher shape.
function openBracketFor(shape: DispatcherShape): "{" | "[" {
  return shape === "registry-map" ? "[" : "{";
}

// switch-shape: extract `case "X":` literals.
export function extractCasesFromFn(body: string): Set<string> {
  const out = new Set<string>();
  const re = /^\s*case\s+"([\w-]+)":/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) out.add(m[1]!);
  return out;
}

// registry-map shape: extract first elements of `["X", handler]` tuples.
export function extractRegistryMapKeys(body: string): Set<string> {
  const out = new Set<string>();
  // `\[\s*"X",\s*<identifier-or-async-arrow-or-paren>` — handler shape varies.
  const re = /\[\s*"([\w-]+)"\s*,\s*(?:[a-zA-Z_$]|async\s|\()/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) out.add(m[1]!);
  return out;
}

// registry-record shape: extract object-literal keys at top indent of body.
// Two-space indent matches the existing convention in src/index.ts.
export function extractRegistryRecordKeys(body: string): Set<string> {
  const out = new Set<string>();
  // Bareword keys followed by ":". Excludes nested object keys via indent
  // restriction (only the outer record's two-space-indented keys).
  const re = /^\s{2}([a-zA-Z_$][\w-]*):\s*/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) out.add(m[1]!);
  return out;
}

// if-else shape (e.g. runNetwork): extract `sub === "X"` literals.
export function extractIfElseSubs(body: string): Set<string> {
  const out = new Set<string>();
  const re = /sub\s*===\s*"([\w-]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) out.add(m[1]!);
  return out;
}

// Parse the (use: a, b, c) listing from a default-case error string.
// Tolerates both "command" and "subcommand" wording.
export function extractListing(body: string, prefix: string): Set<string> | null {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$1");
  const re = new RegExp(
    `unknown\\s+${escaped}\\s+(?:sub)?command:\\s+\\$\\{[^}]+\\}\\s+\\(use:\\s*([^)]*)\\)`,
  );
  const m = body.match(re);
  if (!m) return null;
  const out = new Set<string>();
  for (const raw of m[1]!.split(/,\s*/)) {
    const trimmed = raw.trim();
    if (trimmed) out.add(trimmed);
  }
  return out;
}

// Extract sub-command names documented in USAGE for a given prefix.
// For the top-level "ludics" prefix, return the top-level commands instead
// (matching the existing lint:cli-readme regex).
export function extractUsageSubs(usageBlock: string, prefix: string): Set<string> {
  const out = new Set<string>();
  if (prefix === "ludics") {
    const re = /^\s{1,4}([a-z][\w-]*)\b/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(usageBlock)) !== null) out.add(m[1]!);
    return out;
  }
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$1");
  const re = new RegExp(`^\\s{2,4}${escaped}\\s+([a-z][\\w-]*)\\b`, "gm");
  let m: RegExpExecArray | null;
  while ((m = re.exec(usageBlock)) !== null) out.add(m[1]!);
  return out;
}

function aliasMapsFor(prefix: string): { aliasOf: Map<string, string> } {
  const aliasOf = new Map<string, string>();
  for (const [canonical, alias] of ALIASES[prefix] ?? []) {
    aliasOf.set(alias, canonical);
  }
  return { aliasOf };
}

// Normalise a set: drop empty strings, drop aliases (resolve to canonical),
// drop internal-hidden commands (only when stripping for public comparison).
function normalise(
  set: Set<string>,
  prefix: string,
  options: { stripHidden: boolean },
): Set<string> {
  const { aliasOf } = aliasMapsFor(prefix);
  const hidden = options.stripHidden
    ? new Set(INTERNAL_HIDDEN[prefix] ?? [])
    : new Set<string>();
  const out = new Set<string>();
  for (const x of set) {
    if (!x) continue;
    if (hidden.has(x)) continue;
    const canonical = aliasOf.get(x) ?? x;
    out.add(canonical);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-site invariant check
// ---------------------------------------------------------------------------

export interface SiteResult {
  site: DispatcherSite;
  caseCount: number;          // raw count, useful for floor-count meta-tests
  errors: string[];
  cases: Set<string>;          // raw extracted (pre-normalisation) — for tests
  listing: Set<string> | null; // raw extracted
  usageSubs: Set<string>;      // raw extracted
}

export function extractCasesForSite(
  body: string,
  shape: DispatcherShape,
): Set<string> {
  switch (shape) {
    case "switch":           return extractCasesFromFn(body);
    case "registry-map":     return extractRegistryMapKeys(body);
    case "registry-record":  return extractRegistryRecordKeys(body);
    case "if-else":          return extractIfElseSubs(body);
  }
}

function setDiff<T>(a: Set<T>, b: Set<T>): T[] {
  const out: T[] = [];
  for (const x of a) if (!b.has(x)) out.push(x);
  return out.sort();
}

export function checkSite(
  site: DispatcherSite,
  source: string,
  usageBlock: string,
): SiteResult {
  // Cases come from the shape-appropriate body (array-literal for
  // registry-map, brace body otherwise). The default-case listing always
  // lives inside the function's brace body, so re-extract with `{` for the
  // listing search even when the cases body was an array literal.
  const caseBody = extractNamedBody(source, site.fnName, openBracketFor(site.shape));
  const cases = extractCasesForSite(caseBody, site.shape);
  // Listings always live inside a brace-bodied function. For switch /
  // if-else / registry-record sites, that function is the same as fnName.
  const listing = site.hasListing
    ? extractListing(extractNamedBody(source, site.fnName, "{"), site.prefix)
    : null;
  const usageSubs = extractUsageSubs(usageBlock, site.prefix);

  // For comparison, normalise (alias-resolve, drop empty/hidden).
  // The listing is NOT stripped of hidden entries: that way, if a hidden
  // hook/internal entry leaks back into the user-facing listing, the
  // listing-vs-cases comparison surfaces the leak (listing has it, normCases
  // does not). All current dispatcher listings exclude hidden entries.
  const normCases = normalise(cases, site.prefix, { stripHidden: true });
  const normListing = listing ? normalise(listing, site.prefix, { stripHidden: false }) : null;
  const inlineHandled = new Set(USAGE_INLINE_HANDLED[site.prefix] ?? []);
  const normUsage = new Set(
    [...normalise(usageSubs, site.prefix, { stripHidden: false })].filter((x) => !inlineHandled.has(x)),
  );

  const errors: string[] = [];

  const casesNotInUsage = setDiff(normCases, normUsage);
  if (casesNotInUsage.length > 0) {
    errors.push(
      `[${site.prefix}] implemented but undocumented in USAGE: ${casesNotInUsage.join(", ")}`,
    );
  }

  const usageNotInCases = setDiff(normUsage, normCases);
  if (usageNotInCases.length > 0) {
    errors.push(
      `[${site.prefix}] documented in USAGE but no implementation: ${usageNotInCases.join(", ")}`,
    );
  }

  // hasListing: true means the dispatcher promises a default `(use: …)`
  // listing. If extractListing returned null (the clause is missing or its
  // shape no longer matches the canonical regex), surface that as a
  // violation — silently skipping the comparison would let a regression
  // that drops the listing pass the lint, which is the very drift this
  // script exists to catch.
  if (site.hasListing && listing === null) {
    errors.push(
      `[${site.prefix}] expected canonical default '(use: ...)' listing in ${site.fnName} body, found none — listing must match /unknown ${site.prefix} (sub)?command: \\$\\{var\\} \\(use: …\\)/`,
    );
  }

  if (normListing) {
    const casesNotInListing = setDiff(normCases, normListing);
    if (casesNotInListing.length > 0) {
      errors.push(
        `[${site.prefix}] implemented but missing from default (use: ...) listing: ${casesNotInListing.join(", ")}`,
      );
    }

    const listingNotInCases = setDiff(normListing, normCases);
    if (listingNotInCases.length > 0) {
      errors.push(
        `[${site.prefix}] listed in default (use: ...) but no implementation: ${listingNotInCases.join(", ")}`,
      );
    }
  }

  if (cases.size === 0) {
    errors.push(
      `[${site.prefix}] extractor returned zero cases — regex over ${site.file} (${site.shape}) likely broken; check the lint extractor`,
    );
  }

  return { site, caseCount: cases.size, errors, cases, listing, usageSubs };
}

// ---------------------------------------------------------------------------
// Top-level entry
// ---------------------------------------------------------------------------

export function lintCliSubcommands(
  readSource: (relPath: string) => string,
  indexUsageBlock: string,
): SiteResult[] {
  return DISPATCHERS.map((site) => {
    const src = readSource(site.file);
    return checkSite(site, src, indexUsageBlock);
  });
}

if (import.meta.main) {
  const indexSrc = readFileSync(join(root, "src", "index.ts"), "utf-8");
  const usageBlock = extractUsageBlock(indexSrc);
  const results = lintCliSubcommands(
    (rel) => readFileSync(join(root, rel), "utf-8"),
    usageBlock,
  );

  const allErrors = results.flatMap((r) => r.errors);
  if (allErrors.length === 0) {
    console.log(`✅  CLI sub-command parity holds across ${results.length} dispatchers.`);
    process.exit(0);
  }

  console.error(`\n❌  CLI sub-command drift detected:\n`);
  for (const err of allErrors) {
    console.error(`     - ${err}`);
  }
  console.error(
    `\n   Each error names the prefix and the mismatch class. Fix by either:\n` +
      `     (a) updating the dispatcher source (case / registry key / if-else branch),\n` +
      `     (b) updating src/index.ts USAGE for the prefix, or\n` +
      `     (c) updating the default-case (use: ...) listing in the dispatcher.\n` +
      `   Aliases (e.g. queue-pop, disable, pai) are pinned in scripts/lint-cli-subcommands.ts ALIASES.\n`,
  );
  process.exit(1);
}
