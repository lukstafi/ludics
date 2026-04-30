#!/usr/bin/env bun
/**
 * lint-cli-readme.ts
 *
 * Checks that every command listed in the README CLI Reference section is
 * still present in the USAGE constant in src/index.ts.
 *
 * Exit code (symmetric contract — both directions are fatal):
 *   0 — USAGE in src/index.ts and the README `## CLI Reference` section
 *       list the same set of top-level subcommands.
 *   1 — drift in either direction: a README command missing from USAGE
 *       (stale docs) OR a USAGE command missing from the README CLI
 *       Reference (undocumented). Both produce non-zero exit so CI catches
 *       additions and removals on the same first round.
 */

import { readFileSync } from "fs";
import { join } from "path";

const defaultRoot = join(import.meta.dir, "..");

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit testing)
// ---------------------------------------------------------------------------

// SILENT-DRIFT WARNING (gh-ludics-406):
// `extractUsageCommands` and `extractReadmeCommands` are regex-over-source
// extractors. Their safety claim — "every README CLI Reference command is
// still in USAGE" — depends on the literal patterns below appearing in their
// respective sources. A refactor that builds USAGE programmatically (e.g.
// `commands.map(c => "  " + c.name).join("\n")`) or moves the README CLI
// Reference into a shared markdown partial *deletes* the literals from view.
// The regex still runs, just with fewer hits, and the lint passes silently.
//
// Recognised patterns:
//   USAGE source — `^\s{1,4}([a-z][\w-]*)\b` against the USAGE template
//                  literal body extracted via `extractUsageBlock`.
//   README — `^ludics\s+([a-z][\w-]*)\b` against the `## CLI Reference`
//            section sliced by `extractCliReferenceSection`.
//
// If you change how USAGE or the README CLI Reference is constructed, update
// the patterns AND keep the floor-count tests in
// scripts/lint-cli-readme.test.ts ("extractUsageCommands: floor count …",
// "extractReadmeCommands: floor count …") in sync. The floor-count tests
// are the mechanical guard that catches DRY-only collapses of either side.

// Extract the contents of `const USAGE = \`...\`` as opaque text. Returns the
// string between the opening and closing backticks (or "" if not found).
//
// We use a backtick-aware match rather than scanning for the next `;` because
// the template literal body contains parenthetical semicolons (e.g.
// "cluster.machines);") that would otherwise truncate the block. The body
// pattern `(?:\\[\s\S]|[^`])*` skips over escaped sequences (`\`` etc.) so an
// inline `\`--flag\`` in USAGE doesn't truncate the block early.
//
// Cautionary precedent: PR #429 / gh-ludics-431. The previous `indexOf(";")`
// scan silently truncated USAGE for months, dropping ~12 commands from the
// recognized set. When adding new string-scanning extractors elsewhere, prefer
// non-greedy regex over delimiter-character scans.
export function extractUsageBlock(source: string): string {
  const match = source.match(/const USAGE = `((?:\\[\s\S]|[^`])*)`/);
  return match ? match[1]! : "";
}

// Top-level command names: lines like "  word ..." or "  word\n".
const usageCommandPattern = /^\s{1,4}([a-z][\w-]*)\b/gm;

export function extractUsageCommands(source: string): Set<string> {
  const block = extractUsageBlock(source);
  const commands = new Set<string>();
  let m: RegExpExecArray | null;
  usageCommandPattern.lastIndex = 0;
  while ((m = usageCommandPattern.exec(block)) !== null) {
    commands.add(m[1]!);
  }
  return commands;
}

// Slice out the `## CLI Reference` section (up to the next `## ` heading).
export function extractCliReferenceSection(readme: string): string {
  const start = readme.indexOf("## CLI Reference");
  if (start === -1) return "";
  const next = readme.indexOf("\n## ", start + 1);
  return readme.slice(start, next !== -1 ? next : undefined);
}

// Command names from code-fence lines: "ludics <command> ...".
const readmeCommandPattern = /^ludics\s+([a-z][\w-]*)\b/gm;

export function extractReadmeCommands(readme: string): Set<string> {
  const block = extractCliReferenceSection(readme);
  const commands = new Set<string>();
  let m: RegExpExecArray | null;
  readmeCommandPattern.lastIndex = 0;
  while ((m = readmeCommandPattern.exec(block)) !== null) {
    commands.add(m[1]!);
  }
  return commands;
}

export interface LintResult {
  stale: string[];
  undocumented: string[];
}

export function lintCliReadme(indexSrc: string, readmeSrc: string): LintResult {
  const usageCommands = extractUsageCommands(indexSrc);
  const readmeCommands = extractReadmeCommands(readmeSrc);

  const stale: string[] = [];
  for (const cmd of readmeCommands) {
    if (!usageCommands.has(cmd)) stale.push(cmd);
  }
  const undocumented: string[] = [];
  for (const cmd of usageCommands) {
    if (!readmeCommands.has(cmd)) undocumented.push(cmd);
  }
  return { stale, undocumented };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

if (import.meta.main) {
  // Optional first positional arg overrides the root directory, which lets
  // tests exercise the real CLI exit-code paths against a tmp fixture.
  const argRoot = process.argv[2];
  const root = argRoot ? argRoot : defaultRoot;
  const indexSrc = readFileSync(join(root, "src", "index.ts"), "utf-8");
  const readmeSrc = readFileSync(join(root, "README.md"), "utf-8");
  const { stale, undocumented } = lintCliReadme(indexSrc, readmeSrc);

  if (stale.length > 0) {
    console.error(`\n❌  README CLI Reference contains commands not found in USAGE (stale docs):`);
    for (const cmd of stale) {
      console.error(`     - ${cmd}`);
    }
  }

  if (undocumented.length > 0) {
    console.error(`\n❌  USAGE commands not documented in README ## CLI Reference:`);
    for (const cmd of undocumented) {
      console.error(`     - ${cmd}`);
    }
  }

  if (stale.length === 0 && undocumented.length === 0) {
    console.log("✅  CLI Reference is in sync with USAGE.");
  }

  process.exit(stale.length > 0 || undocumented.length > 0 ? 1 : 0);
}
