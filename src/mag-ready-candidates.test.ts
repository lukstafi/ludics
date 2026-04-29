import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { getSortedReadyCandidates } from "./mag.ts";

let tmpDir: string;
const ORIGINAL_HARNESS_DIR = process.env.LUDICS_HARNESS_DIR;
const ORIGINAL_CONFIG = process.env.LUDICS_CONFIG;
const ORIGINAL_CLUSTER_NAME = process.env.LUDICS_CLUSTER_MACHINE_NAME;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ludics-ready-candidates-"));
  mkdirSync(join(tmpDir, "tasks"), { recursive: true });
  mkdirSync(join(tmpDir, "slots"), { recursive: true });
  process.env.LUDICS_HARNESS_DIR = tmpDir;
  delete process.env.LUDICS_CONFIG;
  delete process.env.LUDICS_CLUSTER_MACHINE_NAME;
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  if (ORIGINAL_HARNESS_DIR === undefined) delete process.env.LUDICS_HARNESS_DIR;
  else process.env.LUDICS_HARNESS_DIR = ORIGINAL_HARNESS_DIR;
  if (ORIGINAL_CONFIG === undefined) delete process.env.LUDICS_CONFIG;
  else process.env.LUDICS_CONFIG = ORIGINAL_CONFIG;
  if (ORIGINAL_CLUSTER_NAME === undefined) delete process.env.LUDICS_CLUSTER_MACHINE_NAME;
  else process.env.LUDICS_CLUSTER_MACHINE_NAME = ORIGINAL_CLUSTER_NAME;
});

function writeTask(id: string, fm: Record<string, string | boolean>): void {
  const lines = ["---", `id: ${id}`, `title: ${id}`];
  for (const [k, v] of Object.entries(fm)) {
    lines.push(`${k}: ${v}`);
  }
  if (!("status" in fm)) lines.push("status: ready");
  if (!("priority" in fm)) lines.push("priority: B");
  if (!("project" in fm)) lines.push("project: ludics");
  lines.push("dependencies:");
  lines.push("  blocks: []");
  lines.push("  blocked_by: []");
  lines.push("  relates_to: []");
  lines.push("  subtask_of: null");
  lines.push("effort: small");
  lines.push("context: ludics");
  lines.push("uses_browser: false");
  lines.push("created: 2026-04-29");
  lines.push("source: manual");
  lines.push("---", "", `# ${id}`, "");
  writeFileSync(join(tmpDir, "tasks", `${id}.md`), lines.join("\n"));
}

describe("getSortedReadyCandidates leaf filter (AC2)", () => {
  test("excludes leaf: false containers; retains plain leaf tasks and explicit leaf: true", () => {
    // Harness condition: three ready tasks differing only in the `leaf` field.
    // If any of the three were missing or the directory empty, the assertions
    // below would not exercise the AC's "filter out containers" path.
    writeTask("task-leaf-plain", {});
    writeTask("task-container", { leaf: false });
    writeTask("task-leaf-explicit", { leaf: true });

    const ids = getSortedReadyCandidates().map((c) => c.id).sort();

    // Invariant: leaf===false MUST be filtered (the AC2 rule). If the filter
    // is removed, this assertion flips because the container would appear.
    expect(ids).not.toContain("task-container");
    // Invariant: legacy tasks (no leaf field) MUST remain — this is the
    // "absent !== false" property the parser guard depends on.
    expect(ids).toContain("task-leaf-plain");
    // Invariant: leaf===true is unfiltered — confirms `=== false`, not falsy.
    expect(ids).toContain("task-leaf-explicit");
  });

  test("a single-task harness containing only a container produces an empty candidate list", () => {
    // Harness condition: only one task exists, and it is a container. If the
    // filter were absent, the candidate list would have one element.
    writeTask("task-only-container", { leaf: false });

    expect(getSortedReadyCandidates()).toEqual([]);
  });
});
