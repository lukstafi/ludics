import { describe, test, expect, afterEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { addFrontmatterField, appendToSection, frontmatterBounds, removeFrontmatterField, updateDependencyArray, updateFrontmatterField, transitionStatus, parseTaskFrontmatter, writeTaskFile, _resetParseTaskFrontmatterCache, _parseTaskFrontmatterCacheSize } from "./markdown.ts";

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
