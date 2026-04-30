import { describe, test, expect } from "bun:test";
import { spawnSync } from "bun";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  extractWorkerFields,
  extractOrchestratorFields,
  diffFields,
  lintPair,
  hasOrchestratorRoutingSection,
  runCli,
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

  test("worker-only `task_id` drift is downgraded to a warning (idiom tolerance)", () => {
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

  test("orchestrator-only `task_id` drift is an error (worker dropped required field)", () => {
    // Worker accidentally omits `task_id`; orchestrator still expects it.
    const brokenWorker = [
      "### Response Contract",
      "",
      "1. `status` — string, required.",
      "2. `summary` — string, required.",
    ].join("\n");
    const { errors, warnings } = lintPair(brokenWorker, VALID_ORCH_MD);
    expect(warnings).toEqual([]);
    expect(errors).toEqual([
      { category: "orchestrator-only-field", field: "task_id" },
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
// runCli — temp-fixture directory tests for the discovery + reporting layer
// ---------------------------------------------------------------------------

/** Build an isolated skills directory under tmpdir and return its path. */
function makeFixture(files: Record<string, string>): {
  dir: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "lint-contracts-"));
  const skills = join(dir, "skills");
  mkdirSync(skills, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(skills, name), body);
  }
  return {
    dir: skills,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Drive runCli and collect its stderr/stdout lines in-process. */
function driveRunCli(skillsDir: string): {
  exitCode: number;
  err: string[];
  out: string[];
  errorCount: number;
  warningCount: number;
} {
  const err: string[] = [];
  const out: string[] = [];
  const result = runCli({
    skillsDir,
    writeErr: (m) => err.push(m),
    writeOut: (m) => out.push(m),
  });
  return {
    exitCode: result.exitCode,
    err,
    out,
    errorCount: result.errorCount,
    warningCount: result.warningCount,
  };
}

const FIXTURE_WORKER_MD = [
  "### Response Contract",
  "",
  "1. `status` — string, required.",
  "2. `task_id` — string, required.",
  "3. `summary` — string, required.",
  "",
].join("\n");

const FIXTURE_ORCH_MD = [
  "## Status routing",
  "",
  "| Field | Used for | Missing-field fallback |",
  "|---|---|---|",
  "| `status` | primary routing | error |",
  "| `summary` | result context | empty string |",
  "| `task_id` | — | not consumed |",
  "",
].join("\n");

describe("runCli", () => {
  test("clean paired fixture exits 0 with no warnings", () => {
    const { dir, cleanup } = makeFixture({
      "ludics-foo-worker.md": FIXTURE_WORKER_MD,
      "ludics-foo.md": FIXTURE_ORCH_MD,
    });
    try {
      const { exitCode, err, errorCount, warningCount } = driveRunCli(dir);
      expect(exitCode).toBe(0);
      expect(errorCount).toBe(0);
      expect(warningCount).toBe(0);
      expect(err).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("forward unpaired: worker with no orchestrator → warning, exit 0", () => {
    const { dir, cleanup } = makeFixture({
      "ludics-lonely-worker.md": FIXTURE_WORKER_MD,
    });
    try {
      const r = driveRunCli(dir);
      expect(r.exitCode).toBe(0);
      expect(r.errorCount).toBe(0);
      expect(r.warningCount).toBe(1);
      expect(
        r.err.some((line) =>
          line.includes("worker-without-orchestrator") &&
          line.includes("ludics-lonely-worker.md"),
        ),
      ).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("reverse unpaired: orchestrator-style file with no worker → warning, exit 0", () => {
    const { dir, cleanup } = makeFixture({
      "ludics-stranded.md": FIXTURE_ORCH_MD,
    });
    try {
      const r = driveRunCli(dir);
      expect(r.exitCode).toBe(0);
      expect(r.errorCount).toBe(0);
      expect(r.warningCount).toBe(1);
      expect(
        r.err.some((line) =>
          line.includes("orchestrator-without-worker") &&
          line.includes("ludics-stranded.md"),
        ),
      ).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("inline skill (no routing heading) is silently excluded from reverse sweep", () => {
    const inlineMd = [
      "# Inline skill",
      "",
      "## Process",
      "",
      "Do stuff. No routing heading here.",
      "",
    ].join("\n");
    const { dir, cleanup } = makeFixture({
      "ludics-inline.md": inlineMd,
    });
    try {
      const r = driveRunCli(dir);
      expect(r.exitCode).toBe(0);
      expect(r.errorCount).toBe(0);
      expect(r.warningCount).toBe(0);
      expect(
        r.err.some((line) => line.includes("ludics-inline.md")),
      ).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("paired drift: extra worker field → exit 1 with worker-only-field error", () => {
    const driftingWorker = [
      "### Response Contract",
      "",
      "1. `status` — string, required.",
      "2. `task_id` — string, required.",
      "3. `summary` — string, required.",
      "4. `rogue_field` — string, required.",
      "",
    ].join("\n");
    const { dir, cleanup } = makeFixture({
      "ludics-drifty-worker.md": driftingWorker,
      "ludics-drifty.md": FIXTURE_ORCH_MD,
    });
    try {
      const r = driveRunCli(dir);
      expect(r.exitCode).toBe(1);
      expect(r.errorCount).toBe(1);
      expect(
        r.err.some((line) =>
          line.includes("worker-only-field") &&
          line.includes("rogue_field") &&
          line.includes("[ludics-drifty]"),
        ),
      ).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("mixed fixture: drift + unpaired + inline all reported correctly", () => {
    const driftingWorker = [
      "### Response Contract",
      "",
      "1. `status` — string, required.",
      "2. `task_id` — string, required.",
      "3. `summary` — string, required.",
      "4. `extra_a` — string, required.",
      "",
    ].join("\n");
    const inlineMd = "# Inline\n\n## Process\n\nnothing.\n";
    const { dir, cleanup } = makeFixture({
      "ludics-drifty-worker.md": driftingWorker,
      "ludics-drifty.md": FIXTURE_ORCH_MD,
      "ludics-lonely-worker.md": FIXTURE_WORKER_MD,
      "ludics-stranded.md": FIXTURE_ORCH_MD,
      "ludics-inline.md": inlineMd,
    });
    try {
      const r = driveRunCli(dir);
      expect(r.exitCode).toBe(1);
      expect(r.errorCount).toBe(1);
      // 2 file-level warnings: worker-without-orchestrator, orchestrator-without-worker.
      expect(r.warningCount).toBe(2);
      expect(r.err.some((l) => l.includes("worker-without-orchestrator"))).toBe(true);
      expect(r.err.some((l) => l.includes("orchestrator-without-worker"))).toBe(true);
      expect(r.err.some((l) => l.includes("ludics-inline.md"))).toBe(false);
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Integration — drive the real CLI against the real repo
// ---------------------------------------------------------------------------

describe("integration", () => {
  test("lint-contracts: no errors, warning count pinned", () => {
    const repo = join(import.meta.dir, "..");
    const result = runCli({
      skillsDir: join(repo, "skills"),
      writeErr: () => {},
      writeOut: () => {},
    });
    expect(result.errorCount).toBe(0);
    // When this fails: either a new skill pair introduced a worker/orchestrator
    // field-contract drift (regression — fix the pair) OR a matcher improvement
    // found new real-world hits (coverage upgrade — justify and update the
    // count).
    expect(result.warningCount).toBe(0);
  });

  // Floor-count guards for the two regex-over-markdown extractors
  // (gh-ludics-406). Per-pair field counts are small (5–10), so the
  // assertion is on the **total field count summed across all paired skill
  // files** in the real skills/ directory — that aggregate is the
  // meaningful integrity signal. Mirrors the meta-test pattern in
  // scripts/lint-template-safety.test.ts. Failure here means **either**:
  //   (a) a docs refactor collapsed contract surfaces — e.g. the
  //       `### Response Contract` numbered list moved into a shared partial
  //       or routing tables were generated rather than authored — update the
  //       extractor and re-run;
  //   (b) skill pairs were intentionally consolidated/removed — lower the
  //       floor and note what moved in this comment.
  // Today both totals are 37 across 5 paired skills. Floors are set to 25
  // each with slack to tolerate skill churn.
  function sumPairedFields(skillsDir: string): { worker: number; orch: number } {
    let worker = 0;
    let orch = 0;
    const entries = readdirSync(skillsDir);
    for (const f of entries) {
      if (!/^ludics-.*-worker\.md$/.test(f)) continue;
      const orchFile = f.replace(/-worker\.md$/, ".md");
      try {
        const wMd = readFileSync(join(skillsDir, f), "utf-8");
        const oMd = readFileSync(join(skillsDir, orchFile), "utf-8");
        worker += extractWorkerFields(wMd).fields.size;
        orch += extractOrchestratorFields(oMd).fields.size;
      } catch {
        // missing orchestrator counterpart — skip; covered by the
        // worker-without-orchestrator warning in runCli.
      }
    }
    return { worker, orch };
  }

  test("extractWorkerFields: floor count of 25 across paired skills", () => {
    const repo = join(import.meta.dir, "..");
    const { worker } = sumPairedFields(join(repo, "skills"));
    expect(worker).toBeGreaterThanOrEqual(25);
  });

  test("extractOrchestratorFields: floor count of 25 across paired skills", () => {
    const repo = join(import.meta.dir, "..");
    const { orch } = sumPairedFields(join(repo, "skills"));
    expect(orch).toBeGreaterThanOrEqual(25);
  });
});

// ---------------------------------------------------------------------------
// CLI integration — drive the real script against tmp-fixture skills dirs
// so the `import.meta.main` exit-code branches are observable.
// ---------------------------------------------------------------------------

describe("CLI integration", () => {
  test("exits 0 against a clean paired tmp fixture (drives import.meta.main)", () => {
    const { dir, cleanup } = makeFixture({
      "ludics-foo-worker.md": FIXTURE_WORKER_MD,
      "ludics-foo.md": FIXTURE_ORCH_MD,
    });
    try {
      const result = spawnSync({
        cmd: ["bun", "run", join(import.meta.dir, "lint-contracts.ts"), dir],
        cwd: join(import.meta.dir, ".."),
        stdout: "pipe",
        stderr: "pipe",
      });
      if (result.exitCode !== 0) {
        console.error(result.stderr.toString());
        console.error(result.stdout.toString());
      }
      expect(result.exitCode).toBe(0);
    } finally {
      cleanup();
    }
  });

  test("exits non-zero against a tmp fixture with worker-only-field drift", () => {
    const driftingWorker = [
      "### Response Contract",
      "",
      "1. `status` — string, required.",
      "2. `task_id` — string, required.",
      "3. `summary` — string, required.",
      "4. `rogue_field` — string, required.",
      "",
    ].join("\n");
    const { dir, cleanup } = makeFixture({
      "ludics-drifty-worker.md": driftingWorker,
      "ludics-drifty.md": FIXTURE_ORCH_MD,
    });
    try {
      const result = spawnSync({
        cmd: ["bun", "run", join(import.meta.dir, "lint-contracts.ts"), dir],
        cwd: join(import.meta.dir, ".."),
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode).not.toBe(0);
    } finally {
      cleanup();
    }
  });
});
