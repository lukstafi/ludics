// gh-ludics-547 — `tasksNeedsConfirmationList` helper + `ludics tasks
// needs-confirmation` CLI sub-command.
//
// The helper is the single source of truth shared by the CLI sub-command and
// the briefing-context generator (`briefingPrecomputeContext` in src/mag.ts).
// These tests pin its status-exact filter (the #547 stale-carry-over bug was
// a long-`done` task surviving into the briefing), its id/priority/project/
// title projection, and its deterministic ordering.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { runTasks, tasksNeedsConfirmationList } from "./index.ts";
import { captureConsoleLog } from "../test-utils.ts";

const TMP = join(import.meta.dir, ".test-tmp-needs-confirmation-cli");
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

function tasksDir(): string {
  return join(harness(), "tasks");
}

/** Write a task file. Omit a field by passing `null` to exercise the
 *  parser's defaults + the helper's display fallbacks. */
function writeTask(
  id: string,
  status: string,
  opts: { priority?: string | null; project?: string | null; title?: string | null; mergedInto?: string } = {},
): void {
  mkdirSync(tasksDir(), { recursive: true });
  const lines = [`id: ${id}`];
  if (opts.title !== null) lines.push(`title: "${opts.title ?? id}"`);
  if (opts.project !== null) lines.push(`project: ${opts.project ?? "ludics"}`);
  lines.push(`status: ${status}`);
  if (opts.priority !== null) lines.push(`priority: ${opts.priority ?? "B"}`);
  if (opts.mergedInto) lines.push(`merged_into: ${opts.mergedInto}`);
  writeFileSync(join(tasksDir(), `${id}.md`), `---\n${lines.join("\n")}\n---\n\n# ${id}\n`);
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

describe("tasksNeedsConfirmationList (gh-ludics-547)", () => {
  test("lists only status: needs-confirmation tasks; ready and every terminal status are excluded", () => {
    // Harness condition: one needs-confirmation task alongside one task in
    // each non-matching status. Invariant: membership is exact-match on
    // `needs-confirmation`. Mutation — relaxing the predicate to a
    // "non-terminal" inverse filter would readmit `ready`; dropping
    // exact-match would readmit `done`/`abandoned`/`merged`.
    writeTask("task-nc", "needs-confirmation");
    writeTask("task-ready", "ready");
    writeTask("task-done", "done");
    writeTask("task-abandoned", "abandoned");
    writeTask("task-merged", "merged", { mergedInto: "task-nc" });

    const lines = tasksNeedsConfirmationList(tasksDir());

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("task-nc");
    // Each excluded status gets its own assertion (AC names done/abandoned/merged).
    const joined = lines.join("\n");
    expect(joined).not.toContain("task-ready");
    expect(joined).not.toContain("task-done");
    expect(joined).not.toContain("task-abandoned");
    expect(joined).not.toContain("task-merged");
  });

  test("projects id, priority, project, and title in `<id> (<priority>) [<project>] \"<title>\"` shape", () => {
    // Invariant: all four fields the briefing needs are present so the skill
    // renders entries without re-reading task files (AC 3).
    writeTask("task-proj", "needs-confirmation", {
      priority: "A",
      project: "ocannl",
      title: "Confirm the tensor refactor",
    });

    const lines = tasksNeedsConfirmationList(tasksDir());

    expect(lines).toEqual(['task-proj (A) [ocannl] "Confirm the tensor refactor"']);
  });

  test("orders deterministically by priority, then project, then id", () => {
    // Harness condition: three needs-confirmation tasks whose insertion order
    // (alphabetical id) differs from the expected priority order. Invariant:
    // a regression test can assert on the section stably (AC 6). Mutation —
    // removing the sort yields readdir order, failing this exact equality.
    writeTask("task-c", "needs-confirmation", { priority: "C" });
    writeTask("task-a", "needs-confirmation", { priority: "A" });
    writeTask("task-b", "needs-confirmation", { priority: "B" });

    const lines = tasksNeedsConfirmationList(tasksDir());

    expect(lines).toEqual([
      'task-a (A) [ludics] "task-a"',
      'task-b (B) [ludics] "task-b"',
      'task-c (C) [ludics] "task-c"',
    ]);
  });

  test("applies display defaults when optional frontmatter fields are absent", () => {
    // Harness condition: a needs-confirmation task with no priority/project/
    // title fields. Invariant: a malformed-but-present task never crashes the
    // briefing context and still renders with conservative placeholders.
    writeTask("task-bare", "needs-confirmation", { priority: null, project: null, title: null });

    const lines = tasksNeedsConfirmationList(tasksDir());

    expect(lines).toEqual(['task-bare (B) [unknown] "(untitled)"']);
  });

  test("returns [] for an absent tasks directory", () => {
    expect(tasksNeedsConfirmationList(join(harness(), "no-such-dir"))).toEqual([]);
  });

  test("returns [] when no task is in needs-confirmation status", () => {
    writeTask("task-done", "done");
    expect(tasksNeedsConfirmationList(tasksDir())).toEqual([]);
  });
});

describe("ludics tasks needs-confirmation CLI sub-command (gh-ludics-547)", () => {
  test("prints one projected line per needs-confirmation task", async () => {
    writeTask("task-cli-nc", "needs-confirmation", { priority: "S", project: "ludics", title: "Confirm me" });
    writeTask("task-cli-done", "done");

    // The needs-confirmation dispatch case is synchronous, so console.log
    // fires before captureConsoleLog restores; await the returned promise to
    // settle the runTasks dispatcher cleanly.
    const { lines, value } = captureConsoleLog(() => runTasks(["needs-confirmation"]));
    await value;

    expect(lines).toContain('task-cli-nc (S) [ludics] "Confirm me"');
    expect(lines.join("\n")).not.toContain("task-cli-done");
  });

  test("prints nothing when there are no needs-confirmation tasks", async () => {
    writeTask("task-cli-ready", "ready");

    const { lines, value } = captureConsoleLog(() => runTasks(["needs-confirmation"]));
    await value;

    expect(lines).toEqual([]);
  });
});
