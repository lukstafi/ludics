import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tasksQueuePreemptions, tasksReconcileBlockedStatus } from "./sync.ts";
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

function writeTaskWithBlockedBy(tasksDir: string, id: string, status: string, blockedBy: string[]): void {
  const blockedByYaml = blockedBy.map((b) => `    - ${b}`).join("\n");
  const blockedBySection = blockedBy.length > 0 ? `\n${blockedByYaml}` : " []";
  writeFileSync(join(tasksDir, `${id}.md`), `---
id: ${id}
title: "${id}"
project: test-project
status: ${status}
priority: B
dependencies:
  blocks: []
  blocked_by:${blockedBySection}
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

  test("skips malformed and non-preempt queue lines when scanning for existing preemptions", () => {
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    mkdirSync(join(harness, "mag"), { recursive: true });

    // alpha already has a queued preemption (valid line), beta does not
    writeTask(tasksDir, "task-alpha-active", "alpha", "in-progress");
    writeTask(tasksDir, "task-beta-active", "beta", "in-progress");
    writeTask(tasksDir, "task-alpha-ready", "alpha", "ready");
    writeTask(tasksDir, "task-beta-ready", "beta", "ready");

    const slots = new Map<number, string>();
    slots.set(1, emptyBlock(1).replace("**Process:** (empty)", "**Process:** alpha active").replace("**Task:** null", "**Task:** task-alpha-active"));
    slots.set(2, emptyBlock(2).replace("**Process:** (empty)", "**Process:** beta active").replace("**Task:** null", "**Task:** task-beta-active"));
    writeSlotFile(join(harness, "slots.md"), slots, 2);

    // Pre-seed queue with: malformed line, non-preempt action, and a valid preempt for alpha
    const queueFile = join(harness, "mag", "queue.jsonl");
    const lines = [
      "not valid json at all",
      JSON.stringify({ id: "req-1", action: "elaborate", task: "task-alpha-ready", timestamp: "2026-04-01T00:00:00Z" }),
      JSON.stringify({ id: "req-2", action: "preempt", task: "task-alpha-ready", autonomy: "auto", timestamp: "2026-04-01T00:00:00Z" }),
    ];
    writeFileSync(queueFile, lines.join("\n") + "\n");

    tasksQueuePreemptions();

    // Only beta-ready should be newly queued; alpha-ready is already queued
    const allLines = readFileSync(queueFile, "utf-8").trim().split("\n").filter(Boolean);
    const newEntries = allLines.slice(lines.length); // entries added by tasksQueuePreemptions
    const newTasks = newEntries.map((l) => (JSON.parse(l) as { task?: string }).task ?? "");
    expect(newTasks).toEqual(["task-beta-ready"]);
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

describe("tasksReconcileBlockedStatus", () => {
  test("sets status to blocked when blocked_by is non-empty and status is ready", () => {
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });

    writeTaskWithBlockedBy(tasksDir, "task-needs-blocking", "ready", ["task-dep-1", "task-dep-2"]);

    tasksReconcileBlockedStatus(tasksDir);

    expect(readFileSync(join(tasksDir, "task-needs-blocking.md"), "utf-8")).toContain("status: blocked");
  });

  test("resets status to ready when blocked_by is empty and status is blocked", () => {
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });

    writeTaskWithBlockedBy(tasksDir, "task-should-unblock", "blocked", []);

    tasksReconcileBlockedStatus(tasksDir);

    expect(readFileSync(join(tasksDir, "task-should-unblock.md"), "utf-8")).toContain("status: ready");
  });

  test("skips terminal and active statuses (done, abandoned, merged, in-progress, deferred, preempt-queued, preempted)", () => {
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });

    const skippedStatuses = ["done", "abandoned", "merged", "in-progress", "deferred", "preempt-queued", "preempted"];
    for (const s of skippedStatuses) {
      writeTaskWithBlockedBy(tasksDir, `task-${s}`, s, ["task-dep"]);
    }

    tasksReconcileBlockedStatus(tasksDir);

    for (const s of skippedStatuses) {
      expect(readFileSync(join(tasksDir, `task-${s}.md`), "utf-8")).toContain(`status: ${s}`);
    }
  });

  test("does not change already-consistent statuses", () => {
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });

    // ready with no blockers — should stay ready
    writeTaskWithBlockedBy(tasksDir, "task-already-ready", "ready", []);
    // blocked with blockers — should stay blocked
    writeTaskWithBlockedBy(tasksDir, "task-already-blocked", "blocked", ["task-dep"]);

    tasksReconcileBlockedStatus(tasksDir);

    expect(readFileSync(join(tasksDir, "task-already-ready.md"), "utf-8")).toContain("status: ready");
    expect(readFileSync(join(tasksDir, "task-already-blocked.md"), "utf-8")).toContain("status: blocked");
  });
});
