import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { taskFilePath } from "./paths.ts";

const ORIGINAL_HARNESS = process.env.LUDICS_HARNESS_DIR;
let TMP = "";

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "ludics-paths-"));
  process.env.LUDICS_HARNESS_DIR = TMP;
});

afterEach(() => {
  if (ORIGINAL_HARNESS === undefined) delete process.env.LUDICS_HARNESS_DIR;
  else process.env.LUDICS_HARNESS_DIR = ORIGINAL_HARNESS;
  rmSync(TMP, { recursive: true, force: true });
});

describe("taskFilePath", () => {
  test("explicit harnessDir is authoritative", () => {
    expect(taskFilePath("task-abc", "/custom/harness")).toBe(
      "/custom/harness/tasks/task-abc.md",
    );
  });

  test("default arg falls back to LUDICS_HARNESS_DIR at call time", () => {
    expect(taskFilePath("task-xyz")).toBe(join(TMP, "tasks", "task-xyz.md"));
  });

  test("explicit decoy-proof: env is ignored when explicit harnessDir is given", () => {
    const decoy = "/decoy/should/not/appear";
    process.env.LUDICS_HARNESS_DIR = decoy;
    expect(taskFilePath("task-abc", "/real")).toBe("/real/tasks/task-abc.md");
  });
});
