import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readJsonFile } from "./json.ts";

describe("readJsonFile", () => {
  function withTmpFile(content: string): string {
    const dir = mkdtempSync(join(tmpdir(), "json-test-"));
    const file = join(dir, "test.json");
    writeFileSync(file, content);
    return file;
  }

  test("returns parsed object for valid JSON object", () => {
    const file = withTmpFile('{"key": "value", "num": 42}');
    const result = readJsonFile<{ key: string; num: number }>(file);
    expect(result).toEqual({ key: "value", num: 42 });
    rmSync(file, { force: true });
  });

  test("returns null for JSON string", () => {
    const file = withTmpFile('"hello"');
    expect(readJsonFile(file)).toBeNull();
    rmSync(file, { force: true });
  });

  test("returns null for JSON array", () => {
    const file = withTmpFile("[1, 2, 3]");
    expect(readJsonFile(file)).toBeNull();
    rmSync(file, { force: true });
  });

  test("returns null for JSON null", () => {
    const file = withTmpFile("null");
    expect(readJsonFile(file)).toBeNull();
    rmSync(file, { force: true });
  });

  test("returns null for JSON number", () => {
    const file = withTmpFile("42");
    expect(readJsonFile(file)).toBeNull();
    rmSync(file, { force: true });
  });

  test("returns null for non-existent file", () => {
    expect(readJsonFile("/tmp/does-not-exist-json-test.json")).toBeNull();
  });

  test("returns null for malformed JSON", () => {
    const file = withTmpFile("{bad json");
    expect(readJsonFile(file)).toBeNull();
    rmSync(file, { force: true });
  });
});
