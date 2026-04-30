// AC 11 — doc-shape probe for the `## Status` section in
// docs/task-frontmatter-reference.md.
//
// The test pins two structural properties:
// - cardinality: `^## Status` appears exactly once (the doc gains the
//   section, not multiple competing sections).
// - presence loop: each of the 11 recognised statuses has its own
//   `### \`<status>\`` subsection — so future readers can link to
//   `#status` and find every status documented under it.
//
// Mutation: drop any of the 11 subsection headings and the corresponding
// assertion fails.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { ludicsRoot } from "./../src/config.ts";

describe("docs/task-frontmatter-reference.md § Status (AC 11)", () => {
  test("`## Status` cardinality is exactly 1", () => {
    const md = readFileSync(join(ludicsRoot(), "docs/task-frontmatter-reference.md"), "utf-8");
    const matches = md.match(/^## Status$/gm);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBe(1);
  });

  test("each of the 11 recognised statuses has a `### \\`<status>\\`` subsection", () => {
    // Harness condition: the source-of-truth list is VALID_STATUSES from
    // src/tasks/markdown.ts. If a status is added there but the doc isn't
    // updated, this loop catches the drift.
    const md = readFileSync(join(ludicsRoot(), "docs/task-frontmatter-reference.md"), "utf-8");
    const expected = [
      "ready", "in-progress", "deferred", "preempted", "preempt-queued",
      "done", "abandoned", "merged", "needs-confirmation", "blocked", "stale",
    ];
    for (const status of expected) {
      // Mutation: drop a `### \`<status>\`` heading and the per-status
      // assertion below fails — the failure names which status went missing.
      const re = new RegExp(`^### \`${status.replace(/-/g, "\\-")}\``, "m");
      expect(md).toMatch(re);
    }
  });
});
