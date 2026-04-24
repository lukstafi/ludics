import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { surfaceManualIntervention } from "./runner.ts";

const ORIGINAL_HARNESS = process.env.LUDICS_HARNESS_DIR;
let REAL = "";
let DECOY = "";

beforeEach(() => {
  REAL = mkdtempSync(join(tmpdir(), "ludics-surface-real-"));
  DECOY = mkdtempSync(join(tmpdir(), "ludics-surface-decoy-"));
  mkdirSync(join(REAL, "tasks"), { recursive: true });
  mkdirSync(join(DECOY, "tasks"), { recursive: true });
  process.env.LUDICS_HARNESS_DIR = DECOY;
});

afterEach(() => {
  if (ORIGINAL_HARNESS === undefined) delete process.env.LUDICS_HARNESS_DIR;
  else process.env.LUDICS_HARNESS_DIR = ORIGINAL_HARNESS;
  rmSync(REAL, { recursive: true, force: true });
  rmSync(DECOY, { recursive: true, force: true });
});

const TASK_ID = "task-surf-1";
const INITIAL_BODY = [
  "---",
  `id: ${TASK_ID}`,
  "title: Surface test",
  "status: in-progress",
  "---",
  "",
  "# Surface test",
  "",
  "## Questions",
  "",
  "## Context",
  "",
  "Some context.",
].join("\n");

describe("surfaceManualIntervention (harnessDir parametrization)", () => {
  test("writes to the task file under explicit harnessDir, not the LUDICS_HARNESS_DIR decoy", () => {
    const realTaskFile = join(REAL, "tasks", `${TASK_ID}.md`);
    const decoyTaskFile = join(DECOY, "tasks", `${TASK_ID}.md`);
    writeFileSync(realTaskFile, INITIAL_BODY);
    writeFileSync(decoyTaskFile, INITIAL_BODY);

    surfaceManualIntervention(TASK_ID, "- **Real harness question**", REAL);

    const realAfter = readFileSync(realTaskFile, "utf-8");
    const decoyAfter = readFileSync(decoyTaskFile, "utf-8");

    // Real harness was updated: has_questions frontmatter + question appended.
    expect(realAfter).toContain("has_questions: true");
    expect(realAfter).toContain("- **Real harness question**");

    // Decoy was NOT touched (byte-for-byte preserved).
    expect(decoyAfter).toBe(INITIAL_BODY);
    expect(decoyAfter).not.toContain("has_questions: true");
    expect(decoyAfter).not.toContain("Real harness question");
  });

  test("default arg still works via LUDICS_HARNESS_DIR for backward compat", () => {
    const decoyTaskFile = join(DECOY, "tasks", `${TASK_ID}.md`);
    writeFileSync(decoyTaskFile, INITIAL_BODY);

    // No explicit harnessDir → falls back to defaultHarnessDir() → writes to the env-var harness.
    surfaceManualIntervention(TASK_ID, "- **Default fallback question**");

    const decoyAfter = readFileSync(decoyTaskFile, "utf-8");
    expect(decoyAfter).toContain("has_questions: true");
    expect(decoyAfter).toContain("Default fallback question");
  });

  test("is a no-op when the task file is absent under the given harness (cluster-worker branch still reachable)", () => {
    // Neither harness has a task file — local write is skipped, cluster forwarding path runs and is swallowed in standalone mode.
    // Must not throw.
    expect(() => surfaceManualIntervention(TASK_ID, "- **Q**", REAL)).not.toThrow();
  });
});
