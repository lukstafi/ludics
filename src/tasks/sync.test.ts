import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { contentFingerprint, formatYamlScalar, setFrontmatterScalar, tasksNeedsElaborationList, tasksQueuePreemptions, tasksReconcileBlockedStatus } from "./sync.ts";
import { renderFrontmatterValue } from "./markdown.ts";
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

  test("stale task with blockers is NOT flipped to blocked (stale is in skip list)", () => {
    // Harness condition: a `stale` task with non-empty blocked_by. Without
    // BLOCKED_RECONCILE_SKIP_STATUSES including stale, the reconciler would
    // try to flip ready→blocked here. Since stale is terminal, it must be
    // left alone.
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });

    writeTaskWithBlockedBy(tasksDir, "task-stale-with-blockers", "stale", ["task-dep"]);
    tasksReconcileBlockedStatus(tasksDir);

    // Invariant: stale status survives the sweep verbatim.
    expect(readFileSync(join(tasksDir, "task-stale-with-blockers.md"), "utf-8")).toContain("status: stale");
  });

  test("stale task with no blockers is NOT flipped to ready (stale is in skip list)", () => {
    // Harness condition: a `stale` task with empty blocked_by. The
    // status==="blocked" reset path must not catch stale tasks.
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });

    writeTaskWithBlockedBy(tasksDir, "task-stale-no-blockers", "stale", []);
    tasksReconcileBlockedStatus(tasksDir);

    // Invariant: stale survives even with empty blocked_by.
    const after = readFileSync(join(tasksDir, "task-stale-no-blockers.md"), "utf-8");
    expect(after).toContain("status: stale");
    expect(after).not.toContain("status: ready");
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

