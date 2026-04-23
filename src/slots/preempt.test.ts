import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let tmpDir: string;
const ORIGINAL_HARNESS_DIR = process.env.LUDICS_HARNESS_DIR;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ludics-preempt-test-"));
  process.env.LUDICS_HARNESS_DIR = tmpDir;
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  if (ORIGINAL_HARNESS_DIR === undefined) delete process.env.LUDICS_HARNESS_DIR;
  else process.env.LUDICS_HARNESS_DIR = ORIGINAL_HARNESS_DIR;
});

async function loadPreempt() {
  return await import("./preempt.ts");
}

describe("writeStash + readStash", () => {
  test("round-trips all fields", async () => {
    const { writeStash, readStash } = await loadPreempt();
    const stash = {
      slotNum: 3,
      previousTask: "task-original",
      previousProcess: "pid-1234",
      previousMode: "pair",
      previousSession: "s3_coder_task-original",
      previousPath: "/tmp/worktree",
      previousStarted: "2026-04-24T00:00:00Z",
      previousAdapterArgs: "--pair --coder claude-code",
      preemptedAt: "2026-04-24T01:00:00Z",
      preemptingTask: "task-urgent",
    };
    writeStash(stash);
    expect(readStash(3)).toEqual(stash);
  });

  test("leaves no .tmp sibling after write", async () => {
    const { writeStash } = await loadPreempt();
    const stash = {
      slotNum: 1,
      previousTask: "t",
      previousProcess: "p",
      previousMode: "m",
      previousSession: "s",
      previousPath: "/p",
      previousStarted: "2026-04-24T00:00:00Z",
      preemptedAt: "2026-04-24T00:01:00Z",
      preemptingTask: "u",
    };
    writeStash(stash);
    const stashPath = join(tmpDir, "mag", "preempted", "slot-1.json");
    expect(existsSync(stashPath)).toBe(true);
    expect(existsSync(stashPath + ".tmp")).toBe(false);
  });

  test("auto-creates stash directory", async () => {
    const { writeStash } = await loadPreempt();
    const stash = {
      slotNum: 5,
      previousTask: "t",
      previousProcess: "p",
      previousMode: "m",
      previousSession: "s",
      previousPath: "/p",
      previousStarted: "2026-04-24T00:00:00Z",
      preemptedAt: "2026-04-24T00:01:00Z",
      preemptingTask: "u",
    };
    // Parent directory does not exist yet
    writeStash(stash);
    expect(existsSync(join(tmpDir, "mag", "preempted", "slot-5.json"))).toBe(true);
  });
});
