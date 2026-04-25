import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { flowBlocked } from "./flow.ts";
import { captureConsoleLog } from "./test-utils.ts";

const ORIGINAL_HARNESS_DIR = process.env.LUDICS_HARNESS_DIR;
let TMP = "";

function harnessDir(): string {
  return join(TMP, "harness");
}

function writeTask(id: string, priority: string, blockedBy: string[]): void {
  const tasksDir = join(harnessDir(), "tasks");
  mkdirSync(tasksDir, { recursive: true });
  const fm = `---
id: ${id}
title: "${id}"
status: ready
priority: ${priority}
deadline: null
dependencies:
  blocks: []
  blocked_by: [${blockedBy.map((b) => `"${b}"`).join(", ")}]
  relates_to: []
  subtask_of: null
project: ludics
context: ludics
---

body
`;
  writeFileSync(join(tasksDir, `${id}.md`), fm);
}

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "ludics-flow-blocked-"));
  process.env.LUDICS_HARNESS_DIR = harnessDir();
  mkdirSync(harnessDir(), { recursive: true });
});

afterEach(() => {
  if (ORIGINAL_HARNESS_DIR === undefined) delete process.env.LUDICS_HARNESS_DIR;
  else process.env.LUDICS_HARNESS_DIR = ORIGINAL_HARNESS_DIR;
  rmSync(TMP, { recursive: true, force: true });
});

describe("flowBlocked", () => {
  test("orders blocked tasks S, A, B, C, D (numeric priority, not lex)", () => {
    // Insert in non-canonical order so the sort has to do real work.
    writeTask("task-c1", "C", ["task-blocker"]);
    writeTask("task-d1", "D", ["task-blocker"]);
    writeTask("task-s1", "S", ["task-blocker"]);
    writeTask("task-b1", "B", ["task-blocker"]);
    writeTask("task-a1", "A", ["task-blocker"]);

    const lines = captureConsoleLog(() => flowBlocked());

    const ids = lines.map((l) => l.split(" ")[0]);
    expect(ids).toEqual(["task-s1", "task-a1", "task-b1", "task-c1", "task-d1"]);
  });

  test("unknown priority sorts after D", () => {
    writeTask("task-d1", "D", ["task-blocker"]);
    writeTask("task-x1", "X", ["task-blocker"]);
    writeTask("task-s1", "S", ["task-blocker"]);

    const lines = captureConsoleLog(() => flowBlocked());

    const ids = lines.map((l) => l.split(" ")[0]);
    expect(ids).toEqual(["task-s1", "task-d1", "task-x1"]);
  });
});
