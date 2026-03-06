import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tasksQueuePreemptions } from "./sync.ts";
import { emptyBlock, writeSlotFile } from "../slots/markdown.ts";

const TMP = join(import.meta.dir, ".test-tmp-sync");

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_CONFIG = process.env.LUDICS_CONFIG;

function writeConfig(homeDir: string): string {
  const configDir = join(homeDir, ".config", "ludics");
  mkdirSync(configDir, { recursive: true });
  const configPath = join(configDir, "config.yaml");
  writeFileSync(configPath, `state_repo: owner/ludics-state
state_path: harness
slots:
  count: 2
projects:
  - name: alpha
    repo: owner/alpha
    priority: true
  - name: beta
    repo: owner/beta
    priority: true
mag:
  autonomy_level:
    preempt_slots: auto
`);
  return configPath;
}

function writeTask(tasksDir: string, id: string, project: string, status: string): void {
  writeFileSync(join(tasksDir, `${id}.md`), `---
id: ${id}
title: "${id}"
project: ${project}
status: ${status}
priority: A
elaborated: true
dependencies:
  blocks: []
  blocked_by: []
  relates_to: []
  subtask_of: null
---
`);
}

function readQueueTasks(queueFile: string): string[] {
  return readFileSync(queueFile, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { task?: string })
    .map((entry) => entry.task ?? "");
}

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  process.env.HOME = TMP;
  process.env.LUDICS_CONFIG = writeConfig(TMP);
});

afterEach(() => {
  if (ORIGINAL_HOME === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = ORIGINAL_HOME;
  }

  if (ORIGINAL_CONFIG === undefined) {
    delete process.env.LUDICS_CONFIG;
  } else {
    process.env.LUDICS_CONFIG = ORIGINAL_CONFIG;
  }

  rmSync(TMP, { recursive: true, force: true });
});

describe("tasksQueuePreemptions", () => {
  test("queues one preemption per priority project even when those projects already occupy slots", () => {
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    mkdirSync(join(harness, "mag"), { recursive: true });

    writeTask(tasksDir, "task-alpha-active", "alpha", "in-progress");
    writeTask(tasksDir, "task-beta-active", "beta", "in-progress");
    writeTask(tasksDir, "task-alpha-ready", "alpha", "ready");
    writeTask(tasksDir, "task-beta-ready", "beta", "ready");

    const slots = new Map<number, string>();
    slots.set(1, emptyBlock(1).replace("**Process:** (empty)", "**Process:** alpha active").replace("**Task:** null", "**Task:** task-alpha-active"));
    slots.set(2, emptyBlock(2).replace("**Process:** (empty)", "**Process:** beta active").replace("**Task:** null", "**Task:** task-beta-active"));
    writeSlotFile(join(harness, "slots.md"), slots, 2);

    tasksQueuePreemptions();

    const queuedTasks = readQueueTasks(join(harness, "mag", "queue.jsonl"));
    expect(queuedTasks).toEqual(["task-alpha-ready", "task-beta-ready"]);
    expect(readFileSync(join(tasksDir, "task-alpha-ready.md"), "utf-8")).toContain("status: preempt-queued");
    expect(readFileSync(join(tasksDir, "task-beta-ready.md"), "utf-8")).toContain("status: preempt-queued");
  });

  test("keeps the limit per project when one project already has a stashed preemption", () => {
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    const preemptDir = join(harness, "mag", "preempted");
    mkdirSync(tasksDir, { recursive: true });
    mkdirSync(preemptDir, { recursive: true });

    writeTask(tasksDir, "task-alpha-current", "alpha", "in-progress");
    writeTask(tasksDir, "task-alpha-next", "alpha", "ready");
    writeTask(tasksDir, "task-beta-next", "beta", "ready");

    const slots = new Map<number, string>();
    slots.set(1, emptyBlock(1).replace("**Process:** (empty)", "**Process:** alpha current").replace("**Task:** null", "**Task:** task-alpha-current"));
    slots.set(2, emptyBlock(2).replace("**Process:** (empty)", "**Process:** something else").replace("**Task:** null", "**Task:** task-other"));
    writeSlotFile(join(harness, "slots.md"), slots, 2);

    writeFileSync(join(preemptDir, "slot-1.json"), JSON.stringify({
      slotNum: 1,
      previousTask: "task-old",
      previousProcess: "old task",
      previousMode: "manual",
      previousSession: "1",
      previousPath: "/tmp",
      previousStarted: "2026-03-06T10:00:00Z",
      previousAdapterArgs: "",
      preemptedAt: "2026-03-06T10:01:00Z",
      preemptingTask: "task-alpha-current",
    }) + "\n");

    tasksQueuePreemptions();

    const queuedTasks = readQueueTasks(join(harness, "mag", "queue.jsonl"));
    expect(queuedTasks).toEqual(["task-beta-next"]);
    expect(readFileSync(join(tasksDir, "task-alpha-next.md"), "utf-8")).toContain("status: ready");
    expect(readFileSync(join(tasksDir, "task-beta-next.md"), "utf-8")).toContain("status: preempt-queued");
  });
});
