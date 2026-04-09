import { describe, test, expect, afterEach } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { addFrontmatterField, readFrontmatterField } from "./markdown.ts";

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

  test("returns null for null value", () => {
    const content = "---\nproposal: null\n---\n";
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
