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

  test("rejects path-traversal task IDs before any sibling file is touched (TASK_ID_RE guard)", async () => {
    // Harness condition: a *sibling* directory next to tasks/ contains a
    // decoy file whose path would be reachable via `../decoy/sibling.md`
    // if the CLI did `join(tasksDir(), `${id}.md`)` without validation.
    // The decoy file is non-empty and has no frontmatter, so any
    // updateFrontmatterField mutation would either leave a `.tmp` sibling
    // or rewrite the file's contents. We assert the file is byte-identical
    // before and after the rejected call.
    const harnessDir = harness();
    mkdirSync(join(harnessDir, "tasks"), { recursive: true });
    const decoyDir = join(harnessDir, "decoy");
    mkdirSync(decoyDir, { recursive: true });
    const decoyFile = join(decoyDir, "sibling.md");
    const decoyContent = "# Decoy — must not be touched by the CLI\n";
    writeFileSync(decoyFile, decoyContent);

    // Each rejected ID below contains a character TASK_ID_RE explicitly
    // forbids (`/`, space, `$`, `..` with leading slash). Without the
    // guard the first id would resolve to `<tasks>/../decoy/sibling.md`
    // — escaping the tasks directory and overwriting the decoy file.
    // (Note: a bare `..` happens to be safe because `${id}.md` renders as
    // `...md` and lands inside the tasks dir; we don't include it because
    // TASK_ID_RE *accepts* it, so a "rejected" assertion would be wrong.
    // We test the IDs the regex truly rejects.)
    const malicious = [
      "../decoy/sibling",
      "task/sub",
      "task with space",
      "task$injection",
    ];

    for (const id of malicious) {
      const before = readFileSync(decoyFile, "utf-8");
      await expect(
        silenceConsoleError(async () => runTasks(["status", id, "ready"])),
      ).rejects.toThrow(/invalid task ID/);
      // Invariant: the rejection happens at the CLI boundary, BEFORE the
      // join+updateFrontmatterField sequence. Mutation: drop the
      // TASK_ID_RE.test guard and the first iteration's `..` path would
      // resolve to `<harness>/tasks/../decoy/sibling.md` — the
      // updateFrontmatterField call would either touch the decoy file or
      // throw a different error path (not "invalid task ID").
      const after = readFileSync(decoyFile, "utf-8");
      expect(after).toBe(decoyContent);
      expect(after).toBe(before);
    }
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
