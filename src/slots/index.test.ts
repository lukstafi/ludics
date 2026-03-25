import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { slotAssign, slotResume, slotStart } from "./index.ts";
import { persistState, defaultOrchestrationConfig, initAgentRuntimeState, type OrchestrationState } from "../orchestration/state.ts";

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_CONFIG = process.env.LUDICS_CONFIG;
let TMP = "";

function writeConfig(homeDir: string): string {
  const configDir = join(homeDir, ".config", "ludics");
  mkdirSync(configDir, { recursive: true });
  const configPath = join(configDir, "config.yaml");
  writeFileSync(configPath, `state_repo: owner/ludics-state
state_path: harness
slots:
  count: 2
`);
  return configPath;
}

function writeTask(tasksDir: string, id: string, title: string): void {
  writeFileSync(join(tasksDir, `${id}.md`), `---
id: ${id}
title: "${title}"
project: demo
status: ready
priority: B
deadline: null
dependencies:
  blocks: []
  blocked_by: []
  relates_to: []
  subtask_of: null
effort: medium
context: demo
uses_browser: false
slot: null
adapter: null
created: 2026-03-07
started: null
completed: null
modified: null
source: local
---
`);
}

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "ludics-slots-index-"));
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

describe("slotAssign", () => {
  test("treats existing watch task files as task IDs", () => {
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeTask(tasksDir, "watch-streams-cleanup", "Watch streams cleanup");

    slotAssign(1, "watch-streams-cleanup", "manual");

    const slots = readFileSync(join(harness, "slots.md"), "utf-8");
    expect(slots).toContain("## Slot 1");
    expect(slots).toContain("**Process:** Watch streams cleanup");
    expect(slots).toContain("**Task:** watch-streams-cleanup");

    const task = readFileSync(join(tasksDir, "watch-streams-cleanup.md"), "utf-8");
    expect(task).toContain("status: in-progress");
    expect(task).toContain("slot: 1");
    expect(task).toContain("adapter: manual");
  });

  test("keeps free-text descriptions as non-task assignments", () => {
    const harness = join(TMP, "ludics-state", "harness");
    mkdirSync(harness, { recursive: true });

    slotAssign(2, "Investigate slot detection", "manual");

    const slots = readFileSync(join(harness, "slots.md"), "utf-8");
    expect(slots).toContain("## Slot 2");
    expect(slots).toContain("**Process:** Investigate slot detection");
    expect(slots).toContain("**Task:** null");
  });
});

describe("slotResume guards", () => {
  test("rejects non-t3code mode slots", async () => {
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeTask(tasksDir, "task-resume-1", "Resume test");
    slotAssign(1, "task-resume-1", "manual");

    await expect(slotResume(1)).rejects.toThrow("resume only supports t3code");
  });

  test("rejects slots with no persisted t3code state", async () => {
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeTask(tasksDir, "task-resume-2", "Resume test 2");
    slotAssign(1, "task-resume-2", "t3code");

    await expect(slotResume(1)).rejects.toThrow("slot start");
  });

  test("rejects slots with no persisted orchestration state", async () => {
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeTask(tasksDir, "task-resume-3", "Resume test 3");
    slotAssign(1, "task-resume-3", "t3code");

    // Write t3code slot state but no orchestration state
    const t3codeDir = join(harness, "t3code");
    mkdirSync(t3codeDir, { recursive: true });
    writeFileSync(join(t3codeDir, "slot-1.json"), JSON.stringify({
      slot: 1,
      threads: [{ threadId: "t-1", projectId: "p-1", worktreePath: "/tmp/x", title: "test", model: "gpt-5.4", runtimeMode: "full-access", interactionMode: "default", createdAt: "2026-03-25", updatedAt: "2026-03-25" }],
    }));

    await expect(slotResume(1)).rejects.toThrow("orchestrated sessions");
  });
});

describe("slotStart guard", () => {
  test("refuses when recoverable orchestration state exists for same task", async () => {
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeTask(tasksDir, "task-guard-1", "Guard test");
    slotAssign(1, "task-guard-1", "t3code");

    // Write orchestration state for the same task (not done)
    const orchDir = join(harness, "orchestration");
    mkdirSync(orchDir, { recursive: true });
    const orchState: OrchestrationState = {
      slot: 1,
      feature: "task-guard-1",
      mode: "pair",
      phase: "work",
      round: 1,
      mergeRound: 0,
      agents: [],
      agentStates: {},
      config: defaultOrchestrationConfig(),
      phaseStartedAt: Math.floor(Date.now() / 1000),
      startedAt: new Date().toISOString(),
      projectDir: "/tmp/project",
      rootWorktree: "/tmp/root",
      peerSyncDir: "/tmp/peersync",
      threadIds: {},
      taskId: "task-guard-1",
    };
    persistState(orchState, harness);

    await expect(slotStart(1)).rejects.toThrow("resume");
  });
});
