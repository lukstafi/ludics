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
// Parse USAGE constant from src/index.ts
// ---------------------------------------------------------------------------

const indexSrc = readFileSync(join(root, "src", "index.ts"), "utf-8");

// Collect every top-level command word that appears at the start of a USAGE
// line (after leading whitespace), before any space or end-of-line.
// The USAGE block looks like:  "  slots ...", "  slot <n> ..."  etc.
const usageStart = indexSrc.indexOf("const USAGE =");
const usageEnd = indexSrc.indexOf(";", usageStart + "const USAGE =".length);
const usageBlock = usageStart !== -1 && usageEnd !== -1
  ? indexSrc.slice(usageStart, usageEnd)
  : "";

// Extract top-level command names: lines like "  word ..." or "  word\n"
const usageCommandPattern = /^\s{1,4}([a-z][\w-]*)\b/gm;
const usageCommands = new Set<string>();
let m: RegExpExecArray | null;
while ((m = usageCommandPattern.exec(usageBlock)) !== null) {
  usageCommands.add(m[1]!);
}

// ---------------------------------------------------------------------------
// Parse README CLI Reference section
// ---------------------------------------------------------------------------

const readmeSrc = readFileSync(join(root, "README.md"), "utf-8");

// Find the "## CLI Reference" section and collect until the next "## " heading.
const cliRefStart = readmeSrc.indexOf("## CLI Reference");
const nextSection = readmeSrc.indexOf("\n## ", cliRefStart + 1);
const cliBlock = cliRefStart !== -1
  ? readmeSrc.slice(cliRefStart, nextSection !== -1 ? nextSection : undefined)
  : "";

// Extract command names from code-fence lines: "ludics <command> ..."
const readmeCommandPattern = /^ludics\s+([a-z][\w-]*)\b/gm;
const readmeCommands = new Set<string>();
while ((m = readmeCommandPattern.exec(cliBlock)) !== null) {
  readmeCommands.add(m[1]!);
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

let errors = 0;

// Stale docs: README mentions a command not in USAGE  (error — docs are wrong)
const stale: string[] = [];
for (const cmd of readmeCommands) {
  if (!usageCommands.has(cmd)) {
    stale.push(cmd);
    errors++;
  }
}

// Undocumented: USAGE has a command not in README  (warning — just FYI)
const undocumented: string[] = [];
for (const cmd of usageCommands) {
  if (!readmeCommands.has(cmd)) {
    undocumented.push(cmd);
  }
}

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

if (errors === 0 && undocumented.length === 0) {
  console.log("✅  CLI Reference is in sync with USAGE.");
} else if (errors === 0) {
  console.log("✅  No stale docs found (some commands are undocumented — see warnings above).");
}

process.exit(errors > 0 ? 1 : 0);
