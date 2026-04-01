import { describe, test, expect, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { addFrontmatterField, updateFrontmatterField } from "./markdown.ts";

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
      "# Body",
    ].join("\n"));

    addFrontmatterField(f, "priority", "A");
    const result = readFileSync(f, "utf-8");

    expect(result).toContain("\npriority: A\n---");
  });

  test("updates existing frontmatter field", () => {
    const f = tmpFile("update.md", [
      "---",
      "id: task-1",
      "priority: B",
      "---",
      "",
      "# Body",
    ].join("\n"));

    addFrontmatterField(f, "priority", "A");
    const result = readFileSync(f, "utf-8");

    expect(result).toContain("priority: A");
    expect(result).not.toContain("priority: B");
    // Should not duplicate
    expect(result.match(/priority:/g)?.length).toBe(1);
  });

  test("inserts field even when body contains matching pattern (regression)", () => {
    const f = tmpFile("regression.md", [
      "---",
      "id: task-1",
      "status: ready",
      "---",
      "",
      "# Body",
      "",
      "priority: high",
    ].join("\n"));

    addFrontmatterField(f, "priority", "A");
    const result = readFileSync(f, "utf-8");

    // The frontmatter must now contain priority: A
    const fmMatch = result.match(/^---\n([\s\S]*?)\n---/);
    expect(fmMatch).not.toBeNull();
    expect(fmMatch![1]).toContain("priority: A");

    // Body line should remain unchanged
    expect(result).toContain("\npriority: high");
  });

  test("does not insert if field exists in frontmatter even when body also has it", () => {
    const f = tmpFile("both.md", [
      "---",
      "id: task-1",
      "priority: B",
      "---",
      "",
      "# Body",
      "",
      "priority: high",
    ].join("\n"));

    addFrontmatterField(f, "priority", "A");
    const result = readFileSync(f, "utf-8");

    const fmMatch = result.match(/^---\n([\s\S]*?)\n---/);
    expect(fmMatch).not.toBeNull();
    expect(fmMatch![1]).toContain("priority: A");
    expect(fmMatch![1]).not.toContain("priority: B");

    // Body unchanged
    expect(result).toContain("\npriority: high");
  });
});
