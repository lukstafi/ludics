import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import * as events from "../events.ts";
import * as slots from "../slots/index.ts";
import { tasksAbandon } from "./index.ts";

const TMP = join(import.meta.dir, ".test-tmp-abandon");

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
`);
  return configPath;
}

function writeTaskFile(
  tasksDir: string,
  id: string,
  extra: Record<string, string | boolean> = {},
): void {
  const fields = [
    `id: ${id}`,
    `title: "Test task ${id}"`,
    `project: test-project`,
    `status: ${extra.status ?? "ready"}`,
    `priority: B`,
    `completed: null`,
  ];
  if (extra.deferred_launch !== undefined) {
    fields.push(`deferred_launch: ${extra.deferred_launch}`);
  }
  if (extra.approved !== undefined) {
    fields.push(`approved: ${extra.approved}`);
  }
  writeFileSync(join(tasksDir, `${id}.md`), `---\n${fields.join("\n")}\n---\n`);
}

let eventSpy: ReturnType<typeof spyOn>;
let findSlotSpy: ReturnType<typeof spyOn>;
let slotClearSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  process.env.HOME = TMP;
  process.env.LUDICS_CONFIG = writeConfig(TMP);
  process.env.LUDICS_HARNESS_DIR = join(TMP, "ludics-state", "harness");

  findSlotSpy = spyOn(slots, "findSlotForTask").mockReturnValue(null);
  slotClearSpy = spyOn(slots, "slotClear").mockImplementation(async () => {});
  eventSpy = spyOn(events, "emitEvent").mockImplementation(() => {});
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
  findSlotSpy.mockRestore();
  slotClearSpy.mockRestore();
  eventSpy.mockRestore();
  rmSync(TMP, { recursive: true, force: true });
});

describe("tasksAbandon", () => {
  test("abandon unslotted task — sets status to abandoned, sets completed, emits event", async () => {
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });

    writeTaskFile(tasksDir, "task-aaa", { status: "ready" });
    findSlotSpy.mockReturnValue(null);

    await tasksAbandon("task-aaa");

    const content = readFileSync(join(tasksDir, "task-aaa.md"), "utf-8");
    expect(content).toContain("status: abandoned");
    expect(content).toMatch(/completed: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/);
    expect(slotClearSpy).not.toHaveBeenCalled();
    expect(eventSpy).toHaveBeenCalledTimes(1);
    const event = eventSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(event.event_type).toBe("task_abandon");
    expect(event.status).toBe("abandoned");
  });

  test("abandon slotted task — calls slotClear, removes deferral flags, emits event", async () => {
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });

    writeTaskFile(tasksDir, "task-bbb", {
      status: "in-progress",
      deferred_launch: true,
      approved: true,
    });
    findSlotSpy.mockReturnValue(2);

    await tasksAbandon("task-bbb");

    expect(slotClearSpy).toHaveBeenCalledWith(2, "abandoned");
    const content = readFileSync(join(tasksDir, "task-bbb.md"), "utf-8");
    expect(content).not.toContain("deferred_launch");
    expect(content).not.toContain("approved");
    expect(eventSpy).toHaveBeenCalledTimes(1);
  });

  test("abandon task in terminal status — throws error", async () => {
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });

    // Harness condition: each terminal status (done, abandoned, merged, stale)
    // must trip the abandon-path's TERMINAL_STATUSES guard. Adding `stale` to
    // TERMINAL_STATUSES (AC 6) is what makes the stale iteration succeed —
    // mutation: drop `stale` from TERMINAL_STATUSES and the stale loop
    // iteration would no longer reject (tasksAbandon would re-flip status).
    for (const status of ["done", "abandoned", "merged", "stale"]) {
      writeTaskFile(tasksDir, "task-term", { status });
      eventSpy.mockClear();

      await expect(tasksAbandon("task-term")).rejects.toThrow("terminal status");
    }
  });

  test("abandon missing task — throws error", async () => {
    const harness = join(TMP, "ludics-state", "harness");
    mkdirSync(join(harness, "tasks"), { recursive: true });

    findSlotSpy.mockReturnValue(null);

    await expect(tasksAbandon("task-nonexistent")).rejects.toThrow("task not found");
  });

  test("frontmatter cleanup — deferred_launch and approved fields removed after abandon", async () => {
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });

    writeTaskFile(tasksDir, "task-ccc", {
      status: "ready",
      deferred_launch: true,
      approved: true,
    });
    findSlotSpy.mockReturnValue(null);

    await tasksAbandon("task-ccc");

    const content = readFileSync(join(tasksDir, "task-ccc.md"), "utf-8");
    expect(content).toContain("status: abandoned");
    expect(content).not.toContain("deferred_launch");
    expect(content).not.toContain("approved");
    expect(content).toMatch(/completed: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/);
  });
});
