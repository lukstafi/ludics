#!/usr/bin/env bun
/**
 * lint-contracts.ts
 *
 * Detects field-name drift between worker and orchestrator skill pairs.
 *
 * For each `skills/ludics-<name>-worker.md` it expects a sibling
 * `skills/ludics-<name>.md`, and checks that the field names declared in the
 * worker's `### Response Contract` numbered list match the field names listed
 * in the orchestrator's `## Status routing` or `## Verdict routing` markdown
 * table. Also sweeps the reverse direction to catch orchestrator-style files
 * without a worker sibling.
 *
 * Exit code:
 *   0 — clean (any reported items were warnings)
 *   1 — one or more pairs has field-name drift
 */

import { readdirSync, readFileSync, existsSync } from "fs";
import { join, basename } from "path";

const root = join(import.meta.dir, "..");
const skillsDir = join(root, "skills");

// ---------------------------------------------------------------------------
// Pure extractors (exported for tests)
// ---------------------------------------------------------------------------

export interface ExtractResult {
  fields: Set<string>;
  hasSection: boolean;
}

/**
 * Collect backtick-quoted identifiers from the numbered list under
 * `### Response Contract`. Returns `hasSection: false` when the heading is
 * not found (caller short-circuits the pair).
 */
export function extractWorkerFields(md: string): ExtractResult {
  const lines = md.split("\n");
  const fields = new Set<string>();

  let inSection = false;
  let inFence = false;
  let found = false;

  for (const line of lines) {
    if (!inSection) {
      if (/^###\s+Response Contract\s*$/.test(line)) {
        inSection = true;
        found = true;
      }
      continue;
    }
    // Leaving on the next `##` or `###` heading.
    if (/^#{2,3}\s+\S/.test(line)) break;

    // Toggle fenced-block state; never harvest identifiers inside fences.
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const m = /^\s*\d+\.\s+`([a-z_][\w]*)`/.exec(line);
    if (m) fields.add(m[1]!);
  }

  return { fields, hasSection: found };
}

/**
 * Collect backtick-quoted identifiers from the first-column cells of the
 * markdown table under `## Status routing` or `## Verdict routing`.
 */
export function extractOrchestratorFields(md: string): ExtractResult {
  const lines = md.split("\n");
  const fields = new Set<string>();

  let inSection = false;
  let found = false;

  for (const line of lines) {
    if (!inSection) {
      if (/^##\s+(Status|Verdict) routing\s*$/.test(line)) {
        inSection = true;
        found = true;
      }
      continue;
    }
    if (/^##\s+\S/.test(line)) break;

    const m = /^\|\s*`([a-z_][\w]*)`\s*\|/.exec(line);
    if (m) fields.add(m[1]!);
  }

  return { fields, hasSection: found };
}

/** Sorted set-difference pair. */
export function diffFields(
  worker: Set<string>,
  orch: Set<string>,
): { workerOnly: string[]; orchOnly: string[] } {
  const workerOnly = [...worker].filter((f) => !orch.has(f)).sort();
  const orchOnly = [...orch].filter((f) => !worker.has(f)).sort();
  return { workerOnly, orchOnly };
}

// ---------------------------------------------------------------------------
// lintPair — structured per-pair result (exported for tests)
// ---------------------------------------------------------------------------

export type LintCategory =
  | "worker-missing-section"
  | "orchestrator-missing-section"
  | "worker-only-field"
  | "orchestrator-only-field";

export interface LintIssue {
  category: LintCategory;
  field?: string;
}

export interface PairResult {
  errors: LintIssue[];
  warnings: LintIssue[];
}

/**
 * Compare a worker markdown and its paired orchestrator markdown.
 *
 * Missing-section semantics (canonical rule): if either side is missing its
 * target section, emit the corresponding `*-missing-section` warning and
 * short-circuit — field diffing is skipped entirely for this pair. This
 * matches AC 11 ("missing sections produce warnings, non-fatal") and prevents
 * a missing section from cascading into a `worker-only-field` error per
 * field.
 *
 * `task_id` is a special case (AC 9): a worker-only-field mismatch where
 * `field === "task_id"` is emitted as a warning rather than an error, because
 * orchestrator tables conventionally list it as "not consumed" and sometimes
 * omit it entirely.
 */
export function lintPair(workerMd: string, orchMd: string): PairResult {
  const result: PairResult = { errors: [], warnings: [] };

  const w = extractWorkerFields(workerMd);
  const o = extractOrchestratorFields(orchMd);

  let shortCircuit = false;
  if (!w.hasSection) {
    result.warnings.push({ category: "worker-missing-section" });
    shortCircuit = true;
  }
  if (!o.hasSection) {
    result.warnings.push({ category: "orchestrator-missing-section" });
    shortCircuit = true;
  }
  if (shortCircuit) return result;

  const { workerOnly, orchOnly } = diffFields(w.fields, o.fields);

  for (const field of workerOnly) {
    const issue: LintIssue = { category: "worker-only-field", field };
    if (field === "task_id") result.warnings.push(issue);
    else result.errors.push(issue);
  }
  for (const field of orchOnly) {
    const issue: LintIssue = { category: "orchestrator-only-field", field };
    if (field === "task_id") result.warnings.push(issue);
    else result.errors.push(issue);
  }

  return result;
}

// ---------------------------------------------------------------------------
// File-discovery helpers (exported for tests)
// ---------------------------------------------------------------------------

const REVERSE_EXCLUDE = new Set([
  "worker-conventions.md",
  "orchestrator-conventions.md",
]);

/**
 * Does this orchestrator-candidate file look like an orchestrator (i.e.
 * contains `## Status routing` or `## Verdict routing`)? Files without either
 * heading are treated as inline skills and silently excluded from the
 * reverse sweep.
 */
export function hasOrchestratorRoutingSection(md: string): boolean {
  return /^##\s+(Status|Verdict) routing\s*$/m.test(md);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface FileIssue {
  category:
    | "worker-without-orchestrator"
    | "orchestrator-without-worker";
  path: string;
}

interface PairReport {
  pair: string;
  issues: PairResult;
}

function runCli(): number {
  const entries = readdirSync(skillsDir);
  const workerFiles = entries.filter((f) => /^ludics-.*-worker\.md$/.test(f));

  const fileWarnings: FileIssue[] = [];
  const pairReports: PairReport[] = [];

  // Forward sweep: worker → orchestrator.
  const pairedOrchestrators = new Set<string>();
  for (const wFile of workerFiles) {
    const orchFile = wFile.replace(/-worker\.md$/, ".md");
    const wPath = join(skillsDir, wFile);
    const oPath = join(skillsDir, orchFile);

    if (!existsSync(oPath)) {
      fileWarnings.push({
        category: "worker-without-orchestrator",
        path: wFile,
      });
      continue;
    }
    pairedOrchestrators.add(orchFile);

    const wMd = readFileSync(wPath, "utf-8");
    const oMd = readFileSync(oPath, "utf-8");
    const pairName = orchFile.replace(/\.md$/, "");
    pairReports.push({ pair: pairName, issues: lintPair(wMd, oMd) });
  }

  // Reverse sweep: orchestrator-candidate → worker.
  const reverseCandidates = entries.filter(
    (f) =>
      f.startsWith("ludics-") &&
      f.endsWith(".md") &&
      !f.endsWith("-worker.md") &&
      !REVERSE_EXCLUDE.has(f) &&
      !pairedOrchestrators.has(f),
  );
  for (const oFile of reverseCandidates) {
    const md = readFileSync(join(skillsDir, oFile), "utf-8");
    if (!hasOrchestratorRoutingSection(md)) continue; // inline skill
    fileWarnings.push({
      category: "orchestrator-without-worker",
      path: oFile,
    });
  }

  // Reporting.
  let errorCount = 0;
  let warningCount = 0;

  for (const { pair, issues } of pairReports) {
    for (const err of issues.errors) {
      errorCount++;
      const fieldNote = err.field ? ` (field: ${err.field})` : "";
      console.error(`❌  [${pair}] ${err.category}${fieldNote}`);
    }
    for (const warn of issues.warnings) {
      warningCount++;
      const fieldNote = warn.field ? ` (field: ${warn.field})` : "";
      console.error(`⚠️   [${pair}] ${warn.category}${fieldNote}`);
    }
  }
  for (const fw of fileWarnings) {
    warningCount++;
    console.error(`⚠️   ${fw.category}: ${fw.path}`);
  }

  if (errorCount === 0) {
    const suffix = warningCount > 0 ? ` (${warningCount} warning${warningCount === 1 ? "" : "s"})` : "";
    console.log(`✅  Worker/orchestrator field contracts are in sync${suffix}.`);
    return 0;
  }
  console.error(`\n${errorCount} error${errorCount === 1 ? "" : "s"}, ${warningCount} warning${warningCount === 1 ? "" : "s"}.`);
  return 1;
}

// Run as a CLI when invoked directly; stay silent when imported from tests.
if (import.meta.main) {
  process.exit(runCli());
}

// Exported for integration tests that want to drive the CLI in-process if
// needed, but the main recipe for tests is to import the pure helpers above.
export { runCli };
// Silence the unused-basename import when this module is used only as a
// library in tests (tree-shaking does not run on bun runtime).
void basename;
