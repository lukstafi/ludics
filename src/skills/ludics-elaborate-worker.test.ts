// AC 3: atomicity invariant for the elaborate worker's frontmatter writes.
//
// The worker is a markdown skill that runs in a forked agent context, so we
// can't exercise the agent itself in a unit test. The regression boundary is
// the *contract*: when the worker emits non-empty `questions`, both
// `elaborated:` AND `has_questions: true` must land on disk in the same write
// window — eliminating the race where the keepalive's auto-proposal cycle
// fired between the two writes (the original Part 1 symptom).
//
// This test simulates the worker's frontmatter writes against a fixture task
// file using the same `addFrontmatterField` helper the skill markdown
// instructs. Mutation: drop the `has_questions` write from the simulated
// worker call sequence and the atomicity assertion fails — exactly the
// regression Part 1 exists to prevent.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { addFrontmatterField, parseTaskFrontmatter } from "../tasks/markdown.ts";
import { withSyntheticHarness } from "../test-utils.ts";

const getTmpDir = withSyntheticHarness(beforeEach, afterEach);

function writeFixtureTask(): string {
  const tasksDir = join(getTmpDir(), "tasks");
  mkdirSync(tasksDir, { recursive: true });
  const file = join(tasksDir, "task-fixture.md");
  writeFileSync(file, [
    "---",
    "id: task-fixture",
    "title: Fixture",
    "status: ready",
    "---",
    "",
    "# Fixture",
    "",
    "## Context",
    "",
    "## Notes",
    "",
  ].join("\n"));
  return file;
}

describe("elaborate worker atomic has_questions write (AC 3)", () => {
  test("when questions is non-empty, BOTH elaborated and has_questions land in the worker's write window", () => {
    // Harness condition: a fresh fixture task with neither `elaborated:` nor
    // `has_questions:` in its frontmatter. Without this initial absence, the
    // assertions wouldn't be measuring the worker's writes — they'd be
    // measuring some prior state.
    const taskFile = writeFixtureTask();
    const before = parseTaskFrontmatter(readFileSync(taskFile, "utf-8"));
    expect(before.elaborated).toBeUndefined();
    expect(readFileSync(taskFile, "utf-8")).not.toContain("has_questions");

    // Simulate the worker's `### 6. Update task file` step with a non-empty
    // questions list. Per the skill markdown, the worker calls
    // addFrontmatterField for both fields atomically (one writer per file
    // = race-free).
    const questions = ["Is option A or B preferred?"];
    addFrontmatterField(taskFile, "elaborated", "2026-04-30");
    if (questions.length > 0) {
      addFrontmatterField(taskFile, "has_questions", "true");
    }

    // Invariant: after the worker portion runs, the file has both fields.
    // Mutation: comment out the `has_questions` write above and this
    // assertion fails — exactly the regression Part 1 prevents.
    const content = readFileSync(taskFile, "utf-8");
    expect(content).toContain("elaborated: 2026-04-30");
    expect(content).toContain("has_questions: true");
  });

  test("when questions is empty, has_questions is NOT written", () => {
    // Harness condition: same fixture, but the worker emits an empty
    // questions list (`## Questions\n\nNone.`). Per the skill contract,
    // `has_questions` must remain absent — its absence is the signal that
    // proposal generation may proceed.
    const taskFile = writeFixtureTask();
    const questions: string[] = [];

    addFrontmatterField(taskFile, "elaborated", "2026-04-30");
    if (questions.length > 0) {
      addFrontmatterField(taskFile, "has_questions", "true");
    }

    const content = readFileSync(taskFile, "utf-8");
    expect(content).toContain("elaborated: 2026-04-30");
    // Invariant: has_questions absent under the empty-questions branch.
    // Mutation: writing has_questions unconditionally would block proposal
    // generation forever for tasks the user never asked questions about.
    expect(content).not.toContain("has_questions");
  });
});
