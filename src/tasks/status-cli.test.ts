// AC 12 — `ludics tasks status <id> <status>` CLI subcommand smoke test.
//
// The proposal's literal probe (`ludics tasks update --status stale`) was
// substituted with `ludics tasks status <id> <status>` per the merged
// plan's documented assumption gap (tasks update is a GitHub-metadata
// refresh with no positional args). This test pins the substitute
// surface: the command flips frontmatter status, validates input
// against VALID_STATUSES, and rejects unknown spellings.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { runTasks } from "./index.ts";
import { silenceConsoleError } from "../test-utils.ts";

const TMP = join(import.meta.dir, ".test-tmp-status-cli");
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

function harness(): string {
  return join(TMP, "ludics-state", "harness");
}

function writeTaskFile(id: string, status: string): string {
  const tasksDir = join(harness(), "tasks");
  mkdirSync(tasksDir, { recursive: true });
  const file = join(tasksDir, `${id}.md`);
  writeFileSync(file, `---\nid: ${id}\ntitle: "${id}"\nstatus: ${status}\npriority: B\n---\n\n# ${id}\n`);
  return file;
}

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  process.env.HOME = TMP;
  process.env.LUDICS_CONFIG = writeConfig(TMP);
  process.env.LUDICS_HARNESS_DIR = harness();
  mkdirSync(harness(), { recursive: true });
});

afterEach(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.HOME; else process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_CONFIG === undefined) delete process.env.LUDICS_CONFIG; else process.env.LUDICS_CONFIG = ORIGINAL_CONFIG;
  if (ORIGINAL_HARNESS === undefined) delete process.env.LUDICS_HARNESS_DIR; else process.env.LUDICS_HARNESS_DIR = ORIGINAL_HARNESS;
  rmSync(TMP, { recursive: true, force: true });
});

describe("ludics tasks status <id> <status> (AC 12)", () => {
  test("flips frontmatter status: ready → stale on a fixture task", async () => {
    // Harness condition: a fixture task at status: ready. Without the
    // command flip, the assertion that the file ends at status: stale
    // fails directly.
    const file = writeTaskFile("task-ready-victim", "ready");

    await silenceConsoleError(async () => {
      await runTasks(["status", "task-ready-victim", "stale"]);
    });

    expect(readFileSync(file, "utf-8")).toContain("status: stale");
  });

  test("rejects unknown status spellings with a VALID_STATUSES error", async () => {
    // Harness condition: a fixture task exists; the rejection must come
    // from the VALID_STATUSES guard, not from a missing-file error.
    writeTaskFile("task-victim", "ready");

    await expect(
      silenceConsoleError(async () => runTasks(["status", "task-victim", "not-a-real-status"])),
    ).rejects.toThrow(/invalid status/);
  });

  test("rejects missing status argument with a usage error", async () => {
    writeTaskFile("task-victim", "ready");
    await expect(
      silenceConsoleError(async () => runTasks(["status", "task-victim"])),
    ).rejects.toThrow(/status required/);
  });

  test("rejects missing task id with a usage error", async () => {
    await expect(
      silenceConsoleError(async () => runTasks(["status"])),
    ).rejects.toThrow(/task ID required/);
  });

  test("rejects unknown task id with task-not-found error", async () => {
    await expect(
      silenceConsoleError(async () => runTasks(["status", "task-does-not-exist", "ready"])),
    ).rejects.toThrow(/task not found/);
  });

  test("accepts every status in VALID_STATUSES (smoke loop)", async () => {
    // Harness condition: a fresh fixture for each iteration. Mutation: drop
    // a status from VALID_STATUSES and the corresponding loop iteration
    // raises `invalid status: X`.
    const valid = [
      "ready", "in-progress", "deferred", "preempted", "preempt-queued",
      "done", "abandoned", "merged", "needs-confirmation", "blocked", "stale",
    ];
    const file = writeTaskFile("task-loop", "ready");
    for (const s of valid) {
      await silenceConsoleError(async () => runTasks(["status", "task-loop", s]));
      expect(readFileSync(file, "utf-8")).toContain(`status: ${s}`);
    }
  });
});
