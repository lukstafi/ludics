import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { slotAssign } from "./index.ts";

const TMP = join(import.meta.dir, ".test-tmp-index");

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
