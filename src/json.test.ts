import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { atomicWriteFileSync, readJsonFile, writeJsonFile, writeJsonFileCompact } from "./json.ts";

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

describe("atomicWriteFileSync", () => {
  test("writes content to the target path", () => {
    const dir = mkdtempSync(join(tmpdir(), "atomic-write-"));
    const file = join(dir, "out.txt");
    atomicWriteFileSync(file, "hello world\n");
    expect(readFileSync(file, "utf-8")).toBe("hello world\n");
    rmSync(dir, { recursive: true, force: true });
  });

  test("leaves no .tmp sibling after a successful write", () => {
    const dir = mkdtempSync(join(tmpdir(), "atomic-write-"));
    const file = join(dir, "out.txt");
    atomicWriteFileSync(file, "payload");
    expect(existsSync(file)).toBe(true);
    expect(existsSync(`${file}.tmp`)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("auto-creates a missing parent directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "atomic-write-"));
    const file = join(dir, "nested", "deeper", "out.txt");
    atomicWriteFileSync(file, "deep");
    expect(readFileSync(file, "utf-8")).toBe("deep");
    rmSync(dir, { recursive: true, force: true });
  });

  test("overwrites an existing target", () => {
    const dir = mkdtempSync(join(tmpdir(), "atomic-write-"));
    const file = join(dir, "out.txt");
    atomicWriteFileSync(file, "first");
    atomicWriteFileSync(file, "second");
    expect(readFileSync(file, "utf-8")).toBe("second");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("writeJsonFile", () => {
  test("produces JSON.stringify(x, null, 2) + trailing newline", () => {
    const dir = mkdtempSync(join(tmpdir(), "write-json-"));
    const file = join(dir, "out.json");
    const value = { a: 1, b: "two" };
    writeJsonFile(file, value);
    expect(readFileSync(file, "utf-8")).toBe(JSON.stringify(value, null, 2) + "\n");
    expect(existsSync(`${file}.tmp`)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("round-trips through readJsonFile", () => {
    const dir = mkdtempSync(join(tmpdir(), "write-json-"));
    const file = join(dir, "out.json");
    const value = { key: "value", num: 42 };
    writeJsonFile(file, value);
    expect(readJsonFile<typeof value>(file)).toEqual(value);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("writeJsonFileCompact", () => {
  test("produces JSON.stringify(x) + trailing newline (no indentation)", () => {
    const dir = mkdtempSync(join(tmpdir(), "write-json-compact-"));
    const file = join(dir, "out.json");
    const value = { a: 1, b: "two" };
    writeJsonFileCompact(file, value);
    expect(readFileSync(file, "utf-8")).toBe(JSON.stringify(value) + "\n");
    expect(existsSync(`${file}.tmp`)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("round-trips through readJsonFile", () => {
    const dir = mkdtempSync(join(tmpdir(), "write-json-compact-"));
    const file = join(dir, "out.json");
    const value = { key: "value", num: 42 };
    writeJsonFileCompact(file, value);
    expect(readJsonFile<typeof value>(file)).toEqual(value);
    rmSync(dir, { recursive: true, force: true });
  });

  test("auto-creates a missing parent directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "write-json-compact-"));
    const file = join(dir, "nested", "deeper", "out.json");
    const value = { deep: true };
    writeJsonFileCompact(file, value);
    expect(readFileSync(file, "utf-8")).toBe(JSON.stringify(value) + "\n");
    rmSync(dir, { recursive: true, force: true });
  });
});