describe("containerCompletionSweep", () => {
  function readQueueActions(queueFile: string): Array<{ action?: string; task?: string }> {
    if (!readFileSync) return [];
    try {
      return readFileSync(queueFile, "utf-8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { action?: string; task?: string });
    } catch { return []; }
  }

  function setupContainerWithChildren(parent: string, children: Array<{ id: string; status: string }>): { harness: string; tasksDir: string; queueFile: string } {
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    mkdirSync(join(harness, "mag"), { recursive: true });
    writeContainerTask(tasksDir, parent, "ludics", "ready");
    for (const c of children) {
      writeChildTask(tasksDir, c.id, parent, c.status);
    }
    return { harness, tasksDir, queueFile: join(harness, "mag", "queue.jsonl") };
  }

  test("enqueues verify-container-completion exactly once when all children resolve (AC6)", () => {
    // Harness condition: leaf:false parent, two terminal children (one done,
    // one abandoned), parent itself still `ready`.
    const { tasksDir, queueFile } = setupContainerWithChildren("task-parent", [
      { id: "task-child-a", status: "done" },
      { id: "task-child-b", status: "abandoned" },
    ]);

    tasksReconcileBlockedStatus(tasksDir);
    let entries = readQueueActions(queueFile).filter(e => e.action === "verify-container-completion");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.task).toBe("task-parent");

    // Invariant: a second sweep with no state change does NOT re-enqueue
    // (combined sentinel-fresh + fingerprint-match check). A regression here
    // would cause notify-spam every sync tick.
    tasksReconcileBlockedStatus(tasksDir);
    entries = readQueueActions(queueFile).filter(e => e.action === "verify-container-completion");
    expect(entries).toHaveLength(1);
  });

  test("vacuous parent (no children with subtask_of) does not enqueue (AC6 edge case)", () => {
    // Harness condition: leaf:false parent, NO child files referencing it.
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    mkdirSync(join(harness, "mag"), { recursive: true });
    writeContainerTask(tasksDir, "task-empty-parent", "ludics", "ready");

    tasksReconcileBlockedStatus(tasksDir);
    const entries = readQueueActions(join(harness, "mag", "queue.jsonl"));
    expect(entries.filter(e => e.action === "verify-container-completion")).toHaveLength(0);
  });

  test("parent in TERMINAL_FOR_PARENT status is skipped (AC6 — already-decided guard)", () => {
    // Harness condition: parent is `done` already; sweep must not re-enqueue.
    // If the guard were missing, the queue would gain a stale entry.
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    mkdirSync(join(harness, "mag"), { recursive: true });
    writeContainerTask(tasksDir, "task-done-parent", "ludics", "done");
    writeChildTask(tasksDir, "task-child-1", "task-done-parent", "done");

    tasksReconcileBlockedStatus(tasksDir);
    const entries = readQueueActions(join(harness, "mag", "queue.jsonl"));
    expect(entries.filter(e => e.action === "verify-container-completion")).toHaveLength(0);
  });

  test("stale parent does not enqueue verify-container-completion (AC 6 — stale ∈ TERMINAL_FOR_PARENT)", () => {
    // Harness condition: leaf:false parent is `stale`; both children are
    // terminal. Without `stale` in TERMINAL_FOR_PARENT, the sweep would
    // queue a verify-container-completion request for a task whose work
    // has already been superseded.
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    mkdirSync(join(harness, "mag"), { recursive: true });
    writeContainerTask(tasksDir, "task-stale-parent", "ludics", "stale");
    writeChildTask(tasksDir, "task-stale-child-a", "task-stale-parent", "done");
    writeChildTask(tasksDir, "task-stale-child-b", "task-stale-parent", "abandoned");

    tasksReconcileBlockedStatus(tasksDir);
    const entries = readQueueActions(join(harness, "mag", "queue.jsonl"));
    // Invariant: stale parent is skipped — no verify-container-completion
    // queued. Mutation: removing `stale` from TERMINAL_FOR_PARENT flips this
    // assertion (the sweep would queue a request).
    expect(entries.filter(e => e.action === "verify-container-completion")).toHaveLength(0);
  });

  test("re-fires when a child reopens then re-completes (AC7 — reset on child status flip)", () => {
    // Harness condition: two terminal children → enqueue, then flip A back to
    // ready (sentinel cleared by fingerprint mismatch), then back to done →
    // sweep re-enqueues. Without fingerprint comparison, the sentinel would
    // stay fresh and the second valid completion would be silently dropped.
    const { tasksDir, queueFile } = setupContainerWithChildren("task-parent2", [
      { id: "task-c2-a", status: "done" },
      { id: "task-c2-b", status: "done" },
    ]);

    tasksReconcileBlockedStatus(tasksDir);
    expect(readQueueActions(queueFile).filter(e => e.action === "verify-container-completion" && e.task === "task-parent2"))
      .toHaveLength(1);

    // Flip child-a back to ready: fingerprint changes, sentinel cleared,
    // but children no longer all terminal so no enqueue this tick.
    writeChildTask(tasksDir, "task-c2-a", "task-parent2", "ready");
    tasksReconcileBlockedStatus(tasksDir);
    expect(readQueueActions(queueFile).filter(e => e.action === "verify-container-completion" && e.task === "task-parent2"))
      .toHaveLength(1);

    // Flip back to done: fingerprint differs from prior sidecar (status `done`
    // vs the prior sidecar's `done` — same; but sentinel was cleared above),
    // so re-enqueue. We also need to drain the prior request from the queue
    // because queueHasPendingActionForTask would otherwise dedupe. The
    // intent is "after the user processes the first request, the second
    // completion still re-fires" — drain to simulate that.
    writeChildTask(tasksDir, "task-c2-a", "task-parent2", "done");
    writeFileSync(queueFile, ""); // user/mag drained the prior request
    tasksReconcileBlockedStatus(tasksDir);
    expect(readQueueActions(queueFile).filter(e => e.action === "verify-container-completion" && e.task === "task-parent2"))
      .toHaveLength(1);
  });

  test("re-fires when a new terminal child appears even though every child is still terminal (AC7 — reset on child-set change)", () => {
    // Harness condition: two children both done → enqueue, then a NEW child
    // is added with status: done. The "any non-terminal child" heuristic
    // would NOT detect this; only the child-set fingerprint comparison does.
    // This is the regression the round-1 review pinned.
    const { tasksDir, queueFile } = setupContainerWithChildren("task-parent3", [
      { id: "task-c3-a", status: "done" },
      { id: "task-c3-b", status: "done" },
    ]);

    tasksReconcileBlockedStatus(tasksDir);
    expect(readQueueActions(queueFile).filter(e => e.action === "verify-container-completion" && e.task === "task-parent3"))
      .toHaveLength(1);

    // Add a new terminal child. Drain the queue (so `queueHasPendingActionForTask`
    // doesn't suppress) — this models the user processing the first notify.
    writeChildTask(tasksDir, "task-c3-c", "task-parent3", "done");
    writeFileSync(queueFile, "");

    tasksReconcileBlockedStatus(tasksDir);
    // Invariant: a 3-child set differs from the 2-child set fingerprint, so
    // the sentinel is cleared and a fresh request fires. Without fingerprint
    // tracking, the sentinel would stay fresh (since 6h > test runtime) and
    // the user would never be told the parent's situation changed.
    expect(readQueueActions(queueFile).filter(e => e.action === "verify-container-completion" && e.task === "task-parent3"))
      .toHaveLength(1);
  });

  test("pending-request dedupe suppresses double-enqueue", () => {
    // Harness condition: we pre-seed an unprocessed request, then the sweep
    // must NOT add a second one for the same parent.
    const { tasksDir, queueFile } = setupContainerWithChildren("task-parent4", [
      { id: "task-c4-a", status: "done" },
    ]);
    writeFileSync(queueFile, JSON.stringify({
      id: "req-pre", action: "verify-container-completion", task: "task-parent4", timestamp: "2026-04-29T00:00:00Z",
    }) + "\n");

    tasksReconcileBlockedStatus(tasksDir);

    expect(readQueueActions(queueFile).filter(e => e.action === "verify-container-completion" && e.task === "task-parent4"))
      .toHaveLength(1);
  });

  test("merged_from containment is NOT honored — only subtask_of", () => {
    // Harness condition: parent has `merged_from` (irrelevant here) but no
    // child references it via subtask_of. The sweep must treat it as vacuous.
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    mkdirSync(join(harness, "mag"), { recursive: true });
    writeFileSync(join(tasksDir, "task-merge-parent.md"), `---
id: task-merge-parent
title: "merge parent"
project: ludics
status: ready
priority: B
leaf: false
merged_from:
  - task-old
dependencies:
  blocks: []
  blocked_by: []
  relates_to: []
  subtask_of: null
---
`);
    writeFileSync(join(tasksDir, "task-old.md"), `---
id: task-old
title: "old"
project: ludics
status: done
priority: B
dependencies:
  blocks: []
  blocked_by: []
  relates_to: []
  subtask_of: null
---
`);

    tasksReconcileBlockedStatus(tasksDir);

    expect(readQueueActions(join(harness, "mag", "queue.jsonl")).filter(e => e.action === "verify-container-completion"))
      .toHaveLength(0);
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

  test("stale tasks are excluded from the needs-elaboration list (AC 6 scope expansion)", () => {
    // Harness condition: a stale task that is both unelaborated AND has
    // status: stale. Without `stale` in the skip list, the function would
    // return its id, causing keepalive to auto-queue elaboration for a
    // superseded task.
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });

    writeFileSync(join(tasksDir, "task-stale-unelaborated.md"), `---
id: task-stale-unelaborated
title: "stale-victim"
project: ludics
status: stale
priority: B
dependencies:
  blocks: []
  blocked_by: []
  relates_to: []
  subtask_of: null
---
`);
    // Sibling unelaborated leaf — proves the function would have included
    // the stale task if the filter were absent.
    writeFileSync(join(tasksDir, "task-leaf-eligible.md"), `---
id: task-leaf-eligible
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

    // Invariant: stale tasks must not appear in the needs-elaboration list.
    // Mutation: removing `stale` from the skip list flips this assertion.
    expect(list).not.toContain("task-stale-unelaborated");
    expect(list).toContain("task-leaf-eligible");
  });
});

describe("contentFingerprint", () => {
  // Migrated from the deleted bash test script (gh-ludics-407): that script
  // inlined a duplicate fingerprint implementation gated on bash 4+ syntax.
  // These tests assert the same five behaviours against the TS implementation
  // directly.

  const baseline = contentFingerprint("Add dark mode support");

  test("returns 8-char lowercase hex", () => {
    // Invariant: fingerprint format is exactly 8 hex chars. Slicing or
    // hashing changes that produce non-hex or wrong-length output flip this.
    expect(baseline).toMatch(/^[0-9a-f]{8}$/);
    expect(baseline.length).toBe(8);
  });

  test("is case-insensitive", () => {
    // Invariant: case folding happens before hashing. Removing toLowerCase()
    // flips this — uppercase input would hash differently.
    expect(contentFingerprint("ADD DARK MODE SUPPORT")).toBe(baseline);
  });

  test("normalizes whitespace", () => {
    // Invariant: surrounding + collapsed internal whitespace is normalized
    // before hashing. Removing the trim/collapse pipeline flips this.
    expect(contentFingerprint("  Add   dark  mode  support  ")).toBe(baseline);
  });

  test("strips non-alphanumeric characters", () => {
    // Invariant: punctuation does not affect the fingerprint. The regex
    // `[^a-z0-9 ]` strip is what makes "dark-mode" and "darkmode" collide.
    const punctuated = contentFingerprint("Add dark-mode support!");
    const stripped = contentFingerprint("Add darkmode support");
    expect(punctuated).toBe(stripped);
  });

  test("distinct inputs produce distinct fingerprints", () => {
    // Invariant: the hash is content-sensitive — unrelated text produces a
    // different fingerprint. A constant-output bug (e.g. hashing "" instead
    // of `normalized`) would flip this.
    expect(contentFingerprint("Completely different task")).not.toBe(baseline);
  });
});

describe("formatYamlScalar", () => {
  // Each branch is pinned by a per-mutation falsifier per the task's AC. The
  // null/empty-string path is intentionally routed through the shared
  // `renderFrontmatterValue` seam in `markdown.ts`; the boolean/number/
  // identifier/quoted-string branches stay layered above it.

  test("null renders to YAML null token via the shared seam", () => {
    // Mutation: replace the helper's return with `"NULL"` and this assertion
    // flips — proving the seam is wired in (not coincidental output from a
    // legacy `if (value === null) return "null"` branch in this file).
    expect(formatYamlScalar(null)).toBe("null");
  });

  test("empty string also collapses to null (alignment with renderFrontmatterValue)", () => {
    // Mutation: drop the `value === ""` clause and `""` falls through to the
    // identifier-regex / quoted-string branch, returning `'""'` — flipping
    // this assertion.
    expect(formatYamlScalar("")).toBe("null");
  });

  test("boolean true/false render to bare tokens", () => {
    // Mutation: remove the boolean branch and `true` falls through to
    // `renderFrontmatterValue` (or, if the type were widened, into the
    // string branches) — neither yields the bare `"true"` token.
    expect(formatYamlScalar(true)).toBe("true");
    expect(formatYamlScalar(false)).toBe("false");
  });

  test("numbers stringify (including 0, which is falsy)", () => {
    // Mutation: replace `typeof value === "number"` with `if (!value) return …`
    // and `0` routes through the null/empty branch — flipping the 0 case.
    expect(formatYamlScalar(42)).toBe("42");
    expect(formatYamlScalar(0)).toBe("0");
  });

  test("identifier-shaped strings pass through unquoted", () => {
    // Mutation: remove the identifier regex and `"hello-world"` falls through
    // to the quoted-string branch, producing `'"hello-world"'` instead.
    expect(formatYamlScalar("hello-world")).toBe("hello-world");
  });

  test("free-form strings are quoted with yamlEscape applied", () => {
    // Mutation: remove the quoted-string branch and `"hello world"` returns
    // unquoted — flipping this assertion.
    expect(formatYamlScalar("hello world")).toBe('"hello world"');
    // Embedded quotes get backslash-escaped (yamlEscape behaviour preserved).
    expect(formatYamlScalar('he said "hi"')).toBe('"he said \\"hi\\""');
  });

  test("rendered output round-trips through renderFrontmatterValue unchanged (double-application no-op)", () => {
    // Invariant for AC7: setFrontmatterScalar passes formatYamlScalar's
    // output to updateFrontmatterField / addFrontmatterField, which re-apply
    // renderFrontmatterValue. The double application must be a no-op for
    // every rendered shape, otherwise desiredLine would not equal the
    // existing line on the second identical write.
    // Mutation: if renderFrontmatterValue is altered to not pass through
    // non-empty rendered strings (e.g. wraps them in quotes), one of these
    // would fail.
    const cases: Array<string | number | boolean | null> = [
      null, "", true, false, 0, 42, "hello-world", "hello world", 'has "quotes"',
    ];
    for (const v of cases) {
      const rendered = formatYamlScalar(v);
      expect(renderFrontmatterValue(rendered)).toBe(rendered);
    }
  });
});

describe("setFrontmatterScalar", () => {
  // AC7 falsifier: identical second write returns false (desiredLine ===
  // existingLine short-circuit). The double application of
  // renderFrontmatterValue inside formatYamlScalar -> updateFrontmatterField
  // must remain idempotent for this short-circuit to fire.

  let tmpDir: string;
  let taskFile: string;

  beforeEach(() => {
    tmpDir = mkdtempSync("/tmp/ludics-sfs-");
    taskFile = join(tmpDir, "task.md");
    writeFileSync(taskFile, `---
id: task-x
title: "x"
---
body
`);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("first write of a null field adds the line and returns true", () => {
    // Harness: the field does not exist on disk, so setFrontmatterScalar
    // takes the addFrontmatterField branch and writes `<field>: null`.
    expect(setFrontmatterScalar(taskFile, "github_state_reason", null)).toBe(true);
    expect(readFileSync(taskFile, "utf-8")).toContain("github_state_reason: null\n");
  });

  test("identical second write returns false (desiredLine short-circuit)", () => {
    // Harness condition: same value written twice in a row. The second call
    // must hit the `existingLine === desiredLine` short-circuit and bail
    // without rewriting. This *only* works because renderFrontmatterValue
    // is idempotent on its own non-empty output — the double-application
    // through updateFrontmatterField has to land back on the same string.
    // Mutation: stub renderFrontmatterValue to return `<input>+":fixed"`,
    // and the second call would render a different desiredLine, miss the
    // short-circuit, and return true — failing this assertion.
    expect(setFrontmatterScalar(taskFile, "github_state_reason", null)).toBe(true);
    expect(setFrontmatterScalar(taskFile, "github_state_reason", null)).toBe(false);
  });

  test("identical second write of a quoted free-form string also short-circuits", () => {
    // Same invariant for the quoted-string branch: the rendered shape
    // `"hello world"` must round-trip through renderFrontmatterValue
    // unchanged so the second write returns false.
    expect(setFrontmatterScalar(taskFile, "title", "hello world")).toBe(true);
    expect(setFrontmatterScalar(taskFile, "title", "hello world")).toBe(false);
  });

  test("empty-string write produces the YAML-null shape on disk (alignment shift)", () => {
    // AC2's on-disk consequence: setFrontmatterScalar(file, field, "")
    // writes `<field>: null` (was `<field>: ""` before this task). Mutation:
    // revert the empty-string branch and the file would contain
    // `github_labels: ""` instead.
    expect(setFrontmatterScalar(taskFile, "github_labels", "")).toBe(true);
    expect(readFileSync(taskFile, "utf-8")).toContain("github_labels: null\n");
    // And the second identical write also short-circuits.
    expect(setFrontmatterScalar(taskFile, "github_labels", "")).toBe(false);
  });
});
