// Auto-restore on terminal slotClear (task-4028c493).
//
// Verifies that when a slot holds preempted work and the priority task
// terminates, slotClear:
//   - auto-restores the displaced task on `done` and `abandoned`
//   - leaves the stash on disk on `ready` (Postpone), so the priority
//     task can return without racing the displaced task
//
// The displaced task transition observed (preempted → in-progress) is
// the AC's invariant: if the auto-restore guard regresses, the displaced
// task stays at `preempted` and the stash file is orphaned under
// mag/preempted/slot-N.json.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { slotAssign, slotClear, slotPreempt } from "./index.ts";
import { emptySlotData, writeSlotJson } from "./json.ts";
import { hasStash } from "./preempt.ts";
import { parseTaskFrontmatter } from "../tasks/markdown.ts";

setDefaultTimeout(15_000);

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_CONFIG = process.env.LUDICS_CONFIG;
const ORIGINAL_HARNESS = process.env.LUDICS_HARNESS_DIR;
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
created: 2026-05-01
started: null
completed: null
modified: null
source: local
---
`);
}

function readTaskStatus(tasksDir: string, id: string): string {
  const content = readFileSync(join(tasksDir, `${id}.md`), "utf-8");
  return parseTaskFrontmatter(content).status ?? "unknown";
}

function readEvents(harness: string): Array<Record<string, unknown>> {
  const file = join(harness, "journal", "events.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf-8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "ludics-slot-auto-restore-"));
  process.env.HOME = TMP;
  process.env.LUDICS_CONFIG = writeConfig(TMP);
  process.env.LUDICS_HARNESS_DIR = join(TMP, "ludics-state", "harness");
});

afterEach(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_CONFIG === undefined) delete process.env.LUDICS_CONFIG;
  else process.env.LUDICS_CONFIG = ORIGINAL_CONFIG;
  if (ORIGINAL_HARNESS === undefined) delete process.env.LUDICS_HARNESS_DIR;
  else process.env.LUDICS_HARNESS_DIR = ORIGINAL_HARNESS;
  rmSync(TMP, { recursive: true, force: true });
});

async function setUpPreemptedSlot(): Promise<{ harness: string; tasksDir: string; stashFile: string }> {
  const harness = join(TMP, "ludics-state", "harness");
  const tasksDir = join(harness, "tasks");
  mkdirSync(tasksDir, { recursive: true });
  writeSlotJson(1, emptySlotData(1), harness);
  writeSlotJson(2, emptySlotData(2), harness);
  writeTask(tasksDir, "task-displaced", "Displaced");
  writeTask(tasksDir, "task-priority", "Priority");

  // Displaced task → in-progress in slot 1
  await slotAssign(1, "task-displaced", "manual");
  expect(readTaskStatus(tasksDir, "task-displaced")).toBe("in-progress");

  // Preempt with priority task → displaced becomes "preempted", stash written
  await slotPreempt(1, "task-priority", "manual");
  expect(readTaskStatus(tasksDir, "task-displaced")).toBe("preempted");
  const stashFile = join(harness, "mag", "preempted", "slot-1.json");
  expect(existsSync(stashFile)).toBe(true);

  return { harness, tasksDir, stashFile };
}

describe("slotClear auto-restore (task-4028c493)", () => {
  test("abandoned: auto-restores displaced task and removes stash", async () => {
    const { harness, tasksDir, stashFile } = await setUpPreemptedSlot();

    await slotClear(1, "abandoned");

    // Invariant: displaced task is back to in-progress, stash file is gone.
    // If the auto-restore guard regresses (only fires on "done"), this
    // assertion fails: status would still be "preempted".
    expect(readTaskStatus(tasksDir, "task-displaced")).toBe("in-progress");
    expect(hasStash(1)).toBe(false);
    expect(existsSync(stashFile)).toBe(false);

    // Priority task transitioned to abandoned via the slotClear path.
    expect(readTaskStatus(tasksDir, "task-priority")).toBe("abandoned");

    // slot_auto_restore event emitted with the abandoned trigger.
    const events = readEvents(harness);
    const autoRestore = events.filter((e) => e.event_type === "slot_auto_restore");
    expect(autoRestore.length).toBe(1);
    expect(autoRestore[0]?.slot).toBe(1);
    expect(autoRestore[0]?.message).toBe("trigger: abandoned");
  });

  test("done: auto-restores displaced task and emits trigger=done", async () => {
    const { harness, tasksDir, stashFile } = await setUpPreemptedSlot();

    await slotClear(1, "done");

    expect(readTaskStatus(tasksDir, "task-displaced")).toBe("in-progress");
    expect(existsSync(stashFile)).toBe(false);
    expect(readTaskStatus(tasksDir, "task-priority")).toBe("done");

    const events = readEvents(harness);
    const autoRestore = events.filter((e) => e.event_type === "slot_auto_restore");
    expect(autoRestore.length).toBe(1);
    expect(autoRestore[0]?.message).toBe("trigger: done");
  });

  test("ready: does NOT auto-restore — stash remains, displaced stays preempted", async () => {
    const { harness, tasksDir, stashFile } = await setUpPreemptedSlot();

    await slotClear(1, "ready");

    // Invariant: ready (Postpone) leaves the stash on disk so the priority
    // task can return. Displaced task stays at "preempted".
    expect(readTaskStatus(tasksDir, "task-displaced")).toBe("preempted");
    expect(hasStash(1)).toBe(true);
    expect(existsSync(stashFile)).toBe(true);

    const events = readEvents(harness);
    const autoRestore = events.filter((e) => e.event_type === "slot_auto_restore");
    expect(autoRestore.length).toBe(0);
  });

  test("corrupt stash: failed restore does NOT emit a success-looking event", async () => {
    // Codex review on PR #482: emitting slot_auto_restore before the await
    // means a thrown slotRestore (e.g. hasStash() true but readStash() null
    // due to a corrupted stash file) records success-looking observability
    // while the slot is left unrestored. Invariant: slot_auto_restore fires
    // only after slotRestore resolves.
    const { harness, stashFile } = await setUpPreemptedSlot();

    // Corrupt the stash JSON. hasStash() (existsSync) still returns true,
    // but readStash() catches the JSON parse error and returns null, so
    // slotRestore throws "no preempted stash to restore".
    writeFileSync(stashFile, "{ not valid json", "utf-8");
    expect(hasStash(1)).toBe(true);

    let threw = false;
    try {
      await slotClear(1, "abandoned");
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    const events = readEvents(harness);
    const autoRestore = events.filter((e) => e.event_type === "slot_auto_restore");
    expect(autoRestore.length).toBe(0);
  });
});
