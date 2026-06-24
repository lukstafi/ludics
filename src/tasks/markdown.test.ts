import { describe, test, expect, afterEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { addFrontmatterField, appendToSection, frontmatterBounds, removeFrontmatterField, updateDependencyArray, setDependencyScalar, updateFrontmatterField, transitionStatus, parseTaskFrontmatter, writeTaskFile, _resetParseTaskFrontmatterCache, _parseTaskFrontmatterCacheSize, VALID_STATUSES, TERMINAL_STATUSES, READY_QUEUE_ELIGIBLE_STATUSES, BLOCKED_RECONCILE_SKIP_STATUSES } from "./markdown.ts";

const TMP_DIR = join(import.meta.dir, ".test-tmp");

function tmpFile(name: string, content: string): string {
  mkdirSync(TMP_DIR, { recursive: true });
  const p = join(TMP_DIR, name);
  writeFileSync(p, content);
  return p;
}

afterEach(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

describe("updateFrontmatterField upsert", () => {
  test("updates existing field", () => {
    const f = tmpFile("update.md", [
      "---",
      "id: task-1",
      "status: ready",
      "---",
      "",
      "# Title",
    ].join("\n"));

    updateFrontmatterField(f, "status", "completed");
    const result = readFileSync(f, "utf-8");
    expect(result).toContain("status: completed");
    expect(result).not.toContain("status: ready");
  });

  test("inserts missing field before closing ---", () => {
    const f = tmpFile("insert.md", [
      "---",
      "id: task-1",
      "status: ready",
      "---",
      "",
      "# Title",
    ].join("\n"));

    updateFrontmatterField(f, "completed", "2026-04-13");
    const result = readFileSync(f, "utf-8");
    const fmMatch = result.match(/^---\n([\s\S]*?)\n---/);
    expect(fmMatch).not.toBeNull();
    expect(fmMatch![1]).toContain("completed: 2026-04-13");
  });

  test("round-trip: inserted field is readable by parseTaskFrontmatter", () => {
    const f = tmpFile("roundtrip.md", [
      "---",
      "id: task-1",
      "status: ready",
      "---",
      "",
      "# Title",
    ].join("\n"));

    updateFrontmatterField(f, "completed", "2026-04-13T18:00Z");
    const content = readFileSync(f, "utf-8");
    const fm = parseTaskFrontmatter(content);
    expect(fm.completed).toBe("2026-04-13T18:00Z");
    // Existing fields preserved
    expect(fm.id).toBe("task-1");
    expect(fm.status).toBe("ready");
  });

  test("inserts into frontmatter, not at body horizontal rule", () => {
    const f = tmpFile("hrule.md", [
      "---",
      "id: task-1",
      "status: ready",
      "---",
      "",
      "# Title",
      "",
      "---",
      "",
      "Some body after horizontal rule",
    ].join("\n"));

    updateFrontmatterField(f, "completed", "2026-04-13");
    const result = readFileSync(f, "utf-8");
    const fmMatch = result.match(/^---\n([\s\S]*?)\n---/);
    expect(fmMatch).not.toBeNull();
    expect(fmMatch![1]).toContain("completed: 2026-04-13");
    // Body horizontal rule and text preserved
    expect(result).toContain("Some body after horizontal rule");
  });

  test("does not insert into body when field missing from frontmatter", () => {
    const f = tmpFile("body.md", [
      "---",
      "id: task-1",
      "---",
      "",
      "# Title",
      "",
      "Some body text",
    ].join("\n"));

    updateFrontmatterField(f, "completed", "2026-04-13");
    const result = readFileSync(f, "utf-8");
    // Field should be in frontmatter, not after body
    const fmMatch = result.match(/^---\n([\s\S]*?)\n---/);
    expect(fmMatch![1]).toContain("completed: 2026-04-13");
    // Body preserved
    expect(result).toContain("Some body text");
  });
});

describe("addFrontmatterField", () => {
  test("inserts new field before closing ---", () => {
    const f = tmpFile("basic.md", [
      "---",
      "id: task-1",
      "status: ready",
      "---",
      "",
      "# Title",
    ].join("\n"));

    addFrontmatterField(f, "priority", "A");
    const result = readFileSync(f, "utf-8");
    expect(result).toContain("priority: A\n---");
  });

  test("updates existing frontmatter field via delegation", () => {
    const f = tmpFile("update.md", [
      "---",
      "id: task-1",
      "priority: B",
      "---",
      "",
      "# Title",
    ].join("\n"));

    addFrontmatterField(f, "priority", "A");
    const result = readFileSync(f, "utf-8");
    expect(result).toContain("priority: A");
    expect(result).not.toContain("priority: B");
    // Should not duplicate the field
    expect(result.match(/priority:/g)?.length).toBe(1);
  });

  test("inserts field even when body contains matching pattern (regression)", () => {
    const f = tmpFile("regression.md", [
      "---",
      "id: task-1",
      "status: ready",
      "---",
      "",
      "# Title",
      "",
      "priority: high",
    ].join("\n"));

    addFrontmatterField(f, "priority", "A");
    const result = readFileSync(f, "utf-8");
    // The field must appear in frontmatter
    const fmMatch = result.match(/^---\n([\s\S]*?)\n---/);
    expect(fmMatch).not.toBeNull();
    expect(fmMatch![1]).toContain("priority: A");
    // Body line must be preserved unchanged
    expect(result).toContain("priority: high");
  });

  test("does not insert if field exists in frontmatter even when body also has it", () => {
    const f = tmpFile("both.md", [
      "---",
      "id: task-1",
      "priority: B",
      "---",
      "",
      "# Title",
      "",
      "priority: high",
    ].join("\n"));

    addFrontmatterField(f, "priority", "A");
    const result = readFileSync(f, "utf-8");
    const fmMatch = result.match(/^---\n([\s\S]*?)\n---/);
    expect(fmMatch).not.toBeNull();
    expect(fmMatch![1]).toContain("priority: A");
    expect(fmMatch![1]).not.toContain("priority: B");
    // Body line preserved
    expect(result).toContain("priority: high");
  });
});

describe("updateFrontmatterField null/empty normalization", () => {
  // Invariant: when callers pass JS `null` or `""`, the writer emits the
  // canonical YAML null token `null` on disk — never the JS-literal string
  // `"null"` and never an empty value. Replaces the legacy
  // `updateFrontmatterField(file, "slot", "null")` write idiom.
  test("null value renders as canonical YAML null on existing field", () => {
    const f = tmpFile("null-update.md", [
      "---",
      "id: task-1",
      "slot: 3",
      "---",
      "",
      "# Title",
    ].join("\n"));

    updateFrontmatterField(f, "slot", null);
    const result = readFileSync(f, "utf-8");
    expect(result).toContain("slot: null");
    // Round-trip: parser sees the field as absent (null/undefined-y).
    const fm = parseTaskFrontmatter(result);
    expect(fm.slot ?? null).toBeNull();
  });

  test("empty string value normalizes to YAML null on existing field", () => {
    const f = tmpFile("empty-update.md", [
      "---",
      "id: task-1",
      "slot: 3",
      "---",
      "",
      "# Title",
    ].join("\n"));

    updateFrontmatterField(f, "slot", "");
    const result = readFileSync(f, "utf-8");
    // Must be the canonical `null` token, not a dangling `slot: ` line.
    expect(result).toContain("slot: null");
    expect(result).not.toMatch(/^slot:\s*$/m);
  });

  test("null value renders as YAML null when upserting a missing field", () => {
    const f = tmpFile("null-upsert.md", [
      "---",
      "id: task-1",
      "status: ready",
      "---",
      "",
      "# Title",
    ].join("\n"));

    updateFrontmatterField(f, "slot", null);
    const result = readFileSync(f, "utf-8");
    const fmMatch = result.match(/^---\n([\s\S]*?)\n---/);
    expect(fmMatch).not.toBeNull();
    expect(fmMatch![1]).toContain("slot: null");
  });

  test("non-empty string value passes through verbatim (regression guard)", () => {
    // Harness condition: value is a real, non-empty, non-null string —
    // the only branch where the normalization rule must NOT fire.
    const f = tmpFile("passthrough.md", [
      "---",
      "id: task-1",
      "slot: null",
      "---",
      "",
      "# Title",
    ].join("\n"));

    updateFrontmatterField(f, "slot", "3");
    const result = readFileSync(f, "utf-8");
    expect(result).toContain("slot: 3");
    expect(result).not.toContain("slot: null");
  });

  test("addFrontmatterField inherits the same null/empty normalization", () => {
    const f = tmpFile("add-null.md", [
      "---",
      "id: task-1",
      "---",
      "",
      "# Title",
    ].join("\n"));

    addFrontmatterField(f, "slot", null);
    const result = readFileSync(f, "utf-8");
    expect(result).toContain("slot: null");
  });
});

describe("parseTaskFrontmatter field reads", () => {
  test("reads basic scalar value (proposal)", () => {
    const content = "---\nproposal: docs/proposals/foo.md\n---\n\n# Title";
    expect(parseTaskFrontmatter(content).proposal).toBe("docs/proposals/foo.md");
  });

  test("reads double-quoted proposal string", () => {
    const content = '---\nproposal: "docs/proposals/foo.md"\n---\n';
    expect(parseTaskFrontmatter(content).proposal).toBe("docs/proposals/foo.md");
  });

  test("reads single-quoted proposal string", () => {
    const content = "---\nproposal: 'docs/proposals/foo.md'\n---\n";
    expect(parseTaskFrontmatter(content).proposal).toBe("docs/proposals/foo.md");
  });

  test("returns undefined for missing optional field (proposal)", () => {
    const content = "---\nid: task-1\nstatus: ready\n---\n";
    expect(parseTaskFrontmatter(content).proposal).toBeUndefined();
  });

  test("returns {} when no frontmatter", () => {
    const content = "# Just a markdown file\n\nNo frontmatter here.";
    const fm = parseTaskFrontmatter(content);
    expect(fm.proposal).toBeUndefined();
    expect(fm.id).toBeUndefined();
  });

  test("bare null value for optional field → undefined", () => {
    const content = "---\nproposal: null\n---\n";
    expect(parseTaskFrontmatter(content).proposal).toBeUndefined();
  });

  test("quoted 'null' string for optional field → undefined", () => {
    const content = '---\nproposal: "null"\n---\n';
    expect(parseTaskFrontmatter(content).proposal).toBeUndefined();
  });

  test("empty frontmatter yields empty-ish object", () => {
    const content = "---\n\n---\n";
    const fm = parseTaskFrontmatter(content);
    expect(fm.proposal).toBeUndefined();
    expect(fm.id).toBeUndefined();
  });

  test("boolean uses_browser is typed as boolean", () => {
    const content = "---\nuses_browser: true\n---\n";
    expect(parseTaskFrontmatter(content).uses_browser).toBe(true);
  });

  test("numeric slot is coerced to string", () => {
    const content = "---\nslot: 2\n---\n";
    expect(parseTaskFrontmatter(content).slot).toBe("2");
  });

  test("reads only from frontmatter, not body", () => {
    const content = "---\nproject: real\n---\n\nproject: fake\n";
    expect(parseTaskFrontmatter(content).project).toBe("real");
  });

  test("reads orchestration_mode scalar", () => {
    const content = "---\nid: task-1\norchestration_mode: pilot\n---\n";
    expect(parseTaskFrontmatter(content).orchestration_mode).toBe("pilot");
  });

  test("returns undefined for missing orchestration_mode", () => {
    const content = "---\nid: task-1\nstatus: ready\n---\n";
    expect(parseTaskFrontmatter(content).orchestration_mode).toBeUndefined();
  });

  test("orchestration_mode round-trips through addFrontmatterField → parseTaskFrontmatter", () => {
    const f = tmpFile("orch-mode-roundtrip.md", [
      "---",
      "id: task-1",
      "status: deferred",
      "---",
      "",
      "# Body",
    ].join("\n"));
    addFrontmatterField(f, "orchestration_mode", "pilot");
    const content = readFileSync(f, "utf-8");
    expect(parseTaskFrontmatter(content).orchestration_mode).toBe("pilot");
  });

  test("body code-block shadowing: frontmatter status wins (task-485dcb6a)", () => {
    // Regression guard for the body-scope vulnerability closed by the original
    // regex → readFrontmatterField migration (task-485dcb6a / task-808ee2c7).
    // A naive /^status:\s*(.+)$/m would capture the code-block line "status: wrong".
    const content = [
      "---",
      "id: task-1",
      "status: ready",
      "priority: B",
      "---",
      "",
      "# Title",
      "",
      "Retrospective quote from a prior run:",
      "",
      "```",
      "status: wrong",
      "priority: X",
      "```",
      "",
      "Inline prose also mentions status: wrong here.",
    ].join("\n");

    const fm = parseTaskFrontmatter(content);
    expect(fm.status).toBe("ready");
    expect(fm.priority).toBe("B");
    // Document the shadowing that the YAML-scoped parse fixes:
    const allStatusMatches = [...content.matchAll(/^status:\s*(.+)$/gm)].map((m) => m[1]);
    expect(allStatusMatches).toContain("wrong");
  });

  test("dependencies.blocks is typed as string[] (not joined)", () => {
    const content = "---\ndependencies:\n  blocks: [a, b]\n---\n";
    expect(parseTaskFrontmatter(content).dependencies?.blocks).toEqual(["a", "b"]);
  });

  test("duplicate keys use last value (uniqueKeys: false)", () => {
    const content = "---\nproject: first\nproject: second\n---\n";
    expect(parseTaskFrontmatter(content).project).toBe("second");
  });

  test("does not throw on malformed YAML; returns line-fallback object", () => {
    const content = "---\n: : :\n  bad:\n    - [\n---\n";
    expect(() => parseTaskFrontmatter(content)).not.toThrow();
    expect(parseTaskFrontmatter(content).project).toBeUndefined();
  });

  test("malformed YAML: explicit status line still readable via frontmatter-scoped fallback (codex P2)", () => {
    // Regression guard: if some other field breaks YAML parse, transitionStatus
    // would otherwise fall back to "ready" and let guarded transitions through.
    // Fallback is still scoped to the frontmatter block — body lines are ignored.
    const content = [
      "---",
      "id: task-1",
      "status: done",
      "dependencies: [unclosed",
      "---",
      "",
      "# Title",
      "",
      "status: wrong",
    ].join("\n");

    const fm = parseTaskFrontmatter(content);
    expect(fm.status).toBe("done");
    expect(fm.id).toBe("task-1");
  });

  test("malformed YAML fallback strips surrounding quotes and treats literal null as missing", () => {
    const content = [
      "---",
      'title: "quoted"',
      "status: null",
      "dependencies: [unclosed",
      "---",
    ].join("\n");

    const fm = parseTaskFrontmatter(content);
    expect(fm.title).toBe("quoted");
    expect(fm.status).toBeUndefined();
  });

  test("leaf: false round-trips as boolean false (container marker)", () => {
    const content = [
      "---",
      "id: task-container",
      "title: parent",
      "status: ready",
      "leaf: false",
      "---",
    ].join("\n");
    expect(parseTaskFrontmatter(content).leaf).toBe(false);
  });

  test("leaf absent stays undefined (legacy tasks must not be filtered)", () => {
    const content = [
      "---",
      "id: task-leaf",
      "title: leaf",
      "status: ready",
      "---",
    ].join("\n");
    const fm = parseTaskFrontmatter(content);
    expect(fm.leaf).toBeUndefined();
    // Critical: the consumer guard is `=== false`, so undefined must not coerce.
    expect(fm.leaf === false).toBe(false);
  });

  test("leaf: true round-trips as boolean true (explicit non-container)", () => {
    const content = [
      "---",
      "id: task-explicit",
      "title: explicit leaf",
      "status: ready",
      "leaf: true",
      "---",
    ].join("\n");
    expect(parseTaskFrontmatter(content).leaf).toBe(true);
  });

  test("leaf: false survives malformed-YAML line fallback path", () => {
    // Trigger the fallback by leaving an unclosed array in dependencies.
    const content = [
      "---",
      "id: task-fb",
      "status: blocked",
      "leaf: false",
      "dependencies: [unclosed",
      "---",
    ].join("\n");
    const fm = parseTaskFrontmatter(content);
    expect(fm.leaf).toBe(false);
    expect(fm.id).toBe("task-fb");
  });

  test("orchestration_mode survives malformed-YAML line fallback path", () => {
    const content = [
      "---",
      "id: task-fb",
      "status: deferred",
      "orchestration_mode: pilot",
      "dependencies: [unclosed",
      "---",
    ].join("\n");
    const fm = parseTaskFrontmatter(content);
    expect(fm.orchestration_mode).toBe("pilot");
    expect(fm.id).toBe("task-fb");
  });
});

describe("appendToSection", () => {
  test("appends to existing section with content", () => {
    const f = tmpFile("append-existing.md", "---\ntitle: test\n---\n\n## Questions\n\n- Existing item\n");
    appendToSection(f, "Questions", "- New item");
    const result = readFileSync(f, "utf-8");
    expect(result).toContain("- Existing item\n- New item\n");
  });

  test("replaces None. placeholder", () => {
    const f = tmpFile("append-none.md", "---\ntitle: test\n---\n\n## Questions\n\nNone.\n");
    appendToSection(f, "Questions", "- Intervention required");
    const result = readFileSync(f, "utf-8");
    expect(result).toContain("- Intervention required");
    expect(result).not.toContain("None.");
  });

  test("creates missing section at end of file", () => {
    const f = tmpFile("append-missing.md", "---\ntitle: test\n---\n\n## Notes\n\nSome notes.\n");
    appendToSection(f, "Questions", "- New question");
    const result = readFileSync(f, "utf-8");
    expect(result).toContain("## Questions\n\n- New question\n");
  });

  test("does not duplicate identical line", () => {
    const f = tmpFile("append-dedup.md", "---\ntitle: test\n---\n\n## Questions\n\n- Already here\n");
    appendToSection(f, "Questions", "- Already here");
    const result = readFileSync(f, "utf-8");
    const count = result.split("- Already here").length - 1;
    expect(count).toBe(1);
  });

  test("works with different section names", () => {
    const f = tmpFile("append-other.md", "---\ntitle: test\n---\n\n## Notes\n\nExisting.\n");
    appendToSection(f, "Notes", "- Appended note");
    const result = readFileSync(f, "utf-8");
    expect(result).toContain("Existing.\n- Appended note\n");
  });
});

describe("transitionStatus", () => {
  test("allowed transition succeeds and updates status", () => {
    const f = tmpFile("transition-ok.md", "---\nid: task-1\nstatus: ready\n---\n\n# Title\n");
    const result = transitionStatus(f, ["ready", "deferred"], "in-progress");
    expect(result).toBe(true);
    const content = readFileSync(f, "utf-8");
    expect(content).toContain("status: in-progress");
    expect(content).not.toContain("status: ready");
  });

  test("allowed transition with single string expectedFrom", () => {
    const f = tmpFile("transition-single.md", "---\nid: task-1\nstatus: merged\n---\n\n# Title\n");
    const result = transitionStatus(f, "merged", "ready");
    expect(result).toBe(true);
    const content = readFileSync(f, "utf-8");
    expect(content).toContain("status: ready");
  });

  test("blocked transition returns false and leaves file unchanged", () => {
    const f = tmpFile("transition-blocked.md", "---\nid: task-1\nstatus: abandoned\n---\n\n# Title\n");
    const result = transitionStatus(f, ["ready", "deferred"], "in-progress");
    expect(result).toBe(false);
    const content = readFileSync(f, "utf-8");
    expect(content).toContain("status: abandoned");
    expect(content).not.toContain("status: in-progress");
  });

  test("file-not-found throws", () => {
    expect(() => transitionStatus(join(TMP_DIR, "nonexistent.md"), "ready", "in-progress")).toThrow("task file not found");
  });

  test("slotClear done on abandoned task does not overwrite status", () => {
    const f = tmpFile("transition-terminal.md", "---\nid: task-1\nstatus: abandoned\ncompleted: 2026-04-10T10:00Z\n---\n\n# Title\n");
    const result = transitionStatus(f, ["in-progress", "preempted"], "done");
    expect(result).toBe(false);
    const content = readFileSync(f, "utf-8");
    expect(content).toContain("status: abandoned");
    expect(content).not.toContain("status: done");
  });
});

describe("frontmatterBounds", () => {
  test("returns bounds for valid frontmatter", () => {
    const lines = ["---", "id: task-1", "status: ready", "---", "", "# Title"];
    expect(frontmatterBounds(lines)).toEqual({ openLine: 0, closeLine: 3 });
  });

  test("returns null when first line is not ---", () => {
    const lines = ["# Title", "---", "id: task-1", "---"];
    expect(frontmatterBounds(lines)).toBeNull();
  });

  test("returns null for empty array", () => {
    expect(frontmatterBounds([])).toBeNull();
  });

  test("returns null when no closing delimiter", () => {
    const lines = ["---", "id: task-1", "status: ready"];
    expect(frontmatterBounds(lines)).toBeNull();
  });

  test("ignores body --- lines", () => {
    const lines = ["---", "id: task-1", "---", "", "---", "body"];
    const bounds = frontmatterBounds(lines);
    expect(bounds).toEqual({ openLine: 0, closeLine: 2 });
  });
});

describe("removeFrontmatterField", () => {
  test("removes a simple field", () => {
    const f = tmpFile("remove-simple.md", "---\nid: task-1\nslot: 3\nstatus: ready\n---\n\n# Title\n");
    removeFrontmatterField(f, "slot");
    const result = readFileSync(f, "utf-8");
    expect(result).not.toContain("slot:");
    expect(result).toContain("id: task-1");
    expect(result).toContain("status: ready");
  });

  test("removes field with indented continuation lines", () => {
    const f = tmpFile("remove-block.md", "---\nid: task-1\ndependencies:\n  blocks: []\n  blocked_by: []\nstatus: ready\n---\n\n# Title\n");
    removeFrontmatterField(f, "dependencies");
    const result = readFileSync(f, "utf-8");
    expect(result).not.toContain("dependencies:");
    expect(result).not.toContain("blocks:");
    expect(result).toContain("status: ready");
  });

  test("no-op on file without frontmatter", () => {
    const f = tmpFile("remove-nofm.md", "# Just a title\n\nSome body.\n");
    removeFrontmatterField(f, "id");
    const result = readFileSync(f, "utf-8");
    expect(result).toBe("# Just a title\n\nSome body.\n");
  });

  test("does not remove body lines matching field name", () => {
    const f = tmpFile("remove-body.md", "---\nid: task-1\n---\n\nslot: 5\n");
    removeFrontmatterField(f, "slot");
    const result = readFileSync(f, "utf-8");
    expect(result).toContain("slot: 5");
  });
});

describe("updateDependencyArray", () => {
  test("updates existing subfield", () => {
    const f = tmpFile("dep-update.md", "---\nid: task-1\ndependencies:\n  blocks: []\n  blocked_by: [a]\n---\n\n# Title\n");
    updateDependencyArray(f, "blocked_by", ["a", "b"]);
    const result = readFileSync(f, "utf-8");
    expect(result).toContain("blocked_by: [a, b]");
  });

  test("inserts missing subfield", () => {
    const f = tmpFile("dep-insert.md", "---\nid: task-1\ndependencies:\n  blocks: []\n---\n\n# Title\n");
    updateDependencyArray(f, "relates_to", ["x"]);
    const result = readFileSync(f, "utf-8");
    expect(result).toContain("relates_to: [x]");
    const fmMatch = result.match(/^---\n([\s\S]*?)\n---/);
    expect(fmMatch![1]).toContain("relates_to: [x]");
  });

  test("does not touch body content", () => {
    const f = tmpFile("dep-body.md", "---\nid: task-1\ndependencies:\n  blocks: []\n---\n\ndependencies: none\n");
    updateDependencyArray(f, "blocks", ["z"]);
    const result = readFileSync(f, "utf-8");
    expect(result).toContain("dependencies: none");
    const fmMatch = result.match(/^---\n([\s\S]*?)\n---/);
    expect(fmMatch![1]).toContain("blocks: [z]");
  });
});

describe("setDependencyScalar (gh-ludics-605)", () => {
  test("replaces an existing nested scalar in place", () => {
    const f = tmpFile("dep-scalar-update.md", "---\nid: task-1\ndependencies:\n  blocks: []\n  subtask_of: null\n---\n\n# Title\n");
    setDependencyScalar(f, "subtask_of", "task-parent");
    const fm = parseTaskFrontmatter(readFileSync(f, "utf-8"));
    expect(fm.dependencies?.subtask_of).toBe("task-parent");
  });

  test("inserts a missing nested scalar after the dependency block", () => {
    const f = tmpFile("dep-scalar-insert.md", "---\nid: task-1\ndependencies:\n  blocks: []\n---\n\n# Title\n");
    setDependencyScalar(f, "subtask_of", "task-parent");
    const result = readFileSync(f, "utf-8");
    const fmMatch = result.match(/^---\n([\s\S]*?)\n---/);
    expect(fmMatch![1]).toContain("subtask_of: task-parent");
    expect(parseTaskFrontmatter(result).dependencies?.subtask_of).toBe("task-parent");
  });

  test("null clears the link (renders canonical YAML null)", () => {
    const f = tmpFile("dep-scalar-clear.md", "---\nid: task-1\ndependencies:\n  blocks: []\n  subtask_of: task-parent\n---\n\n# Title\n");
    setDependencyScalar(f, "subtask_of", null);
    const result = readFileSync(f, "utf-8");
    expect(result).toContain("subtask_of: null");
    expect(parseTaskFrontmatter(result).dependencies?.subtask_of).toBeNull();
  });

  test("does not touch body content matching the subfield name", () => {
    const f = tmpFile("dep-scalar-body.md", "---\nid: task-1\ndependencies:\n  blocks: []\n---\n\nsubtask_of: prose\n");
    setDependencyScalar(f, "subtask_of", "task-parent");
    const result = readFileSync(f, "utf-8");
    expect(result).toContain("subtask_of: prose"); // body untouched
    expect(parseTaskFrontmatter(result).dependencies?.subtask_of).toBe("task-parent");
  });
});

describe("parseTaskFrontmatter skip_plan", () => {
  test("parses skip_plan: true as boolean true", () => {
    const content = "---\nid: task-1\ntitle: Test\neffort: medium\nskip_plan: true\n---\n";
    const fm = parseTaskFrontmatter(content);
    expect(fm.skip_plan).toBe(true);
  });

  test("absent skip_plan defaults to false", () => {
    const content = "---\nid: task-1\ntitle: Test\neffort: medium\n---\n";
    const fm = parseTaskFrontmatter(content);
    expect(fm.skip_plan).toBe(false);
  });

  test("parses skip_plan string 'true' as boolean true", () => {
    const content = '---\nid: task-1\ntitle: Test\nskip_plan: "true"\n---\n';
    const fm = parseTaskFrontmatter(content);
    expect(fm.skip_plan).toBe(true);
  });
});

describe("parseTaskFrontmatter non-throwing semantics", () => {
  test("returns empty object when no frontmatter delimiters present", () => {
    const content = "# Just a title\n\nBody.\n";
    const fm = parseTaskFrontmatter(content);
    expect(fm.id).toBeUndefined();
    expect(fm.status).toBeUndefined();
  });

  test("returns {} without throwing on malformed YAML with unrecognized structure", () => {
    const content = "---\n: : :\n  bad:\n    - [\n---\n";
    expect(() => parseTaskFrontmatter(content)).not.toThrow();
    const fm = parseTaskFrontmatter(content);
    // fallback populates nothing because no parseable field: value lines
    expect(fm.status).toBeUndefined();
  });

  test("malformed YAML: line-regex fallback populates recognizable fields", () => {
    const content = [
      "---",
      "id: task-1",
      "status: done",
      "dependencies: [unclosed",
      "---",
    ].join("\n");
    const fm = parseTaskFrontmatter(content);
    expect(fm.id).toBe("task-1");
    expect(fm.status).toBe("done");
  });

  test("malformed YAML fallback strips quotes and treats literal null as missing", () => {
    const content = [
      "---",
      'title: "quoted"',
      "status: null",
      "dependencies: [unclosed",
      "---",
    ].join("\n");
    const fm = parseTaskFrontmatter(content);
    expect(fm.title).toBe("quoted");
    expect(fm.status).toBeUndefined();
  });

  test("populates proposal and deferred_launch fields", () => {
    const content = [
      "---",
      "id: task-1",
      "title: Test",
      "proposal: docs/proposals/foo.md",
      "deferred_launch: true",
      "---",
    ].join("\n");
    const fm = parseTaskFrontmatter(content);
    expect(fm.proposal).toBe("docs/proposals/foo.md");
    expect(fm.deferred_launch).toBe("true");
  });
});

describe("parseTaskFrontmatter cache", () => {
  test("returns the same frozen reference for identical content strings", () => {
    _resetParseTaskFrontmatterCache();
    const content = "---\nid: task-1\ntitle: Test\n---\n";
    const first = parseTaskFrontmatter(content);
    const second = parseTaskFrontmatter(content);
    expect(first).toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
  });

  test("mutation of returned object is prevented by freeze", () => {
    _resetParseTaskFrontmatterCache();
    const content = "---\nid: task-1\ntitle: First\n---\n";
    const fm = parseTaskFrontmatter(content);
    // strict-mode frozen: direct assignment throws; sloppy: silently ignored.
    // Either way, subsequent read must still see "First".
    expect(() => {
      (fm as { title?: string }).title = "Mutated";
    }).toThrow();
    const again = parseTaskFrontmatter(content);
    expect(again.title).toBe("First");
  });

  test("nested arrays in cached entry cannot be mutated (dependencies.blocks)", () => {
    _resetParseTaskFrontmatterCache();
    const content = [
      "---",
      "id: task-1",
      "title: Test",
      "dependencies:",
      "  blocks: [a]",
      "  blocked_by: []",
      "  relates_to: []",
      "  subtask_of: null",
      "---",
    ].join("\n");
    const first = parseTaskFrontmatter(content);
    expect(first.dependencies?.blocks).toEqual(["a"]);
    // A mutation attempt must not silently succeed: either throw (strict mode
    // frozen array) or leave the array unchanged (sloppy mode), but never land
    // as a cached side effect on the next read.
    try {
      (first.dependencies!.blocks as string[]).push("b");
    } catch { /* frozen-array throw is fine */ }
    const second = parseTaskFrontmatter(content);
    expect(second.dependencies?.blocks).toEqual(["a"]);
    expect(second).toBe(first);
  });

  test("nested arrays in cached entry cannot be mutated (merged_from, t3code_threads)", () => {
    _resetParseTaskFrontmatterCache();
    const content = [
      "---",
      "id: task-1",
      "title: Test",
      "merged_from: [task-x]",
      "t3code_threads: [thread-1]",
      "---",
    ].join("\n");
    const first = parseTaskFrontmatter(content);
    try { (first.merged_from as string[]).push("task-y"); } catch { /* frozen */ }
    try { (first.t3code_threads as string[]).push("thread-2"); } catch { /* frozen */ }
    const second = parseTaskFrontmatter(content);
    expect(second.merged_from).toEqual(["task-x"]);
    expect(second.t3code_threads).toEqual(["thread-1"]);
  });

  test("LRU eviction kicks in past 512 entries — 513th distinct insert evicts the oldest", () => {
    _resetParseTaskFrontmatterCache();
    const first = "---\nid: task-first\ntitle: First\n---\n";
    const beforeEviction = parseTaskFrontmatter(first);

    // Confirm a repeat read with the same content string is a cache hit while
    // the entry is still live — same reference proves the cache is serving it.
    expect(parseTaskFrontmatter(first)).toBe(beforeEviction);

    // Fill the cache with 511 more distinct entries → cache is now exactly at
    // PARSE_CACHE_MAX=512 (first + 511 pads). Re-reading `first` must still
    // hit the cache and return the same reference.
    for (let i = 0; i < 511; i++) {
      parseTaskFrontmatter(`---\nid: task-pad-${i}\ntitle: Pad ${i}\n---\n`);
    }
    expect(_parseTaskFrontmatterCacheSize()).toBe(512);
    expect(parseTaskFrontmatter(first)).toBe(beforeEviction);

    // The 513th distinct insert must evict the oldest entry (`first`). After
    // that, re-reading `first` must be a cache miss and produce a fresh
    // object with identity different from `beforeEviction`.
    parseTaskFrontmatter(`---\nid: task-trigger\ntitle: Trigger\n---\n`);
    expect(_parseTaskFrontmatterCacheSize()).toBe(512);
    const afterEviction = parseTaskFrontmatter(first);
    expect(afterEviction).not.toBe(beforeEviction);
    expect(afterEviction.id).toBe("task-first");
  });
});

describe("parseTaskFrontmatter effort: tiny", () => {
  test("parses effort: tiny as the string 'tiny'", () => {
    const content = "---\nid: task-1\ntitle: Test\neffort: tiny\n---\n";
    const fm = parseTaskFrontmatter(content);
    expect(fm.effort).toBe("tiny");
  });

  test("round-trips effort: tiny via parseTaskFrontmatter", () => {
    const content = "---\nid: task-1\ntitle: Test\neffort: tiny\n---\n\nbody\n";
    expect(parseTaskFrontmatter(content).effort).toBe("tiny");
  });

  test("updateFrontmatterField preserves effort: tiny on write", () => {
    const tmpFile = `/tmp/ludics-tiny-roundtrip-${Date.now()}.md`;
    const content = "---\nid: task-1\ntitle: Test\neffort: tiny\n---\n\nbody\n";
    writeFileSync(tmpFile, content);
    // Update an unrelated field; verify effort stays "tiny"
    updateFrontmatterField(tmpFile, "priority", "A");
    const after = readFileSync(tmpFile, "utf-8");
    expect(parseTaskFrontmatter(after).effort).toBe("tiny");
    unlinkSync(tmpFile);
  });
});

describe("atomic write — no .tmp leftovers", () => {
  const sample = `---
id: task-sample
title: "Sample"
status: ready
priority: B
dependencies:
  blocks: []
  blocked_by: []
  relates_to: []
  subtask_of: null
---

# Sample

## Context

Body.

## Notes

None.
`;

  test("updateFrontmatterField leaves no .tmp sibling and is byte-identical to direct write", () => {
    const p = tmpFile("up.md", sample);
    updateFrontmatterField(p, "status", "in-progress");
    expect(existsSync(p + ".tmp")).toBe(false);
    const content = readFileSync(p, "utf-8");
    expect(content).toContain("status: in-progress");
  });

  test("appendToSection leaves no .tmp sibling", () => {
    const p = tmpFile("app.md", sample);
    appendToSection(p, "Notes", "- new note");
    expect(existsSync(p + ".tmp")).toBe(false);
    expect(readFileSync(p, "utf-8")).toContain("- new note");
  });

  test("removeFrontmatterField leaves no .tmp sibling", () => {
    const p = tmpFile("rm.md", sample);
    updateFrontmatterField(p, "slot", "3");
    removeFrontmatterField(p, "slot");
    expect(existsSync(p + ".tmp")).toBe(false);
    expect(readFileSync(p, "utf-8")).not.toContain("slot: 3");
  });

  test("updateDependencyArray leaves no .tmp sibling", () => {
    const p = tmpFile("deps.md", sample);
    updateDependencyArray(p, "blocks", ["task-other"]);
    expect(existsSync(p + ".tmp")).toBe(false);
    expect(readFileSync(p, "utf-8")).toContain("blocks: [task-other]");
  });

  test("writeTaskFile leaves no .tmp sibling", () => {
    mkdirSync(TMP_DIR, { recursive: true });
    const created = writeTaskFile(
      TMP_DIR,
      "task-newfile",
      "New File Task",
      "manual",
      false,
      "",
      "",
      "",
      "2026-04-24",
    );
    expect(created).toBe(true);
    const p = join(TMP_DIR, "task-newfile.md");
    expect(existsSync(p)).toBe(true);
    expect(existsSync(p + ".tmp")).toBe(false);
  });
});

describe("VALID_STATUSES centralised constant", () => {
  test("VALID_STATUSES enumerates the full status set including stale", () => {
    // Harness condition: VALID_STATUSES is the contract for the CLI status
    // setter and the central source of truth for status names. If `stale`
    // is missing, the new `tasks status <id> stale` subcommand would reject
    // a valid input.
    const set = new Set(VALID_STATUSES);
    expect(set.has("ready")).toBe(true);
    expect(set.has("in-progress")).toBe(true);
    expect(set.has("deferred")).toBe(true);
    expect(set.has("preempted")).toBe(true);
    expect(set.has("preempt-queued")).toBe(true);
    expect(set.has("done")).toBe(true);
    expect(set.has("abandoned")).toBe(true);
    expect(set.has("merged")).toBe(true);
    expect(set.has("needs-confirmation")).toBe(true);
    expect(set.has("blocked")).toBe(true);
    expect(set.has("stale")).toBe(true);
  });

  test("TERMINAL_STATUSES includes stale alongside done/abandoned/merged", () => {
    // Harness condition: TERMINAL_STATUSES is consumed by the skip-list
    // refactor sites in mag.ts / sync.ts / index.ts. Removing `stale` from
    // this constant would silently re-allow stale tasks to be unstuck,
    // duplicated, or surfaced in milestone warnings.
    expect(TERMINAL_STATUSES).toContain("done");
    expect(TERMINAL_STATUSES).toContain("abandoned");
    expect(TERMINAL_STATUSES).toContain("merged");
    expect(TERMINAL_STATUSES).toContain("stale");
    // Negative control: ready and in-progress are NOT terminal.
    expect(TERMINAL_STATUSES).not.toContain("ready");
    expect(TERMINAL_STATUSES).not.toContain("in-progress");
  });

  test("READY_QUEUE_ELIGIBLE_STATUSES is exactly { ready }", () => {
    expect(READY_QUEUE_ELIGIBLE_STATUSES).toEqual(["ready"]);
  });

  test("BLOCKED_RECONCILE_SKIP_STATUSES is the union of TERMINAL_STATUSES and the active states", () => {
    // Harness condition: BLOCKED_RECONCILE_SKIP_STATUSES drives
    // tasksReconcileBlockedStatus's skip predicate. Stale tasks must be in
    // the skip list so the reconciler doesn't flip them between ready and
    // blocked.
    const set = new Set(BLOCKED_RECONCILE_SKIP_STATUSES);
    for (const t of TERMINAL_STATUSES) expect(set.has(t)).toBe(true);
    expect(set.has("in-progress")).toBe(true);
    expect(set.has("deferred")).toBe(true);
    expect(set.has("preempt-queued")).toBe(true);
    expect(set.has("preempted")).toBe(true);
    expect(set.has("stale")).toBe(true);
    // Negative control: `ready` and `blocked` are not in the skip list
    // (those are the two endpoints of the reconciler's flip).
    expect(set.has("ready")).toBe(false);
    expect(set.has("blocked")).toBe(false);
  });

  test("transitionStatus accepts stale as a target", () => {
    // Harness condition: orchestrator's stale routing path calls
    // transitionStatus(taskFile, "ready", "stale"). If the helper rejected
    // unknown targets (it does not — free-form), this test falsifies that
    // change.
    const f = tmpFile("transition-stale.md", [
      "---",
      "id: task-1",
      "status: ready",
      "---",
      "",
      "# Title",
    ].join("\n"));
    const ok = transitionStatus(f, "ready", "stale");
    expect(ok).toBe(true);
    expect(readFileSync(f, "utf-8")).toContain("status: stale");
  });
});
