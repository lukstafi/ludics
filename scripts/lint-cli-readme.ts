#!/usr/bin/env bun
/**
 * lint-cli-readme.ts
 *
 * Checks that every command listed in the README CLI Reference section is
 * still present in the USAGE constant in src/index.ts.
 *
 * Exit code:
 *   0 — no stale-doc errors (warnings about undocumented commands are non-fatal)
 *   1 — one or more README commands not found in USAGE (documentation drift)
 */

import { readFileSync } from "fs";
import { join } from "path";

const root = join(import.meta.dir, "..");

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit testing)
// ---------------------------------------------------------------------------

// Extract the contents of `const USAGE = \`...\`` as opaque text. Returns the
// string between the opening and closing backticks (or "" if not found).
//
// We use a backtick-aware match rather than scanning for the next `;` because
// the template literal body contains parenthetical semicolons (e.g.
// "cluster.machines);") that would otherwise truncate the block.
export function extractUsageBlock(source: string): string {
  const match = source.match(/const USAGE = `([\s\S]*?)`/);
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
    console.warn(`\n⚠️   USAGE commands not documented in README (undocumented — warnings only):`);
    for (const cmd of undocumented) {
      console.warn(`     - ${cmd}`);
    }
  }

  if (stale.length === 0 && undocumented.length === 0) {
    console.log("✅  CLI Reference is in sync with USAGE.");
  } else if (stale.length === 0) {
    console.log("✅  No stale docs found (some commands are undocumented — see warnings above).");
  }

  process.exit(stale.length > 0 ? 1 : 0);
}
