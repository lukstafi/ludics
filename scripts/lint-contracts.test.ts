import { describe, test, expect } from "bun:test";
import { spawnSync } from "bun";
import { join } from "path";
import {
  extractWorkerFields,
  extractOrchestratorFields,
  diffFields,
  lintPair,
  hasOrchestratorRoutingSection,
} from "./lint-contracts.ts";

// ---------------------------------------------------------------------------
// extractWorkerFields
// ---------------------------------------------------------------------------

describe("extractWorkerFields", () => {
  test("happy path — numbered list under Response Contract", () => {
    const md = [
      "## Final Response",
      "",
      "### Response Contract",
      "",
      "1. `status` — string, required.",
      "2. `foo_bar` — string, required.",
      "",
      "## Error Handling",
      "",
      "1. `ignored` — outside section.",
    ].join("\n");
    const { fields, hasSection } = extractWorkerFields(md);
    expect(hasSection).toBe(true);
    expect([...fields].sort()).toEqual(["foo_bar", "status"]);
  });

  test("skips identifiers inside ```json fenced blocks", () => {
    const md = [
      "### Response Contract",
      "",
      "1. `status` — string, required.",
      "",
      "```json",
      "{",
      '  "status": "completed",',
      '  "leaked_field": "nope"',
      "}",
      "```",
      "",
      "2. `real_field` — string, required.",
    ].join("\n");
    const { fields } = extractWorkerFields(md);
    expect([...fields].sort()).toEqual(["real_field", "status"]);
  });

  test("ignores continuation lines with inline backticks", () => {
    const md = [
      "### Response Contract",
      "",
      "1. `skip_plan` — boolean, optional. Present only when `status = \"completed\"`.",
      "   Set to `true` when the proposal is exhaustive. When `true`, the",
      "   orchestrator writes `skip_plan: true` to task frontmatter.",
      "2. `status` — string, required.",
    ].join("\n");
    const { fields } = extractWorkerFields(md);
    expect([...fields].sort()).toEqual(["skip_plan", "status"]);
  });

  test("returns hasSection=false when heading is missing", () => {
    const md = "# Hello\n\nFree-form content, no Response Contract here.\n";
    const { fields, hasSection } = extractWorkerFields(md);
    expect(hasSection).toBe(false);
    expect(fields.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// extractOrchestratorFields
// ---------------------------------------------------------------------------

describe("extractOrchestratorFields", () => {
  test("parses Status routing table, skips header/separator", () => {
    const md = [
      "## Status routing",
      "",
      "Fields:",
      "",
      "| Field | Used for | Missing-field fallback |",
      "|---|---|---|",
      "| `status` | primary routing | error |",
      "| `task_id` | — | not consumed |",
      "",
      "## Next section",
      "",
      "| `ignored` | outside section | — |",
    ].join("\n");
    const { fields, hasSection } = extractOrchestratorFields(md);
    expect(hasSection).toBe(true);
    expect([...fields].sort()).toEqual(["status", "task_id"]);
  });

  test("parses Verdict routing table (verify-completion variant)", () => {
    const md = [
      "## Verdict routing",
      "",
      "| Field | Used for | Missing-field fallback |",
      "|---|---|---|",
      "| `verdict` | primary routing | error |",
      "| `slot` | slot clearing | error |",
    ].join("\n");
    const { fields, hasSection } = extractOrchestratorFields(md);
    expect(hasSection).toBe(true);
    expect([...fields].sort()).toEqual(["slot", "verdict"]);
  });

  test("returns hasSection=false when neither heading is present", () => {
    const md = "## Something else\n\n| `x` | — | — |\n";
    const { fields, hasSection } = extractOrchestratorFields(md);
    expect(hasSection).toBe(false);
    expect(fields.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// diffFields
// ---------------------------------------------------------------------------

describe("diffFields", () => {
  test("directional mismatches are reported correctly and sorted", () => {
    const worker = new Set(["a", "c", "b"]);
    const orch = new Set(["b", "d"]);
    const { workerOnly, orchOnly } = diffFields(worker, orch);
    expect(workerOnly).toEqual(["a", "c"]);
    expect(orchOnly).toEqual(["d"]);
  });

  test("returns empty arrays when in sync", () => {
    const both = new Set(["x", "y"]);
    const { workerOnly, orchOnly } = diffFields(both, new Set(both));
    expect(workerOnly).toEqual([]);
    expect(orchOnly).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// lintPair — category-based assertions
// ---------------------------------------------------------------------------

const VALID_WORKER_MD = [
  "### Response Contract",
  "",
  "1. `status` — string, required.",
  "2. `task_id` — string, required.",
  "3. `summary` — string, required.",
].join("\n");

const VALID_ORCH_MD = [
  "## Status routing",
  "",
  "| Field | Used for | Missing-field fallback |",
  "|---|---|---|",
  "| `status` | primary routing | error |",
  "| `summary` | result context | empty string |",
  "| `task_id` | — | not consumed |",
].join("\n");

describe("lintPair", () => {
  test("clean pair produces no errors and no warnings", () => {
    const { errors, warnings } = lintPair(VALID_WORKER_MD, VALID_ORCH_MD);
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
  });

  test("worker missing section short-circuits with exactly one warning", () => {
    const brokenWorker = "# Worker\n\nNo Response Contract here.\n";
    const { errors, warnings } = lintPair(brokenWorker, VALID_ORCH_MD);
    expect(errors).toEqual([]);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toEqual({ category: "worker-missing-section" });
    // No field-level entries — the diff must have been skipped.
    expect(warnings.some((w) => w.field !== undefined)).toBe(false);
    // Sanity: extractor agrees the section is missing.
    expect(extractWorkerFields(brokenWorker).hasSection).toBe(false);
  });

  test("orchestrator missing section short-circuits with exactly one warning", () => {
    const brokenOrch = "# Orchestrator\n\nNo routing section here.\n";
    const { errors, warnings } = lintPair(VALID_WORKER_MD, brokenOrch);
    expect(errors).toEqual([]);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toEqual({ category: "orchestrator-missing-section" });
    // No worker-only-field errors — the diff must have been skipped.
    expect(warnings.some((w) => w.field !== undefined)).toBe(false);
    expect(errors.some((e) => e.field !== undefined)).toBe(false);
    expect(extractOrchestratorFields(brokenOrch).hasSection).toBe(false);
  });

  test("both missing sections produces two warnings and no errors", () => {
    const { errors, warnings } = lintPair(
      "# Worker\n\nnothing\n",
      "# Orchestrator\n\nnothing\n",
    );
    expect(errors).toEqual([]);
    expect(warnings.map((w) => w.category).sort()).toEqual([
      "orchestrator-missing-section",
      "worker-missing-section",
    ]);
  });

  test("field drift surfaces as worker-only-field error", () => {
    const worker = [
      "### Response Contract",
      "",
      "1. `status` — string, required.",
      "2. `task_id` — string, required.",
      "3. `summary` — string, required.",
      "4. `extra_field` — string, required.",
    ].join("\n");
    const { errors, warnings } = lintPair(worker, VALID_ORCH_MD);
    expect(errors).toEqual([
      { category: "worker-only-field", field: "extra_field" },
    ]);
    expect(warnings).toEqual([]);
  });

  test("orchestrator-only field surfaces as error", () => {
    const orch = [
      "## Status routing",
      "",
      "| Field | Used for | Missing-field fallback |",
      "|---|---|---|",
      "| `status` | primary routing | error |",
      "| `summary` | result context | empty string |",
      "| `rogue_field` | mystery | — |",
      "| `task_id` | — | not consumed |",
    ].join("\n");
    const { errors, warnings } = lintPair(VALID_WORKER_MD, orch);
    expect(errors).toEqual([
      { category: "orchestrator-only-field", field: "rogue_field" },
    ]);
    expect(warnings).toEqual([]);
  });

  test("task_id-only drift is downgraded to a warning", () => {
    const orch = [
      "## Status routing",
      "",
      "| Field | Used for | Missing-field fallback |",
      "|---|---|---|",
      "| `status` | primary routing | error |",
      "| `summary` | result context | empty string |",
    ].join("\n");
    const { errors, warnings } = lintPair(VALID_WORKER_MD, orch);
    expect(errors).toEqual([]);
    expect(warnings).toEqual([
      { category: "worker-only-field", field: "task_id" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// hasOrchestratorRoutingSection (reverse-sweep heuristic)
// ---------------------------------------------------------------------------

describe("hasOrchestratorRoutingSection", () => {
  test("true when ## Status routing is present", () => {
    expect(hasOrchestratorRoutingSection("## Status routing\n")).toBe(true);
  });
  test("true when ## Verdict routing is present", () => {
    expect(hasOrchestratorRoutingSection("## Verdict routing\n")).toBe(true);
  });
  test("false for inline skill without routing heading", () => {
    const md = "# Some inline skill\n\n## Process\n\nStuff.\n";
    expect(hasOrchestratorRoutingSection(md)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Integration — drive the real CLI against the real repo
// ---------------------------------------------------------------------------

describe("integration", () => {
  test("lint-contracts exits 0 on current repo", () => {
    const result = spawnSync({
      cmd: ["bun", "run", join(import.meta.dir, "lint-contracts.ts")],
      cwd: join(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) {
      console.error(result.stderr.toString());
      console.error(result.stdout.toString());
    }
    expect(result.exitCode).toBe(0);
  });
});
