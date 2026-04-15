import { describe, test, expect, afterEach } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { addFrontmatterField, appendToSection, frontmatterBounds, readFrontmatterField, removeFrontmatterField, updateDependencyArray, updateFrontmatterField, transitionStatus } from "./markdown.ts";

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

  test("round-trip: inserted field is readable by readFrontmatterField", () => {
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
    expect(readFrontmatterField(content, "completed")).toBe("2026-04-13T18:00Z");
    // Existing fields preserved
    expect(readFrontmatterField(content, "id")).toBe("task-1");
    expect(readFrontmatterField(content, "status")).toBe("ready");
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

describe("readFrontmatterField", () => {
  test("reads basic scalar value", () => {
    const content = "---\nproposal: docs/proposals/foo.md\n---\n\n# Title";
    expect(readFrontmatterField(content, "proposal")).toBe("docs/proposals/foo.md");
  });

  test("reads double-quoted string", () => {
    const content = '---\nproposal: "docs/proposals/foo.md"\n---\n';
    expect(readFrontmatterField(content, "proposal")).toBe("docs/proposals/foo.md");
  });

  test("reads single-quoted string", () => {
    const content = "---\nproposal: 'docs/proposals/foo.md'\n---\n";
    expect(readFrontmatterField(content, "proposal")).toBe("docs/proposals/foo.md");
  });

  test("returns null for missing field", () => {
    const content = "---\nid: task-1\nstatus: ready\n---\n";
    expect(readFrontmatterField(content, "proposal")).toBeNull();
  });

  test("returns null when no frontmatter", () => {
    const content = "# Just a markdown file\n\nNo frontmatter here.";
    expect(readFrontmatterField(content, "proposal")).toBeNull();
  });

  test("returns null for bare null value", () => {
    const content = "---\nproposal: null\n---\n";
    expect(readFrontmatterField(content, "proposal")).toBeNull();
  });

  test("returns null for quoted 'null' string (backward compat)", () => {
    const content = '---\nproposal: "null"\n---\n';
    expect(readFrontmatterField(content, "proposal")).toBeNull();
  });

  test("returns null for empty frontmatter", () => {
    const content = "---\n\n---\n";
    expect(readFrontmatterField(content, "proposal")).toBeNull();
  });

  test("coerces boolean to string", () => {
    const content = "---\nuses_browser: true\n---\n";
    expect(readFrontmatterField(content, "uses_browser")).toBe("true");
  });

  test("coerces number to string", () => {
    const content = "---\nslot: 2\n---\n";
    expect(readFrontmatterField(content, "slot")).toBe("2");
  });

  test("reads only from frontmatter, not body", () => {
    const content = "---\nproject: real\n---\n\nproject: fake\n";
    expect(readFrontmatterField(content, "project")).toBe("real");
  });

  test("stringifies array values", () => {
    const content = "---\nblocks: [a, b]\n---\n";
    expect(readFrontmatterField(content, "blocks")).toBe("a,b");
  });

  test("duplicate keys use last value (uniqueKeys: false)", () => {
    const content = "---\nproject: first\nproject: second\n---\n";
    expect(readFrontmatterField(content, "project")).toBe("second");
  });

  test("returns null without throwing on malformed YAML", () => {
    const content = "---\n: : :\n  bad:\n    - [\n---\n";
    expect(() => readFrontmatterField(content, "project")).not.toThrow();
    expect(readFrontmatterField(content, "project")).toBeNull();
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
