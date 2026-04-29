import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tasksNeedsElaborationList, tasksQueuePreemptions, tasksReconcileBlockedStatus } from "./sync.ts";
import { emptySlotData, writeSlotJson } from "../slots/json.ts";

const TMP = join(import.meta.dir, ".test-tmp-sync");

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_CONFIG = process.env.LUDICS_CONFIG;
const ORIGINAL_HARNESS = process.env.LUDICS_HARNESS_DIR;

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

function writeContainerTask(tasksDir: string, id: string, project: string, status: string): void {
  writeFileSync(join(tasksDir, `${id}.md`), `---
id: ${id}
title: "${id}"
project: ${project}
status: ${status}
priority: A
elaborated: true
leaf: false
dependencies:
  blocks: []
  blocked_by: []
  relates_to: []
  subtask_of: null
---
`);
}

function writeChildTask(tasksDir: string, id: string, parent: string, status: string): void {
  writeFileSync(join(tasksDir, `${id}.md`), `---
id: ${id}
title: "${id}"
project: ludics
status: ${status}
priority: B
elaborated: true
dependencies:
  blocks: []
  blocked_by: []
  relates_to: []
  subtask_of: ${parent}
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
  process.env.LUDICS_HARNESS_DIR = join(TMP, "ludics-state", "harness");
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

  if (ORIGINAL_HARNESS === undefined) {
    delete process.env.LUDICS_HARNESS_DIR;
  } else {
    process.env.LUDICS_HARNESS_DIR = ORIGINAL_HARNESS;
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

    writeSlotJson(1, { ...emptySlotData(1), process: "alpha active", task: "task-alpha-active" }, harness);
    writeSlotJson(2, { ...emptySlotData(2), process: "beta active", task: "task-beta-active" }, harness);

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

    writeSlotJson(1, { ...emptySlotData(1), process: "alpha active", task: "task-alpha-active" }, harness);
    writeSlotJson(2, { ...emptySlotData(2), process: "beta active", task: "task-beta-active" }, harness);

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

  test("skips leaf:false container tasks (AC4 — preempt exclusion)", () => {
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    mkdirSync(join(harness, "mag"), { recursive: true });

    // Harness condition: a priority-project ready container exists alongside
    // a leaf sibling. Both slots full → preempt path runs. If the filter is
    // absent, the container also gets queued and the assertion below fails.
    writeTask(tasksDir, "task-alpha-active", "alpha", "in-progress");
    writeTask(tasksDir, "task-beta-active", "beta", "in-progress");
    writeContainerTask(tasksDir, "task-alpha-container", "alpha", "ready");
    writeTask(tasksDir, "task-beta-leaf", "beta", "ready");

    writeSlotJson(1, { ...emptySlotData(1), process: "alpha active", task: "task-alpha-active" }, harness);
    writeSlotJson(2, { ...emptySlotData(2), process: "beta active", task: "task-beta-active" }, harness);

    tasksQueuePreemptions();

    const queuedTasks = readQueueTasks(join(harness, "mag", "queue.jsonl"));
    // Invariant: leaf:false container is NEVER preempt-queued. If filter is
    // removed, this changes to ["task-alpha-container", "task-beta-leaf"].
    expect(queuedTasks).toEqual(["task-beta-leaf"]);
    expect(readFileSync(join(tasksDir, "task-alpha-container.md"), "utf-8")).toContain("status: ready");
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

    writeSlotJson(1, { ...emptySlotData(1), process: "alpha current", task: "task-alpha-current" }, harness);
    writeSlotJson(2, { ...emptySlotData(2), process: "something else", task: "task-other" }, harness);

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

  test("malformed YAML with status: blocked is not silently rewritten to ready", () => {
    // Regression for codex P1: parseTaskFrontmatter's line-regex fallback
    // salvages top-level scalars (status) but cannot reconstruct nested
    // dependencies.blocked_by. Before the dependencies-undefined guard,
    // this file would have been rewritten to `status: ready` because
    // `fm.dependencies?.blocked_by ?? []` returned an empty array.
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });

    const malformedFile = join(tasksDir, "task-malformed.md");
    writeFileSync(malformedFile, [
      "---",
      "id: task-malformed",
      "title: Malformed",
      "status: blocked",
      "dependencies: [unclosed",
      "---",
      "",
      "# Body",
      "",
    ].join("\n"));
    const before = readFileSync(malformedFile, "utf-8");

    tasksReconcileBlockedStatus(tasksDir);

    const after = readFileSync(malformedFile, "utf-8");
    // Invariant: malformed files must not be rewritten. `status: blocked`
    // survives verbatim; no status mutation.
    expect(after).toBe(before);
    expect(after).toContain("status: blocked");
    expect(after).not.toContain("status: ready");
  });
});

describe("tasksNeedsElaborationList", () => {
  test("skips leaf:false container tasks (AC3 — elaboration exclusion)", () => {
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });

    // Harness condition: container task is `ready` AND not yet elaborated
    // (no `elaborated:` line via writeUnElaboratedContainer below). Without
    // the filter, the function would return its id.
    writeFileSync(join(tasksDir, "task-container.md"), `---
id: task-container
title: "container"
project: ludics
status: ready
priority: B
leaf: false
dependencies:
  blocks: []
  blocked_by: []
  relates_to: []
  subtask_of: null
---
`);
    // Sibling leaf task in the same harness — proves the function is wired
    // and would return the leaf if the container were not filtered.
    writeFileSync(join(tasksDir, "task-leaf.md"), `---
id: task-leaf
title: "leaf"
project: ludics
status: ready
priority: B
dependencies:
  blocks: []
  blocked_by: []
  relates_to: []
  subtask_of: null
---
`);

    const list = tasksNeedsElaborationList(tasksDir);

    // Invariant: container is excluded from the elaboration list even when
    // it is unelaborated and ready. Removing the filter flips this assertion.
    expect(list).not.toContain("task-container");
    expect(list).toContain("task-leaf");
  });
});
